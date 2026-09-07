const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const extension = path.resolve(__dirname, '..')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-diagnostics-'))
    const server = spawn('java', ['-Djava.awt.headless=true', '-cp', ['diagnostics.jar', 'jetty10/*', 'kieler-language-server.jar'].map(file => path.join(extension, 'server', file)).join(path.delimiter), 'de.cau.cs.kieler.language.server.LanguageServer'], { cwd: workspace })
    const closed = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}`)) }, 40000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    async function compile(name, text) {
        const dir = path.join(workspace, name)
        fs.mkdirSync(dir)
        const file = path.join(dir, `${name}.sctx`)
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const done = waitFor('keith/kicool/didCompile', result => result.finished && result.uri === uri)
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await done
        const stages = result.results.files.flat()
        return { dir, uri, stages, issues: stages.flatMap(stage => stage.diagnostics ?? []), errors: stages.flatMap(stage => stage.errors ?? []) }
    }
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const demo = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
        const baseline = fs.readFileSync(path.join(__dirname, 'fixtures/audit.sctx'), 'utf8')
        const broken = await compile('broken', demo)
        const cycles = broken.issues.filter(issue => issue.code === 'scheduling-cycle')
        assert.equal(cycles.length, 1)
        assert.equal(cycles[0].cycle.length, 2, 'Return a short witness, not all blocked operations')
        assert.ok(cycles[0].locations.some(location => location.label === 'timeout_update = false'))
        assert.ok(cycles[0].locations.some(location => location.label === 'timeout_update = true'))
        for (const location of cycles[0].locations) {
            assert.equal(demo.slice(location.offset, location.offset + location.length).trim().replace(/\s+/g, ' '), location.label)
            assert.ok(location.traceUris.length > 0)
        }
        assert.ok(!broken.stages.some(stage => stage.name === 'GCC Compiler'), 'Stop after scheduler errors')
        assert.ok(!fs.existsSync(path.join(broken.dir, 'kieler-gen/bin/simulation.exe')))
        console.log('Scheduler: one two-edge cycle, exact source ranges, diagram traces, no executable.')

        const array = await compile('array', demo.replace('timeout_update = false;', ''))
        const cIssue = array.issues.find(issue => issue.code === 'c-compiler' && /array type.*not assignable|assignment to expression with array type/.test(issue.message))
        assert.ok(cIssue, JSON.stringify(array.issues))
        const generated = cIssue.locations.find(location => location.generatedLine)
        assert.match(generated.generatedLine, /d->timeout_vals = d->timeout_buf/)
        assert.ok(generated.line > 0)
        assert.ok(cIssue.locations.some(location => location.label === 'timeout_vals = timeout_buf'), JSON.stringify(cIssue.locations, null, 2))
        assert.ok(cIssue.details.includes('gcc'))
        console.log('C compiler: actual array diagnostic, generated file/line/column and full output.')

        const { arrayCopyFix } = require('./load-typescript.cjs')()('src/kico/source-mapping.ts')
        const arraySource = demo.replace('timeout_update = false;', '')
        const origin = cIssue.locations.find(location => location.label === 'timeout_vals = timeout_buf')
        const replacement = arrayCopyFix(arraySource, origin)
        assert.ok(replacement)
        const fixed = await compile('array-fixed', arraySource.slice(0, origin.offset) + replacement + arraySource.slice(origin.offset + origin.length))
        assert.deepEqual(fixed.errors, [], 'Element-copy quick fix must compile on the actual demo')

        const host = await compile('host', '#hostcode-c "\nint probe(void) { return missing_symbol; }\n"\n' + baseline)
        const hostIssue = host.issues.find(issue => issue.code === 'c-compiler')
        assert.match(hostIssue.message, /missing_symbol/)
        assert.match(hostIssue.locations[0].generatedLine, /return missing_symbol/)

        const recovered = await compile('recovered', baseline)
        assert.deepEqual(recovered.errors, [])
        assert.ok(fs.existsSync(path.join(recovered.dir, 'kieler-gen/bin/simulation.exe')))
        const started = waitFor('keith/simulation/started')
        await connection.sendNotification('keith/simulation/start', { uri: recovered.uri, simulationType: 'Manual' })
        assert.equal((await started).successful, true)
        await connection.sendRequest('keith/simulation/stop')
        assert.ok(!/KIELER diagnostic tracing:|KIELER C diagnostics:|VerifyError|NoSuchMethodError/.test(stderr), stderr)
        console.log('Recovery: clean model compiles and simulates after scheduler and C failures.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
