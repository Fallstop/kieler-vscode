/*
 * SCCharts Lab: everything the language server needs from the machine it runs on.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { settingsKey } from '../constants'
import {
    CCompiler,
    findCCompiler,
    installHint,
    serverEnvironment,
    W64DevkitInstaller,
    W64DevkitManifest,
    whichProgram,
} from './c-toolchain'
import {
    explainMissingJava,
    findJava,
    hasJavaCompiler,
    JavaLookupResult,
    JavaRuntime,
    REQUIRED_JAVA,
} from './java-runtime'

export const JAVA_HOME_SETTING = 'javaHome'
export const C_COMPILER_SETTING = 'cCompilerPath'
export const DOWNLOAD_C_TOOLCHAIN = 'keith-vscode.runtime.downloadCToolchain'
export const REMOVE_C_TOOLCHAIN = 'keith-vscode.runtime.removeCToolchain'
export const SHOW_RUNTIME_INFO = 'keith-vscode.runtime.showInfo'
const DECLINED_DOWNLOAD_KEY = 'runtime.cToolchain.declined'
const JAVA_DOWNLOAD_URL = `https://adoptium.net/temurin/releases/?version=${REQUIRED_JAVA}`

const SERVER_JAR = 'server/sccharts-lite-server.jar'
const SERVER_MAIN = 'de.cau.cs.kieler.language.server.LanguageServer'

export type BuildLanguage = 'c' | 'java'

/** Compilation systems name their target language in the id (`...netlist.java`) or the label. */
export function buildLanguageOf(systemId: string, label?: string): BuildLanguage {
    return /(^|\.)java(\.|$)/i.test(systemId) || /\bjava\b/i.test(label ?? '') ? 'java' : 'c'
}

/**
 * Owns the Java runtime and the C toolchain: picks them, launches the server with them, and talks to
 * the user when one is missing.
 */
export class RuntimeManager implements vscode.Disposable {
    readonly output: vscode.OutputChannel

    private java?: JavaRuntime

    private lastLookup?: JavaLookupResult

    private readonly installer?: W64DevkitInstaller

    /** Called after the toolchain changed so the running server picks it up. */
    restartServer?: () => Promise<void>

    constructor(private readonly context: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel('SCCharts Lab')
        const manifest = this.readToolchainManifest()
        if (manifest && process.platform === 'win32') {
            this.installer = new W64DevkitInstaller(context.globalStorageUri.fsPath, manifest)
        }
        this.recordStorageForUninstall()
        context.subscriptions.push(
            this.output,
            vscode.commands.registerCommand(DOWNLOAD_C_TOOLCHAIN, () => this.downloadCToolchain()),
            vscode.commands.registerCommand(REMOVE_C_TOOLCHAIN, () => this.removeCToolchain()),
            vscode.commands.registerCommand(SHOW_RUNTIME_INFO, () => this.showInfo())
        )
    }

    dispose(): void {
        // Subscriptions are owned by the extension context.
    }

    private get settings(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(settingsKey)
    }

    /**
     * The uninstall hook (scripts/uninstall.cjs) runs without the VS Code API, so the global storage
     * path it must clean is written next to it on every activation.
     */
    private recordStorageForUninstall(): void {
        try {
            fs.writeFileSync(
                this.context.asAbsolutePath('uninstall.json'),
                `${JSON.stringify({ globalStorage: this.context.globalStorageUri.fsPath }, null, 2)}\n`
            )
        } catch {
            // Read-only installation: an uninstall then leaves the toolchain behind, as before.
        }
    }

    private readToolchainManifest(): W64DevkitManifest | undefined {
        try {
            const file = this.context.asAbsolutePath('server/runtime-manifest.json')
            return JSON.parse(fs.readFileSync(file, 'utf8')).w64devkit
        } catch {
            return undefined
        }
    }

    /** The Java runtime the server runs on, resolved once per activation and after every restart. */
    async resolveJava(): Promise<JavaRuntime | undefined> {
        const result = await findJava({
            extensionPath: this.context.extensionPath,
            javaHome: this.settings.get<string>(JAVA_HOME_SETTING),
        })
        for (const entry of result.rejected) {
            this.output.appendLine(`Java candidate rejected (${entry.source}): ${entry.command}: ${entry.problem}`)
        }
        this.java = result.runtime
        this.lastLookup = result
        if (result.runtime) {
            this.output.appendLine(
                `Using Java ${result.runtime.version} (${result.runtime.description}) from ${result.runtime.source}: ${result.runtime.command}`
            )
        }
        return result.runtime
    }

