/*
 * SCCharts Lab: locating a Java runtime for the language server.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** The language server is compiled for this class-file level; older runtimes refuse to load it. */
export const REQUIRED_JAVA = 21

export type JavaSource = 'bundled' | 'setting' | 'JDK_HOME' | 'JAVA_HOME' | 'PATH'

export interface JavaRuntime {
    /** Launcher to spawn. Absolute except for the bare `java` of the PATH candidate. */
    command: string
    /** Installation directory when known; its `bin` holds `javac` if the runtime is a JDK. */
    home?: string
    /** Feature version, e.g. 21. */
    version: number
    source: JavaSource
    /** Description for the output channel, e.g. `Temurin-21.0.12.1+1`. */
    description: string
}

export interface JavaCandidate {
    command: string
    home?: string
    source: JavaSource
}

export interface JavaProblem extends JavaCandidate {
    problem: string
}

export interface JavaLookupResult {
    runtime?: JavaRuntime
    /** Every candidate that was rejected, in the order it was tried. */
    rejected: JavaProblem[]
}

export interface JavaLookupOptions {
    /** Root of the installed extension; the bundled runtime lives in `server/jre` below it. */
    extensionPath: string
    /** Value of the `keith-vscode.javaHome` setting. */
    javaHome?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    /** Runs `<command> -version` and resolves with its combined output; rejects when it cannot run. */
    probe?: (command: string) => Promise<string>
    fileSystem?: Pick<typeof fs, 'existsSync' | 'accessSync' | 'chmodSync' | 'readdirSync' | 'statSync'>
}

export const BUNDLED_RUNTIME_DIRECTORY = 'server/jre'

/** `java -version` prints the version on stderr as `openjdk version "21.0.4" 2024-07-16 LTS`. */
export function parseJavaVersion(output: string): number | undefined {
    const match = /version\s+"(\d+)(?:\.(\d+))?/.exec(output)
    if (!match) return undefined
    const major = Number(match[1])
    // Java 8 and older report themselves as 1.x.
    return major === 1 ? Number(match[2]) : major
}

/** The runtime's own name from the `-version` output, for logging which Java was picked. */
export function describeJavaVersion(output: string): string {
    const build = /Runtime Environment\s+(\S+)\s+\(build\s+([^)]+)\)/.exec(output)
    if (build && !/^\(/.test(build[1])) return build[1]
    const generic = /version\s+"([^"]+)"/.exec(output)
    return generic ? generic[1] : output.split('\n')[0].trim()
}

export function javaLauncher(home: string, platform: NodeJS.Platform): string {
    return path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java')
}

/** Runs `java -version` with a timeout; the version goes to stderr, and some builds add stdout noise. */
export function probeJava(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, ['-version'], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
            const output = `${stderr ?? ''}\n${stdout ?? ''}`
            if (error && parseJavaVersion(output) === undefined) {
                reject(new Error(error.message))
                return
            }
            resolve(output)
        })
    })
}

/**
 * Unix file modes do not always survive the VSIX. Make the launcher and its helpers executable again
 * so the bundled runtime does not fail with EACCES on first start.
 */
export function ensureExecutable(home: string, fileSystem: NonNullable<JavaLookupOptions['fileSystem']>): void {
    const files = [
        ...safeList(path.join(home, 'bin'), fileSystem).map((name) => path.join(home, 'bin', name)),
        path.join(home, 'lib', 'jspawnhelper'),
    ]
    for (const file of files.filter((candidate) => fileSystem.existsSync(candidate))) {
        try {
            fileSystem.accessSync(file, fs.constants.X_OK)
        } catch {
            try {
                fileSystem.chmodSync(file, 0o755)
            } catch {
                // Read-only installation: the probe below reports the real failure.
            }
        }
    }
}

function safeList(directory: string, fileSystem: NonNullable<JavaLookupOptions['fileSystem']>): string[] {
    try {
        return fileSystem.readdirSync(directory) as string[]
    } catch {
        return []
    }
}

