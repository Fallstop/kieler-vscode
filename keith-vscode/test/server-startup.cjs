// The class-data-sharing startup cache against the real server: session 1 records the class list,
// `java -Xshare:dump` builds the archive with exactly the arguments the extension uses, session 2
// maps it (the JVM reports "sharing") and speaks the protocol, and a damaged archive is skipped with
// a warning on stderr while stdout stays a clean LSP stream.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const { StartupCache, archiveKey, JVM_LOGGING_ARGS } = require('./load-typescript.cjs')({})(
    'src/runtime/startup-cache.ts'
)

async function session(java, classpath, extraArgs, workspace) {
    const extension = path.resolve(__dirname, '..')
    const fixture = path.join(workspace, 'audit.sctx')
    fs.copyFileSync(path.join(__dirname, 'fixtures/audit.sctx'), fixture)
    const uri = pathToFileURL(fixture).href
    const started = process.hrtime.bigint()
    const server = spawn(
        java,
        [
            '-Djava.awt.headless=true',
            ...JVM_LOGGING_ARGS,
            ...extraArgs,
            '-cp',
            classpath,
            'de.cau.cs.kieler.language.server.LanguageServer',
        ],
        { cwd: extension }
    )
    let stderr = ''
    let stdout = ''
    server.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-12000)
    })
    server.stdout.on('data', (chunk) => {
        if (stdout.length < 200) stdout += chunk
    })
    const closed = new Promise((resolve) => server.once('close', (code, signal) => resolve({ code, signal })))
    const connection = createMessageConnection(
        new StreamMessageReader(server.stdout),
        new StreamMessageWriter(server.stdin)
    )
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', (params) => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) =>
        new Promise((resolve, reject) => {
            const waiter = {
                method,
                accept,
                resolve: (params) => {
                    clearTimeout(timer)
                    waiters.delete(waiter)
                    resolve(params)
                },
            }
            const timer = setTimeout(() => {
                waiters.delete(waiter)
                reject(new Error(`Timed out waiting for ${method}\n${stderr}`))
            }, 60000)
            waiters.add(waiter)
        })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 120000)
    const timing = {}
    try {
        const initialize = connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(workspace).href,
            capabilities: {},
            workspaceFolders: null,
        })
        await Promise.race([
            initialize,
            closed.then((exit) => {
                throw new Error(`Server exited before initialize (${exit.code ?? exit.signal})\n${stderr}`)
            }),
        ])
        timing.initialize = Number(process.hrtime.bigint() - started) / 1e6
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId: 'sctx', version: 1, text: fs.readFileSync(fixture, 'utf8') },
        })
        const systemsReady = waitFor('keith/kicool/compilation-systems')
        await connection.sendNotification('keith/kicool/get-systems', uri)
        const systems = await systemsReady
        timing.systems = Number(process.hrtime.bigint() - started) / 1e6
        assert.ok(
            systems.systems.some((entry) => entry.simulation),
            'the server offers simulation systems'
        )
        await connection.sendRequest('shutdown')
        connection.sendNotification('exit')
    } finally {
        clearTimeout(watchdog)
        setTimeout(() => server.kill(), 5000).unref()
        await closed
        connection.dispose()
    }
    return { ...timing, stderr, stdout }
}

async function main() {
    const { classpath, java } = require('./server-launch.cjs')
    assert.ok(fs.existsSync(classpath), 'The language server JAR is required; run npm run build:server')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-startup-'))
    const root = path.join(workspace, 'cds')
    // The key hashes the launcher path; `java` from PATH is resolved the way the extension sees it.
    const key = archiveKey(classpath, {
        command: java,
        description: spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0],
    })
    const cache = new StartupCache(root, key)

    // Session 1: record which classes the server loads.
    const first = cache.launchArguments()
    assert.equal(first.state, 'empty')
    const recording = await session(java, classpath, first.args, workspace)
    assert.ok(fs.statSync(cache.classList).size > 100000, 'the class list names thousands of classes')
    assert.equal(cache.state(), 'classlist')
    assert.equal(cache.needsDump(), true)
    console.log(
        `Session 1 (recording): initialize ${recording.initialize.toFixed(0)} ms, systems ${recording.systems.toFixed(
            0
        )} ms, class list ${(fs.statSync(cache.classList).size / 1e3).toFixed(0)} kB`
    )

    // Between sessions: the detached dump the extension spawns.
    cache.beginDump()
    const dumpStart = Date.now()
    const dump = spawnSync(java, [...JVM_LOGGING_ARGS, ...cache.dumpArguments(classpath)], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '..'),
    })
    cache.completeDump(dump.status === 0)
    assert.equal(dump.status, 0, `java -Xshare:dump failed:\n${dump.stderr.slice(-3000)}`)
    assert.equal(cache.state(), 'archive')
    const archiveSize = fs.statSync(cache.archive).size
    assert.ok(archiveSize > 10e6, `the archive holds the JDK and server classes (${archiveSize} bytes)`)
    console.log(`Dump: ${Date.now() - dumpStart} ms, archive ${(archiveSize / 1e6).toFixed(1)} MB`)

    // Session 2: the archive is mapped ("sharing" in the VM banner) and the server works.
    const second = cache.launchArguments()
    assert.equal(second.state, 'archive')
    const banner = spawnSync(java, [...JVM_LOGGING_ARGS, ...second.args, '-cp', classpath, '-version'], {
        encoding: 'utf8',
    })
    assert.match(banner.stderr, /sharing\)/, `the JVM must accept the archive:\n${banner.stderr}`)
    assert.doesNotMatch(banner.stderr, /\[warning\]/, banner.stderr)
    const cached = await session(java, classpath, second.args, workspace)
    assert.doesNotMatch(cached.stderr, /\[warning\]\[cds\]/, cached.stderr)
    console.log(
        `Session 2 (archive): initialize ${cached.initialize.toFixed(0)} ms, systems ${cached.systems.toFixed(0)} ms`
    )

    // A damaged archive: skipped with a CRC warning on stderr, never a crash, never a byte on stdout.
    fs.chmodSync(cache.archive, 0o644)
    const bytes = fs.readFileSync(cache.archive)
    for (let offset = 4096; offset < bytes.length; offset += 4099) bytes[offset] ^= 0xff
    fs.writeFileSync(cache.archive, bytes)
    const damaged = await session(java, classpath, cache.launchArguments().args, workspace)
    assert.match(damaged.stderr, /Checksum verification failed/, damaged.stderr)
    assert.match(damaged.stdout, /^Content-Length: /, 'stdout stays a clean LSP stream')
    console.log('Damaged archive: skipped with a warning, protocol intact.')

    // A crash at start would discard the archive; a clean exit keeps it.
    assert.equal(cache.handleExit(second, 0, null, 3000), false)
    assert.equal(cache.state(), 'archive')
    assert.equal(cache.handleExit(second, 134, null, 900), true)
    assert.equal(cache.state(), 'failed')
    assert.equal(fs.existsSync(cache.archive), false)
    fs.rmSync(workspace, { recursive: true, force: true })
    console.log('Startup cache passed: class list, dump, mapped archive, damaged archive fallback, crash guard.')
}

main().catch((error) => {
    console.error(error.stack ?? String(error))
    process.exit(1)
})