    get javaRuntime(): JavaRuntime | undefined {
        return this.java
    }

    /** Explains a failed Java lookup and offers the ways out. Never returns a client; activation ends here. */
    async reportMissingJava(result: JavaLookupResult | undefined = this.lastLookup): Promise<void> {
        const detail = result ? explainMissingJava(result) : ''
        if (detail) this.output.appendLine(detail)
        const tooOld = result?.rejected.find((entry) => /too old/.test(entry.problem))
        const found = tooOld
            ? ` The Java at ${tooOld.command} is too old (${tooOld.problem.replace(/ is too old.*$/, '')}).`
            : ''
        const download = `Download Java ${REQUIRED_JAVA}`
        const settings = 'Set javaHome'
        const log = 'Show log'
        const choice = await vscode.window.showErrorMessage(
            `SCCharts Lab needs Java ${REQUIRED_JAVA} or newer and found none.${found} Install a JDK or point the keith-vscode.javaHome setting at one, then reload the window. Platform builds of the extension from the Marketplace include their own runtime.`,
            download,
            settings,
            log
        )
        if (choice === download) vscode.env.openExternal(vscode.Uri.parse(JAVA_DOWNLOAD_URL))
        if (choice === settings)
            vscode.commands.executeCommand('workbench.action.openSettings', `${settingsKey}.${JAVA_HOME_SETTING}`)
        if (choice === log) this.output.show()
    }

    /** The C compiler as currently configured, if any. */
    cCompiler(): CCompiler | undefined {
        return findCCompiler({
            settingPath: this.settings.get<string>(C_COMPILER_SETTING),
            downloadedGcc: this.installer?.isInstalled() ? this.installer.gcc : undefined,
        })
    }

    /**
     * Spawns the language server with the resolved Java. The compiler path travels as a system property
     * (`HostTools` on the server reads it) and its directory is prepended to PATH for the compiled programs.
     */
    async launchServer(): Promise<ChildProcess> {
        // Resolved again on every start, so a changed javaHome setting takes effect on "Restart language server".
        const java = await this.resolveJava()
        if (!java) {
            throw new Error(`No Java ${REQUIRED_JAVA} runtime is available to start the SCCharts language server.`)
        }
        const args = ['-Djava.awt.headless=true']
        const pathEntries: string[] = []
        const compiler = this.cCompiler()
        if (compiler && compiler.source !== 'PATH') {
            args.push(`-Dsccharts.cc=${compiler.command}`)
            if (path.isAbsolute(compiler.command)) pathEntries.push(path.dirname(compiler.command))
        }
        if (java.home) {
            // The server spawns java/javac/jar itself for the Java simulation; make sure they are ours.
            pathEntries.push(path.join(java.home, 'bin'))
        }
        args.push('-cp', this.context.asAbsolutePath(SERVER_JAR), SERVER_MAIN)
        this.output.appendLine(
            `Starting language server: ${java.command} ${args.join(' ')}${
                compiler ? ` (C compiler: ${compiler.command}, ${compiler.source})` : ' (no C compiler found yet)'
            }`
        )
        return spawn(java.command, args, {
            env: serverEnvironment(process.env, pathEntries),
            cwd: this.context.extensionPath,
            windowsHide: true,
        })
    }

    /**
     * Makes sure the tools a simulation build needs exist before the compile request goes out. Returns
     * false when the build must not start (the user declined, or nothing could be found).
     */
    async prepareBuild(systemId: string, label?: string): Promise<boolean> {
        return buildLanguageOf(systemId, label) === 'java' ? this.ensureJavaCompiler() : this.ensureCCompiler()
    }

    private async ensureJavaCompiler(): Promise<boolean> {
        const { java } = this
        if (java && hasJavaCompiler(java)) return true
        if (whichProgram('javac')) return true
        const download = 'Download a JDK'
        const settings = 'Set javaHome'
        const choice = await vscode.window.showErrorMessage(
            `Java simulation compiles the generated code with javac, which the ${
                java?.source === 'bundled' ? 'bundled runtime' : 'selected Java runtime'
            } does not include. Install a JDK ${REQUIRED_JAVA} or newer and point keith-vscode.javaHome at it, or simulate with a C system instead.`,
            download,
            settings
        )
        if (choice === download) vscode.env.openExternal(vscode.Uri.parse(JAVA_DOWNLOAD_URL))
        if (choice === settings)
            vscode.commands.executeCommand('workbench.action.openSettings', `${settingsKey}.${JAVA_HOME_SETTING}`)
        return false
    }

