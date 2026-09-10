/*
 * SCCharts Lab
 *
 * Compilation systems defined by .kico files in the workspace. The server loads every .kico it finds in the
 * workspace folders (and in the folders named by the keith-vscode.compilationSystems.folders setting), registers
 * the systems next to the built-in ones and reports what changed; this side keeps the server informed about the
 * folders, tells the user about loaded and broken files, and groups the systems in the compile menu.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import type { LanguageClient } from 'vscode-languageclient/node'
import { settingsKey } from '../constants'
import { REQUEST_CS } from './commands'

export const systemFoldersMethod = 'keith/kicool/systemFolders'
export const systemsChangedMethod = 'keith/kicool/systemsChanged'
export const workspaceSystemsMethod = 'keith/kicool/workspaceSystems'
export const NEW_SYSTEM_COMMAND = 'keith-vscode.kico.newSystem'
export const FOLDERS_SETTING = 'compilationSystems.folders'

export interface WorkspaceSystemInfo {
    file: string
    id?: string
    label?: string
    loaded: boolean
    error?: string
}

export interface SystemsChangedParam {
    added: WorkspaceSystemInfo[]
    removed: WorkspaceSystemInfo[]
    errors: WorkspaceSystemInfo[]
}

/** The subset of a compilation system the compile menu needs; `source` is set for workspace systems. */
export interface ListedSystem {
    id: string
    label: string
    source?: string
}

/** A quick pick item that remembers which system it stands for, so a decorated label still resolves. */
export interface SystemQuickPickItem extends vscode.QuickPickItem {
    systemId?: string
}

/** A readable location for a workspace system's file: relative to a workspace folder when inside one. */
export function describeSource(
    source: string,
    folders: readonly { uri: vscode.Uri }[] = vscode.workspace.workspaceFolders ?? []
): string {
    const uri = vscode.Uri.parse(source)
    for (const folder of folders) {
        const relative = path.relative(folder.uri.fsPath, uri.fsPath)
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
            return relative.split(path.sep).join('/')
    }
    return uri.fsPath
}

/**
 * Builds the compile menu: workspace systems first under their own heading, each with the file it comes from,
 * then the built-in systems. Labels stay exactly the system labels; the id travels in `systemId`.
 */
export function groupSystemsForQuickPick(
    systems: ListedSystem[],
    folders: readonly { uri: vscode.Uri }[] = vscode.workspace.workspaceFolders ?? []
): SystemQuickPickItem[] {
    const workspace = systems.filter((system) => system.source)
    const builtIn = systems.filter((system) => !system.source)
    const items: SystemQuickPickItem[] = []
    if (workspace.length) {
        items.push({ label: 'Workspace', kind: vscode.QuickPickItemKind.Separator })
        workspace.forEach((system) =>
            items.push({
                label: system.label,
                description: `$(folder) ${describeSource(system.source!, folders)}`,
                detail: system.id,
                systemId: system.id,
            })
        )
        if (builtIn.length) items.push({ label: 'Built-in', kind: vscode.QuickPickItemKind.Separator })
    }
    builtIn.forEach((system) => items.push({ label: system.label, systemId: system.id }))
    return items
}

/** The system a selected quick pick item stands for. */
export function pickedSystem<T extends ListedSystem>(
    systems: T[],
    item: SystemQuickPickItem | undefined
): T | undefined {
    if (!item) return undefined
    return systems.find((system) => (item.systemId ? system.id === item.systemId : system.label === item.label))
}

/** The folders parameter for the server: the setting's entries plus the workspace folders as absolute paths. */
export function systemFoldersParam(
    folders: string[],
    workspaceFolders: readonly { uri: vscode.Uri }[] = vscode.workspace.workspaceFolders ?? []
): { folders: string[]; workspaceFolders: string[] } {
    return {
        folders: folders.filter((folder) => typeof folder === 'string' && folder.trim().length > 0),
        workspaceFolders: workspaceFolders.map((folder) => folder.uri.fsPath),
    }
}

/** One-line summaries for the user after a load, the way the notifications word them. */
export function changeMessages(
    change: SystemsChangedParam,
    folders?: readonly { uri: vscode.Uri }[]
): { info: string[]; errors: string[] } {
    const info: string[] = []
    const errors: string[] = []
    change.added.forEach((entry) =>
        info.push(
            `Loaded compilation system "${entry.label}" (${entry.id}) from ${describeSource(entry.file, folders)}`
        )
    )
    change.removed
        .filter((entry) => !change.added.some((added) => added.file === entry.file))
        .forEach((entry) =>
            info.push(
                `Removed compilation system "${entry.label}" (${entry.id}): ${describeSource(
                    entry.file,
                    folders
                )} is gone`
            )
        )
    change.errors.forEach((entry) =>
        errors.push(`${describeSource(entry.file, folders)}: ${entry.error ?? 'cannot load this compilation system'}`)
    )
    return { info, errors }
}

