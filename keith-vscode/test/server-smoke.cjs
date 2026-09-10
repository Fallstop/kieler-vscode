const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')
const { readDataPool, inputValue } = require('./load-typescript.cjs')()('src/simulation/data-pool.ts')

async function main() {
    const extension = path.resolve(__dirname, '..')
    const { classpath, java, serverArgs } = require('./server-launch.cjs')
    assert.ok(fs.existsSync(classpath), 'The language server JAR is required; run npm run build:server')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-smoke-'))
    const fixture = path.join(workspace, 'audit.sctx')
    fs.copyFileSync(path.join(__dirname, 'fixtures/audit.sctx'), fixture)
    const uri = pathToFileURL(fixture).href
    const server = spawn(java, serverArgs, { cwd: extension })
    const closed = new Promise((resolve) => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of waiters) {
            if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
        }
    })
    connection.onRequest('workspace/configuration', (params) => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: (params) => { clearTimeout(timer); waiters.delete(waiter); resolve(params) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${method}\n${stderr}`)) }, 30000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 60000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(path.dirname(fixture)).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: fs.readFileSync(fixture, 'utf8') } })
        const systemsReady = waitFor('keith/kicool/compilation-systems')
        await connection.sendNotification('keith/kicool/get-systems', uri)
        const systems = await systemsReady
        const system = systems.systems.find((entry) => entry.simulation && /netlist/i.test(entry.id)) ?? systems.systems.find((entry) => entry.simulation)
        assert.ok(system, 'Server must offer a simulation compiler')
        console.log(`Compiling with ${system.id}`)
        const compiled = waitFor('keith/kicool/didCompile', (message) => message.finished)
        await connection.sendNotification('keith/kicool/compile', { uri, command: system.id, clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await compiled
        const errors = result.results.files.flat().flatMap((file) => file.errors ?? [])
        assert.deepEqual(errors, [])
        assert.ok(result.currentIndex >= result.maxIndex)
        for (let session = 0; session < 2; session++) {
            const started = waitFor('keith/simulation/started')
            await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
            const initial = await started
            assert.equal(initial.successful, true, initial.error)
            assert.equal(typeof initial.dataPool.trigger, 'boolean')
            assert.equal(initial.dataPool.timeout_update_vals ?? null, null)
            const pool = readDataPool(initial.dataPool)
            assert.equal(pool.get('timeout_update_vals').type, 'string')
            assert.equal(pool.get('echoed').type, 'string')
            assert.equal(inputValue(pool.get('timeout_update_vals').value, 'string'), '')
            const triggers = [true, false, true, true, false, true]
            const packets = ['', '10,20,30,40,50,60\n', 'é "quoted" \\ input\n', 'changed while output retains its old string', '', 'final']
            let echoed = null
            for (const [index, trigger] of triggers.entries()) {
                const packet = packets[index]
                const tick = waitFor('keith/simulation/didStep')
                await connection.sendNotification('keith/simulation/step', { valuesForNextStep: { trigger, timeout_update_vals: packet }, simulationType: 'Manual' })
                const data = await tick
                assert.equal(data.successful, true, data.error)
                assert.equal(data.values.trigger, trigger)
                assert.equal(data.values.timeout_update_vals, packet, JSON.stringify(data))
                if (index === 2 || index === 5) echoed = packet
                assert.equal(data.values.echoed ?? null, echoed)
                // The first SCCharts reaction enters the initial state.
                assert.equal(data.values.result, index === 0 ? false : trigger)
            }
            const stopped = await connection.sendRequest('keith/simulation/stop')
            assert.equal(stopped.successful, true, stopped.message)
        }
        console.log('Server smoke passed: compile, start, empty and escaped string inputs, retained outputs, twelve ticks, stop, and restart.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
        if (process.env.KIELER_KEEP_TEST_OUTPUT) console.log(`Test output: ${workspace}`)
        else fs.rmSync(workspace, { recursive: true, force: true })
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