    private async ensureCCompiler(): Promise<boolean> {
        if (this.cCompiler()) return true
        const configured = this.settings.get<string>(C_COMPILER_SETTING)?.trim()
        if (configured) {
            const open = 'Open setting'
            const choice = await vscode.window.showErrorMessage(
                `The configured C compiler was not found: ${configured}`,
                open
            )
            if (choice === open) {
                vscode.commands.executeCommand('workbench.action.openSettings', `${settingsKey}.${C_COMPILER_SETTING}`)
            }
            return false
        }
        if (this.installer) {
            return this.offerDownload()
        }
        const hint = installHint()
        const settings = 'Use my own compiler'
        const choice = await vscode.window.showErrorMessage(`C simulation needs a C compiler. ${hint}`, settings)
        if (choice === settings) {
            vscode.commands.executeCommand('workbench.action.openSettings', `${settingsKey}.${C_COMPILER_SETTING}`)
        }
        return false
    }

    private async offerDownload(): Promise<boolean> {
        const { installer } = this
        if (!installer) return false
        const size = (installer.manifest.size / 1e6).toFixed(0)
        const download = `Download (${size} MB)`
        const own = 'Use my own compiler'
        const declined = this.context.globalState.get<boolean>(DECLINED_DOWNLOAD_KEY)
        const choice = await vscode.window.showInformationMessage(
            `C simulation needs a C compiler and none was found. SCCharts Lab can download w64devkit ${
                installer.manifest.version
            }, a portable GCC, into its own storage folder.${
                declined
                    ? ' You declined this earlier; the offer stays available as the "Download C toolchain" command.'
                    : ''
            }`,
            { modal: false },
            download,
            own
        )
        if (choice === download) {
            return this.downloadCToolchain()
        }
        if (choice === own) {
            vscode.commands.executeCommand('workbench.action.openSettings', `${settingsKey}.${C_COMPILER_SETTING}`)
        }
        if (choice === undefined || choice === own) {
            await this.context.globalState.update(DECLINED_DOWNLOAD_KEY, true)
        }
        return false
    }

    /** Command: download w64devkit, then restart the server so it compiles with it. */
    async downloadCToolchain(): Promise<boolean> {
        const { installer } = this
        if (!installer) {
            vscode.window.showInformationMessage(
                process.platform === 'win32'
                    ? 'The toolchain manifest of this installation is missing; reinstall the extension.'
                    : `The downloadable C toolchain exists for Windows only. ${installHint()}`
            )
            return false
        }
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'SCCharts Lab C toolchain',
                    cancellable: true,
                },
                (progress, token) => installer.install(progress, token)
            )
        } catch (error) {
            this.output.appendLine(
                `w64devkit installation failed: ${error instanceof Error ? error.stack ?? error.message : error}`
            )
            vscode.window.showErrorMessage(
                `Downloading the C toolchain failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
        await this.context.globalState.update(DECLINED_DOWNLOAD_KEY, false)
        this.output.appendLine(`w64devkit ${installer.manifest.version} installed in ${installer.directory}`)
        if (this.restartServer) {
            await this.restartServer()
        }
        vscode.window.setStatusBarMessage('$(check) C toolchain ready', 5000)
        return true
    }

    /** Command: delete the downloaded toolchain. */
    async removeCToolchain(): Promise<void> {
        const { installer } = this
        if (!installer || !fs.existsSync(path.dirname(installer.directory))) {
            vscode.window.showInformationMessage('No downloaded C toolchain to remove.')
            return
        }
        installer.remove()
        this.output.appendLine('Removed the downloaded w64devkit toolchain')
        if (this.restartServer) await this.restartServer()
        vscode.window.showInformationMessage('The downloaded C toolchain was removed.')
    }

    /** Command: show which Java and C compiler are in use. */
    async showInfo(): Promise<void> {
        const java = this.java ?? (await this.resolveJava())
        const compiler = this.cCompiler()
        this.output.appendLine('--- Runtime ---')
        this.output.appendLine(
            java
                ? `Java: ${java.version} (${java.description}) from ${java.source} at ${java.command}${
                      hasJavaCompiler(java) ? ', includes javac' : ', no javac'
                  }`
                : `Java: none found (need ${REQUIRED_JAVA}+)`
        )
        this.output.appendLine(
            compiler
                ? `C compiler: ${compiler.command} (${compiler.source})`
                : `C compiler: none found. ${installHint()}`
        )
        if (this.installer) {
            this.output.appendLine(
                this.installer.isInstalled()
                    ? `w64devkit ${this.installer.manifest.version}: ${this.installer.directory}`
                    : 'w64devkit: not downloaded'
            )
        }
        this.output.show()
    }
}
