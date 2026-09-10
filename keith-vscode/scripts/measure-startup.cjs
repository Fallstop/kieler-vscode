// Measures how fast the language server starts under different JVM flags.
//
//   node scripts/measure-startup.cjs [--runs 3] [--java <launcher>] [--config <name>,<name>...] [--compile]
//
// For every configuration the server is launched exactly as the extension launches it (see
// src/runtime/runtime-manager.ts), and three times are taken:
//   initialize   ms from spawn until the `initialize` response
//   systems      ms from spawn until `keith/kicool/compilation-systems` after didOpen + getSystems
//                (the point at which the Compile menu is usable)
//   compile      ms for `keith/kicool/compile` of test/fixtures/broken-demo.sctx (--compile only;
//                it needs no C compiler because the scheduler stops that model early)
// plus the resident set size at the end. The first run of each configuration is a warm-up for the
// page cache and (for AppCDS) the archive dump, and is reported separately; the other columns are
// medians of the remaining runs.
//
// Set SCCHARTS_JAVA / --java to compare launchers (e.g. server/jre/bin/java for the bundled image).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const root = path.resolve(__dirname, '..')
const jar = path.join(process.env.SCCHARTS_SERVER_DIR ?? path.join(root, 'server'), 'sccharts-lite-server.jar')
const MAIN = 'de.cau.cs.kieler.language.server.LanguageServer'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-startup-'))
const archive = path.join(scratch, 'server.jsa')

const classlist = path.join(scratch, 'classes.lst')
// HotSpot's unified logging prints warnings to stdout, the LSP channel; a single `[warning][cds]`
// line would corrupt the protocol, so every configuration sends JVM logging to stderr.
const LOGGING = ['-Xlog:disable', '-Xlog:all=warning:stderr']
const CDS = ['-XX:+AutoCreateSharedArchive', `-XX:SharedArchiveFile=${archive}`]
// `static` configurations dump a static archive from a recorded class list before the measured runs
// (what the extension does across sessions); the others run with the flags as given.
// VerifySharedSpaces checks the archive's CRC: without it a damaged file crashes the JVM (SIGSEGV)
// instead of being skipped.
const STATIC = [`-XX:SharedArchiveFile=${archive}`, '-Xshare:auto', '-XX:+VerifySharedSpaces']
const CONFIGS = {
    baseline: [],
    cds: CDS,
    static: { static: true, flags: STATIC },
    'static-noverify': { static: true, flags: STATIC.slice(0, 2) },
    'static+tiered1': { static: true, flags: [...STATIC, '-XX:TieredStopAtLevel=1'] },
    'static+serial': { static: true, flags: [...STATIC, '-XX:+UseSerialGC'] },
    'static+parallel': { static: true, flags: [...STATIC, '-XX:+UseParallelGC'] },
    'static+xss': { static: true, flags: [...STATIC, '-Xss512k'] },
    'static+ci2': { static: true, flags: [...STATIC, '-XX:CICompilerCount=2'] },
    'static+xmx2g': { static: true, flags: [...STATIC, '-Xmx2g'] },
    'static+corrupt': { static: true, corrupt: true, flags: STATIC },
    'cds+tiered1': [...CDS, '-XX:TieredStopAtLevel=1'],
    'cds+serial': [...CDS, '-XX:+UseSerialGC'],
    'cds+parallel': [...CDS, '-XX:+UseParallelGC'],
    tiered1: ['-XX:TieredStopAtLevel=1'],
    serial: ['-XX:+UseSerialGC'],
    parallel: ['-XX:+UseParallelGC'],
    xss: ['-Xss512k'],
    ci2: ['-XX:CICompilerCount=2'],
    xmx2g: ['-Xmx2g'],
}

function option(name, fallback) {
    const index = process.argv.indexOf(name)
    return index === -1 ? fallback : process.argv[index + 1]
}

function rss(pid) {
    try {
        if (process.platform === 'linux') {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
            return Number(/VmRSS:\s+(\d+)/.exec(status)[1]) * 1024
        }
        const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout
        return Number(out.trim()) * 1024
    } catch {
        return NaN
    }
}