/** The candidates in the order they are tried: bundled runtime, setting, JDK_HOME, JAVA_HOME, PATH. */
export function javaCandidates(options: JavaLookupOptions): JavaCandidate[] {
    const platform = options.platform ?? process.platform
    const env = options.env ?? process.env
    const fileSystem = options.fileSystem ?? fs
    const candidates: JavaCandidate[] = []
    const bundled = path.join(options.extensionPath, BUNDLED_RUNTIME_DIRECTORY)
    if (fileSystem.existsSync(javaLauncher(bundled, platform))) {
        candidates.push({ command: javaLauncher(bundled, platform), home: bundled, source: 'bundled' })
    }
    const setting = options.javaHome?.trim()
    if (setting) {
        candidates.push(homeCandidate(setting, 'setting', platform))
    }
    for (const variable of ['JDK_HOME', 'JAVA_HOME'] as const) {
        const value = env[variable]?.trim()
        if (value) candidates.push(homeCandidate(value, variable, platform))
    }
    candidates.push({ command: platform === 'win32' ? 'java.exe' : 'java', source: 'PATH' })
    return candidates
}

function homeCandidate(value: string, source: JavaSource, platform: NodeJS.Platform): JavaCandidate {
    // Accept either an installation directory or a path to the launcher itself.
    if (/[\\/]java(\.exe)?$/i.test(value)) {
        return { command: value, home: path.dirname(path.dirname(value)), source }
    }
    return { command: javaLauncher(value, platform), home: value, source }
}

/** Checks one candidate: runs it, reads its version, and compares against the requirement. */
async function evaluateCandidate(
    candidate: JavaCandidate,
    options: JavaLookupOptions
): Promise<{ runtime: JavaRuntime } | { problem: string }> {
    const fileSystem = options.fileSystem ?? fs
    const platform = options.platform ?? process.platform
    const probe = options.probe ?? probeJava
    if (candidate.source !== 'PATH' && !fileSystem.existsSync(candidate.command)) {
        return { problem: 'no java launcher at this path' }
    }
    if (candidate.source === 'bundled' && platform !== 'win32' && candidate.home) {
        ensureExecutable(candidate.home, fileSystem)
    }
    let output: string
    try {
        output = await probe(candidate.command)
    } catch (error) {
        return { problem: error instanceof Error ? error.message : String(error) }
    }
    const version = parseJavaVersion(output)
    if (version === undefined) {
        return { problem: `unrecognised output of java -version: ${output.trim().split('\n')[0]}` }
    }
    if (version < REQUIRED_JAVA) {
        return { problem: `Java ${version} is too old, ${REQUIRED_JAVA} or newer is required` }
    }
    return { runtime: { ...candidate, version, description: describeJavaVersion(output) } }
}

/**
 * Finds the first Java that is at least {@link REQUIRED_JAVA}. Preference order: the runtime shipped in
 * this platform build of the extension, the `keith-vscode.javaHome` setting, `JDK_HOME`, `JAVA_HOME`,
 * and finally whatever `java` is on PATH.
 */
export async function findJava(options: JavaLookupOptions): Promise<JavaLookupResult> {
    const rejected: JavaProblem[] = []
    for (const candidate of javaCandidates(options)) {
        // Candidates are ordered by preference, so each one is only probed when the better ones failed.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await evaluateCandidate(candidate, options)
        if ('runtime' in outcome) {
            return { runtime: outcome.runtime, rejected }
        }
        rejected.push({ ...candidate, problem: outcome.problem })
    }
    return { rejected }
}

/** Human-readable summary of a failed lookup, for the error notification and the output channel. */
export function explainMissingJava(result: JavaLookupResult): string {
    if (result.rejected.length === 0) return 'No Java runtime was found.'
    return result.rejected.map((entry) => `${entry.source}: ${entry.command} (${entry.problem})`).join('\n')
}

/** Whether a runtime ships the compiler the Java simulation needs. */
export function hasJavaCompiler(runtime: JavaRuntime, platform: NodeJS.Platform = process.platform): boolean {
    if (!runtime.home) return false
    return fs.existsSync(path.join(runtime.home, 'bin', platform === 'win32' ? 'javac.exe' : 'javac'))
}