export const SYSTEM_TEMPLATE = (name: string): string =>
    [
        `// A compilation system for SCCharts Lab. Every .kico in the workspace is picked up automatically and`,
        `// appears in "Compile current model with..." as soon as this file is saved without errors.`,
        `//`,
        `// A system is a sequence of processors and included systems. Processor ids and system ids are the ones`,
        `// the built-in .kico files use; the language server underlines unknown ids. Common building blocks:`,
        `//   system de.cau.cs.kieler.sccharts.extended.core   expand extended SCCharts features to core SCCharts`,
        `//   system de.cau.cs.kieler.sccharts.netlist         core SCCharts -> SCG -> scheduled netlist -> C`,
        `//   de.cau.cs.kieler.sccharts.scg.processors.SCG      SCCharts to sequentially constructive graph`,
        `//   de.cau.cs.kieler.scg.processors.codegen.c         C code generation from a scheduled SCG`,
        `//   de.cau.cs.kieler.scg.processors.codegen.java      Java code generation`,
        `// Compile once with a built-in system and read the stage names in the compiler panel to find more.`,
        ``,
        `public system ${name}`,
        `    label "${name} (workspace)"`,
        ``,
        `    system de.cau.cs.kieler.sccharts.netlist`,
        ``,
    ].join('\n')

/** Keeps the server's view of the system folders current and relays what it loaded. */
export class WorkspaceSystems implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = []

    private readonly output = vscode.window.createOutputChannel('SCCharts compilation systems')

    constructor(
        private readonly lsClient: LanguageClient,
        private readonly requestSystems: () => Thenable<unknown> = () =>
            vscode.commands.executeCommand(REQUEST_CS.command)
    ) {
        this.subscriptions.push(
            this.output,
            lsClient.onNotification(systemsChangedMethod, (change: SystemsChangedParam) => this.onChanged(change)),
            lsClient.onDidChangeState((event) => {
                if (event.newState === 2 /* Running */)
                    this.sendFolders().catch((error) => this.output.appendLine(String(error)))
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`${settingsKey}.${FOLDERS_SETTING}`))
                    this.sendFolders().catch((error) => this.output.appendLine(String(error)))
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() =>
                this.sendFolders().catch((error) => this.output.appendLine(String(error)))
            ),
            vscode.commands.registerCommand(NEW_SYSTEM_COMMAND, () => this.newSystem())
        )
    }

    dispose(): void {
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }

    folders(): string[] {
        const configured = vscode.workspace.getConfiguration(settingsKey).get<string[]>(FOLDERS_SETTING)
        return Array.isArray(configured) ? configured : []
    }

    /** Tells the server which folders to scan; the server rescans and answers with systemsChanged. */
    async sendFolders(): Promise<void> {
        await this.lsClient.sendNotification(systemFoldersMethod, systemFoldersParam(this.folders()))
    }

    private onChanged(change: SystemsChangedParam): void {
        const { info, errors } = changeMessages(change)
        info.forEach((line) => this.output.appendLine(line))
        errors.forEach((line) => this.output.appendLine(`[ERROR] ${line}`))
        if (info.length)
            vscode.window.setStatusBarMessage(
                `$(folder) ${info[0]}${info.length > 1 ? ` (+${info.length - 1})` : ''}`,
                6000
            )
        if (errors.length) {
            const first = change.errors[0]
            vscode.window
                .showWarningMessage(`Compilation system not loaded: ${errors[0]}`, 'Open file')
                .then((choice) => {
                    if (choice === 'Open file' && first) vscode.window.showTextDocument(vscode.Uri.parse(first.file))
                })
        }
        if (change.added.length || change.removed.length) this.requestSystems()
    }

    /** Creates kico/<name>.kico from the template in the (chosen) workspace folder and opens it. */
    async newSystem(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? []
        if (!folders.length) {
            vscode.window.showErrorMessage('Open a folder first; compilation systems live in the workspace.')
            return
        }
        const folder =
            folders.length === 1
                ? folders[0]
                : await vscode.window.showWorkspaceFolderPick({
                      placeHolder: 'Workspace folder for the new compilation system',
                  })
        if (!folder) return
        const name = await vscode.window.showInputBox({
            prompt: 'Id of the new compilation system (dotted names are fine)',
            value: 'my.system',
            validateInput: (value) =>
                /^[A-Za-z_][\w.]*$/.test(value)
                    ? undefined
                    : 'Use letters, digits, underscores and dots, starting with a letter',
        })
        if (!name) return
        const target = vscode.Uri.joinPath(folder.uri, 'kico', `${name}.kico`)
        try {
            await vscode.workspace.fs.stat(target)
            vscode.window.showErrorMessage(`${describeSource(target.toString())} exists already.`)
            return
        } catch {
            // The file does not exist, which is what we want.
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, 'kico'))
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(SYSTEM_TEMPLATE(name)))
        await vscode.window.showTextDocument(target)
    }
}