async function measure(java, flags, compile) {
    const workspace = fs.mkdtempSync(path.join(scratch, 'ws-'))
    const model = path.join(workspace, 'audit.sctx')
    fs.copyFileSync(path.join(root, 'test/fixtures/audit.sctx'), model)
    const uri = pathToFileURL(model).href
    const start = process.hrtime.bigint()
    const ms = () => Number(process.hrtime.bigint() - start) / 1e6
    const server = spawn(java, ['-Djava.awt.headless=true', ...LOGGING, ...flags, '-cp', jar, MAIN], { cwd: workspace })
    let stderr = ''
    server.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000)
    })
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
                resolve: (r) => {
                    clearTimeout(timer)
                    waiters.delete(waiter)
                    resolve(r)
                },
            }
            const timer = setTimeout(() => {
                waiters.delete(waiter)
                reject(new Error(`Timeout waiting for ${method}\n${stderr}`))
            }, 120000)
            waiters.add(waiter)
        })
    connection.listen()
    const died = new Promise((_, reject) =>
        server.once('close', (code, signal) => reject(new Error(`server exited early (${code ?? signal})\n${stderr}`)))
    )
    const step = (promise) =>
        Promise.race([
            promise,
            died,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout\n${stderr}`)), 120000).unref()),
        ])
    const result = {}
    try {
        await step(
            connection.sendRequest('initialize', {
                processId: process.pid,
                rootUri: pathToFileURL(workspace).href,
                capabilities: {},
                workspaceFolders: null,
            })
        )
        result.initialize = ms()
        await connection.sendNotification('initialized', {})
        const systems = waitFor('keith/kicool/compilation-systems')
        await connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId: 'sctx', version: 1, text: fs.readFileSync(model, 'utf8') },
        })
        await connection.sendNotification('keith/kicool/get-systems', uri)
        await step(systems)
        result.systems = ms()
        if (compile) {
            const broken = path.join(workspace, 'broken.sctx')
            fs.copyFileSync(path.join(root, 'test/fixtures/broken-demo.sctx'), broken)
            const brokenUri = pathToFileURL(broken).href
            await connection.sendNotification('textDocument/didOpen', {
                textDocument: { uri: brokenUri, languageId: 'sctx', version: 1, text: fs.readFileSync(broken, 'utf8') },
            })
            const done = waitFor('keith/kicool/didCompile', (r) => r.finished && r.uri === brokenUri)
            const before = ms()
            await connection.sendNotification('keith/kicool/compile', {
                uri: brokenUri,
                command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c',
                clientId: 'keith-diagram_sprotty',
                inplace: true,
                showResultingModel: false,
                snapshot: false,
            })
            await step(done)
            result.compile = ms() - before
        }
        result.rss = rss(server.pid)
        await connection.sendRequest('shutdown')
        connection.sendNotification('exit')
    } finally {
        const exited = new Promise((resolve) => server.once('close', resolve))
        setTimeout(() => server.kill(), 3000).unref()
        await exited
        connection.dispose()
    }
    return result
}

function summarise(runs) {
    const keys = ['initialize', 'systems', 'compile', 'rss']
    const summary = {}
    for (const key of keys) {
        const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number' && !Number.isNaN(v))
        // Medians: a background build on the same machine skews one run, not the middle one.
        if (values.length) summary[key] = values.sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
    }
    return summary
}

async function main() {
    const javaOption = option('--java', process.env.SCCHARTS_JAVA ?? 'java')
    // Servers run in a scratch workspace, so a launcher given relative to keith-vscode is made absolute.
    const java = javaOption.includes(path.sep) ? path.resolve(javaOption) : javaOption
    const runs = Number(option('--runs', '3'))
    const names = (option('--config', 'baseline,cds') || '').split(',').filter(Boolean)
    const compile = process.argv.includes('--compile')
    if (!fs.existsSync(jar)) throw new Error(`No server jar at ${jar}`)
    const version = spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0]
    console.log(`java: ${java} (${version})`)
    console.log(`jar: ${jar}`)
    const rows = []
    for (const name of names) {
        const config = CONFIGS[name]
        if (!config) throw new Error(`Unknown configuration ${name}; one of ${Object.keys(CONFIGS).join(', ')}`)
        const flags = Array.isArray(config) ? config : config.flags
        fs.rmSync(archive, { force: true })
        fs.rmSync(classlist, { force: true })
        let dumpMs
        if (config.static) {
            // Session 1 records the class list, the dump runs between sessions, later sessions map the archive.
            await measure(java, [`-XX:DumpLoadedClassList=${classlist}`], compile)
            const before = Date.now()
            const dump = spawnSync(
                java,
                [
                    ...LOGGING,
                    '-Xshare:dump',
                    `-XX:SharedClassListFile=${classlist}`,
                    `-XX:SharedArchiveFile=${archive}`,
                    '-Djava.awt.headless=true',
                    '-cp',
                    jar,
                ],
                { encoding: 'utf8' }
            )
            dumpMs = Date.now() - before
            if (dump.status !== 0) throw new Error(`Static dump failed:\n${dump.stderr.slice(-2000)}`)
            if (config.corrupt) {
                fs.chmodSync(archive, 0o644)
                const bytes = fs.readFileSync(archive)
                for (let i = 4096; i < bytes.length; i += 4099) bytes[i] ^= 0xff
                fs.writeFileSync(archive, bytes)
            }
        }
        const first = await measure(java, flags, compile)
        const rest = []
        for (let i = 1; i < runs; i++) rest.push(await measure(java, flags, compile))
        const warm = summarise(rest.length ? rest : [first])
        const size = fs.existsSync(archive) ? fs.statSync(archive).size : 0
        rows.push({ config: name, first, warm, archive: size, dumpMs })
        fs.rmSync(archive, { force: true })
        fs.rmSync(classlist, { force: true })
    }
    const fmt = (v) => (typeof v === 'number' && !Number.isNaN(v) ? Math.round(v).toString() : '-')
    console.log('\nconfig | first init | init ms | systems ms | compile ms | RSS MB | archive MB | dump ms')
    console.log('--- | --- | --- | --- | --- | --- | --- | ---')
    for (const row of rows) {
        console.log(
            `${row.config} | ${fmt(row.first.initialize)} | ${fmt(row.warm.initialize)} | ${fmt(
                row.warm.systems
            )} | ${fmt(row.warm.compile)} | ${fmt(row.warm.rss / 1e6)} | ${
                row.archive ? (row.archive / 1e6).toFixed(1) : '-'
            } | ${fmt(row.dumpMs)}`
        )
    }
    fs.rmSync(scratch, { recursive: true, force: true })
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack ?? String(error))
        process.exit(1)
    })
}

module.exports = { CONFIGS, measure }
