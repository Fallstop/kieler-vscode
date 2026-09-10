/*
 * SCCharts Lab: the class-data-sharing archive that makes the language server start faster.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * HotSpot can map the parsed and verified form of classes from an archive (AppCDS) instead of
 * loading them from the jar again. The archive is built on the user's machine because it must
 * match the exact JVM binary and jar: five of the six bundled runtimes are cross-linked on Linux,
 * so no build machine can dump it for them, and `-XX:+AutoCreateSharedArchive` needs a base
 * archive the jlink images do not carry. A static archive is therefore built in two steps:
 *
 *  1. The first server start runs with `-XX:DumpLoadedClassList`, which records every class the
 *     server loads while the user works.
 *  2. When that server exits (or at the next start, if the window closed first), a detached
 *     `java -Xshare:dump` turns the list into the archive. Every later start maps it with
 *     `-XX:SharedArchiveFile` and `-Xshare:auto`, so a missing or corrupt file only costs the speed-up.
 *
 * Archives live in `<global storage>/cds/<key>/`, where the key hashes the jar and the Java
 * binary; a new jar or runtime therefore starts from step 1 and the old directory is deleted.
 */

/**
 * HotSpot's unified logging prints its warnings to stdout, which is the LSP channel: one
 * `[warning][cds] ...` line would corrupt the protocol. These options send JVM logging to stderr.
 */
export const JVM_LOGGING_ARGS = ['-Xlog:disable', '-Xlog:all=warning:stderr']

/** A server that dies this soon after a start with the archive is blamed on the archive. */
export const ARCHIVE_CRASH_WINDOW_MS = 20000

export const ARCHIVE_FILE = 'server.jsa'
export const CLASS_LIST_FILE = 'classes.lst'
export const DUMP_LOG_FILE = 'dump.log'
const PENDING_ARCHIVE_FILE = 'server.jsa.tmp'
const FAILED_MARKER_FILE = 'dump-failed'
const LOCK_FILE = 'dump.lock'
/** A dump that has not finished after this long is assumed dead (a normal one takes seconds). */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000
/** Only this much of the jar is hashed; together with size and mtime that pins the exact build. */
const HASHED_JAR_BYTES = 1024 * 1024

export type StartupCacheState =
    /** The archive exists and is mapped at start. */
    | 'archive'
    /** A class list was recorded; the archive still has to be dumped. */
    | 'classlist'
    /** Nothing recorded yet: this start records the class list. */
    | 'empty'
    /** The dump failed for this jar and runtime; the server runs without an archive. */
    | 'failed'

export interface StartupCacheFileSystem {
    existsSync: (file: string) => boolean
    statSync: (file: string) => { size: number; mtimeMs: number }
    mkdirSync: (directory: string, options: { recursive: true }) => unknown
    rmSync: (file: string, options: { recursive?: boolean; force?: boolean }) => void
    readdirSync: (directory: string) => string[]
    renameSync: (from: string, to: string) => void
    writeFileSync: (file: string, content: string) => void
    readFileSync: (file: string, encoding: 'utf8') => string
    /** The first {@link HASHED_JAR_BYTES} of a file. */
    readHead: (file: string) => Uint8Array
}

export const nodeFileSystem: StartupCacheFileSystem = {
    existsSync: (file) => fs.existsSync(file),
    statSync: (file) => fs.statSync(file),
    mkdirSync: (directory, options) => fs.mkdirSync(directory, options),
    rmSync: (file, options) => fs.rmSync(file, options),
    readdirSync: (directory) => fs.readdirSync(directory),
    renameSync: (from, to) => fs.renameSync(from, to),
    writeFileSync: (file, content) => fs.writeFileSync(file, content),
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    readHead: (file) => {
        const handle = fs.openSync(file, 'r')
        try {
            const buffer = new Uint8Array(HASHED_JAR_BYTES)
            const read = fs.readSync(handle, buffer, 0, HASHED_JAR_BYTES, 0)
            return buffer.subarray(0, read)
        } finally {
            fs.closeSync(handle)
        }
    },
}

export interface ArchiveRuntime {
    /** The launcher that will run the server; the archive is only valid for this binary. */
    command: string
    /** Its `java -version` identity, so a runtime update at the same path also invalidates the key. */
    description: string
}

/** Identifies one (jar, Java) pair; an archive is only ever used with the pair it was dumped for. */
export function archiveKey(
    jar: string,
    runtime: ArchiveRuntime,
    fileSystem: StartupCacheFileSystem = nodeFileSystem
): string {
    const stat = fileSystem.statSync(jar)
    const hash = crypto.createHash('sha256')
    hash.update(`${jar}\n${stat.size}\n${Math.round(stat.mtimeMs)}\n`)
    hash.update(fileSystem.readHead(jar))
    hash.update(`\n${runtime.command}\n${runtime.description}\n`)
    return hash.digest('hex').slice(0, 16)
}

export interface LaunchPlan {
    state: StartupCacheState
    /** JVM options to insert before `-cp`. */
    args: string[]
}

export class StartupCache {
    readonly directory: string

    constructor(
        readonly root: string,
        readonly key: string,
        private readonly fileSystem: StartupCacheFileSystem = nodeFileSystem
    ) {
        this.directory = path.join(root, key)
    }

    get archive(): string {
        return path.join(this.directory, ARCHIVE_FILE)
    }

    get classList(): string {
        return path.join(this.directory, CLASS_LIST_FILE)
    }

    get dumpLog(): string {
        return path.join(this.directory, DUMP_LOG_FILE)
    }

    private get pendingArchive(): string {
        return path.join(this.directory, PENDING_ARCHIVE_FILE)
    }

    private get failedMarker(): string {
        return path.join(this.directory, FAILED_MARKER_FILE)
    }

    private get lock(): string {
        return path.join(this.directory, LOCK_FILE)
    }

    state(): StartupCacheState {
        if (this.fileSystem.existsSync(this.archive)) return 'archive'
        if (this.fileSystem.existsSync(this.failedMarker)) return 'failed'
        if (this.hasClassList()) return 'classlist'
        return 'empty'
    }

    private hasClassList(): boolean {
        return this.fileSystem.existsSync(this.classList) && this.fileSystem.statSync(this.classList).size > 0
    }

    /** The options for this server start, and what the start contributes to the cache. */
    launchArguments(): LaunchPlan {
        const state = this.state()
        switch (state) {
            case 'archive':
                // -Xshare:auto (the default, spelled out) makes a rejected archive a warning, and
                // VerifySharedSpaces checks the CRC first: without it a damaged archive crashes the JVM.
                return {
                    state,
                    args: [`-XX:SharedArchiveFile=${this.archive}`, '-Xshare:auto', '-XX:+VerifySharedSpaces'],
                }
            case 'empty':
                this.fileSystem.mkdirSync(this.directory, { recursive: true })
                return { state, args: [`-XX:DumpLoadedClassList=${this.classList}`] }
            default:
                return { state, args: [] }
        }
    }

    /** Whether a dump should run now: a class list exists, no archive does, and nobody else is dumping. */
    needsDump(now: number = Date.now()): boolean {
        if (this.state() !== 'classlist') return false
        if (!this.fileSystem.existsSync(this.lock)) return true
        try {
            const started = Number(this.fileSystem.readFileSync(this.lock, 'utf8').trim())
            return !Number.isFinite(started) || now - started > LOCK_TIMEOUT_MS
        } catch {
            return true
        }
    }

    /** Marks a dump as running. */
    beginDump(now: number = Date.now()): void {
        this.fileSystem.rmSync(this.pendingArchive, { force: true })
        this.fileSystem.writeFileSync(this.lock, `${now}\n`)
    }

    /** `java` options that build the archive from the recorded class list. */
    dumpArguments(jar: string): string[] {
        return [
            '-Xshare:dump',
            `-XX:SharedClassListFile=${this.classList}`,
            `-XX:SharedArchiveFile=${this.pendingArchive}`,
            '-Djava.awt.headless=true',
            '-cp',
            jar,
        ]
    }

    /** Publishes the dumped archive, or remembers that dumping does not work for this pair. */
    completeDump(succeeded: boolean): void {
        this.fileSystem.rmSync(this.lock, { force: true })
        if (succeeded && this.fileSystem.existsSync(this.pendingArchive)) {
            this.fileSystem.renameSync(this.pendingArchive, this.archive)
            return
        }
        this.fileSystem.rmSync(this.pendingArchive, { force: true })
        this.fileSystem.writeFileSync(this.failedMarker, `${new Date().toISOString()}\n`)
    }

    /**
     * Called when a server that was started with the archive exits. A crash right after the start is
     * blamed on the archive: it is deleted and not rebuilt for this jar and runtime, so the next start
     * cannot fail the same way.
     */
    handleExit(plan: LaunchPlan, code: number | null, signal: string | null, uptimeMs: number): boolean {
        if (plan.state !== 'archive') return false
        const crashed = (code !== null && code !== 0) || signal !== null
        if (!crashed || uptimeMs > ARCHIVE_CRASH_WINDOW_MS) return false
        this.fileSystem.rmSync(this.archive, { force: true })
        this.fileSystem.writeFileSync(
            this.failedMarker,
            `${new Date().toISOString()} server exited with ${code ?? signal} after ${uptimeMs} ms\n`
        )
        return true
    }

    /** Deletes the archives of every other jar or runtime; only the current key is worth keeping. */
    removeOthers(): string[] {
        if (!this.fileSystem.existsSync(this.root)) return []
        const removed: string[] = []
        for (const entry of this.fileSystem.readdirSync(this.root).filter((name) => name !== this.key)) {
            this.fileSystem.rmSync(path.join(this.root, entry), { recursive: true, force: true })
            removed.push(entry)
        }
        return removed
    }

    /** Deletes everything, including the current key's files. */
    static clear(root: string, fileSystem: StartupCacheFileSystem = nodeFileSystem): void {
        fileSystem.rmSync(root, { recursive: true, force: true })
    }
}
