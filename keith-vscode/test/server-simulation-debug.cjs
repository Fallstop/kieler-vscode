// Exercises the simulation debugger through the real protocol: state and condition breakpoints,
// watch expressions, run-to-breakpoint, the tick history and a true rewind by input replay.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const { java, serverArgs, sameFile } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-simulation-debug-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const threads = () => (spawnSync('jstack', [String(server.pid)], { encoding: 'utf8' }).stdout || '').trim()
    const waiters = new Set()
    const notifications = []
    connection.onNotification((method, params) => {
        notifications.push({ method, params })
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 40000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}\n${threads()}`)) }, timeout)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 240000)
    const model = fs.readFileSync(path.join(__dirname, 'fixtures/debug-counter.sctx'), 'utf8')
    const outputs = pool => ({ count: pool.count, done: pool.done, start: pool.start })
    /** Everything the model computes; #ticktime is the wall-clock duration of the tick and never repeats. */
    const computed = pool => Object.fromEntries(Object.entries(pool).filter(([key]) => key !== '#ticktime'))
    async function step(values = {}) {
        const tick = waitFor('keith/simulation/didStep')
        await connection.sendNotification('keith/simulation/step', { valuesForNextStep: values, simulationType: 'Manual' })
        return tick
    }
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const dir = path.join(workspace, 'counter')
        fs.mkdirSync(dir)
        const file = path.join(dir, 'counter.sctx')
        fs.writeFileSync(file, model)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: model } })

        // States are listed from the parsed model before any simulation exists.
        const listed = await connection.sendRequest('keith/simulation/states', { uri })
        const qualified = listed.states.map(state => state.qualified)
        assert.deepEqual(qualified, ['Counter', 'Counter.Idle', 'Counter.Counting', 'Counter.Counting.Tick', 'Counter.Counting.Full', 'Counter.Finished'], JSON.stringify(listed))
        const full = listed.states.find(state => state.qualified === 'Counter.Counting.Full')
        assert.equal(model.slice(full.offset, full.offset + full.length), 'Full')
        assert.ok(listed.states.find(state => state.name === 'Idle').initial)
        console.log('States: qualified names and name offsets from the parsed model.')

        const compiled = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await compiled
        assert.deepEqual(result.results.files.flat().flatMap(stage => stage.errors ?? []), [])
        const started = waitFor('keith/simulation/started')
        await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
        const initial = await started
        assert.ok(initial.successful, initial.error)

        // Breakpoints are validated when set.
        const accepted = await connection.sendRequest('keith/simulation/setBreakpoints', { breakpoints: [
            { id: 'full', kind: 'state', state: 'Full', enabled: true },
            { id: 'two', kind: 'condition', expression: 'count == 2', enabled: true },
            { id: 'bad-state', kind: 'state', state: 'Nowhere', enabled: true },
            { id: 'bad-expr', kind: 'condition', expression: 'count >', enabled: true },
            { id: 'bad-name', kind: 'condition', expression: 'cuont > 1', enabled: true },
            { id: 'tick', kind: 'state', state: 'Tick', enabled: false },
        ] })
        const byId = Object.fromEntries(accepted.accepted.map(entry => [entry.id, entry]))
        assert.ok(byId.full.ok && byId.two.ok && byId.tick.ok, JSON.stringify(accepted))
        // The tts systems count taken transitions; a tracker that saw "flags" would re-report old transitions every tick.
        assert.equal(accepted.signaling, 'counters', JSON.stringify(accepted))
        assert.ok(!byId['bad-state'].ok && /Nowhere/.test(byId['bad-state'].message), JSON.stringify(byId['bad-state']))
        assert.ok(!byId['bad-expr'].ok && byId['bad-expr'].message, JSON.stringify(byId['bad-expr']))
        assert.ok(!byId['bad-name'].ok && /cuont/.test(byId['bad-name'].message), JSON.stringify(byId['bad-name']))
        const watches = await connection.sendRequest('keith/simulation/setWatches', { watches: [
            { id: 'w1', expression: 'count * 10' },
            { id: 'w2', expression: 'start && !done' },
            { id: 'w3', expression: 'pre(count) != count' },
            { id: 'w4', expression: 'count / 0' },
            { id: 'w5', expression: 'nothere' },
        ] })
        assert.deepEqual(watches.accepted.map(entry => entry.ok), [true, true, true, true, false], JSON.stringify(watches))
        console.log('Breakpoints and watches: accepted with validation messages for unknown states, syntax errors and unknown variables.')

        // Tick 1 enters Idle. Tick 2: start → Counting (count 0). Tick 3: count 1. Tick 4: count 2 → condition breakpoint.
        const ticks = []
        const values = tick => Object.fromEntries(tick.watches.map(watch => [watch.id, watch.error ? `error:${watch.error}` : watch.value]))
        ticks.push(await step({ start: true }))
        assert.equal(ticks[0].step, 1)
        assert.equal(ticks[0].values.count, 0)
        assert.equal(ticks[0].breakpoint, undefined)
        assert.equal(values(ticks[0]).w1, 0)
        assert.equal(values(ticks[0]).w2, true)
        assert.equal(values(ticks[0]).w3, false, 'pre() on the first tick reads the initial values')
        assert.match(values(ticks[0]).w4, /error:Division by zero/)
        assert.match(values(ticks[0]).w5, /error:Unknown variable/)
        ticks.push(await step())
        assert.equal(ticks[1].values.count, 0)
        ticks.push(await step())
        assert.equal(ticks[2].values.count, 1)
        assert.equal(values(ticks[2]).w1, 10)
        assert.equal(values(ticks[2]).w3, true)
        assert.equal(ticks[2].breakpoint, undefined)
        const pausedAtTwo = waitFor('keith/simulation/paused')
        ticks.push(await step())
        assert.equal(ticks[3].values.count, 2)
        assert.equal(ticks[3].breakpoint?.id, 'two', JSON.stringify(ticks[3].breakpoint))
        assert.equal(ticks[3].breakpoint.step, 4)
        assert.equal((await pausedAtTwo).id, 'two')
        console.log('Condition breakpoint: count == 2 pauses at tick 4 with the watch values of that tick.')

        // Run to the next breakpoint: tick 5 count 3, tick 6 enters Full (and terminates to Finished).
        const stops = []
        const runDone = new Promise(resolve => {
            waiters.add({ method: 'keith/simulation/didStep', accept: params => { stops.push(params); return !!params.breakpoint }, resolve })
        })
        await connection.sendNotification('keith/simulation/runToBreakpoint', { maxSteps: 50 })
        await Promise.race([runDone, new Promise((_, reject) => setTimeout(() => reject(new Error(`runToBreakpoint hung\n${stderr}`)), 40000))])
        assert.equal(stops.length, 2, JSON.stringify(stops.map(stop => stop.step)))
        assert.equal(stops[0].step, 5)
        assert.equal(stops[0].values.count, 3)
        assert.equal(stops[1].step, 6)
        assert.equal(stops[1].values.done, true)
        assert.equal(stops[1].breakpoint?.id, 'full', JSON.stringify(stops[1].breakpoint))
        assert.match(stops[1].breakpoint.label, /Counter\.Counting\.Full/)
        ticks.push(stops[0], stops[1])
        console.log('State breakpoint: run to breakpoint stops when Full is entered, reporting every tick on the way.')

        // Disabled breakpoints never fire (Tick was entered at tick 2 and re-entered every count).
        const tick7 = await step()
        assert.equal(tick7.step, 7)
        assert.equal(tick7.values.done, true, JSON.stringify(outputs(tick7.values)))
        assert.equal(tick7.breakpoint, undefined)
        ticks.push(tick7)

        // History holds every tick so far, oldest first.
        const history = await connection.sendRequest('keith/simulation/history')
        assert.equal(history.step, 7)
        assert.deepEqual(history.steps.map(entry => entry.step), [1, 2, 3, 4, 5, 6, 7])
        assert.deepEqual(history.steps.map(entry => entry.pool.count), [0, 0, 1, 2, 3, 3, 3])
        console.log('History: seven pools with the counts of each tick.')

        // Rewind to tick 3 by replaying the recorded inputs; the pool must equal the earlier tick's.
        const rewoundMessage = waitFor('keith/simulation/didStep', message => message.rewound)
        const rewind = await connection.sendRequest('keith/simulation/stepBack', { toStep: 3 })
        assert.ok(rewind.ok, rewind.message)
        assert.equal(rewind.step, 3)
        const rewound = await rewoundMessage
        assert.equal(rewound.step, 3)
        assert.deepEqual(computed(rewound.values), computed(ticks[2].values))
        assert.equal(values(rewound).w1, 10)
        assert.equal(values(rewound).w3, true, 'pre() sees the replayed previous tick')
        // Stepping forward again reproduces the original tick 4, including its breakpoint.
        const again = await step()
        assert.equal(again.step, 4)
        assert.deepEqual(computed(again.values), computed(ticks[3].values))
        assert.equal(again.breakpoint?.id, 'two')
        const afterRewind = await connection.sendRequest('keith/simulation/history')
        assert.deepEqual(afterRewind.steps.map(entry => entry.step), [1, 2, 3, 4])
        console.log(`Rewind: replayed 3 ticks in ${rewind.replayMs} ms; the pool matches and tick 4 repeats exactly.`)

        // Rewinding to the initial state works too, and the first tick repeats.
        const toStart = waitFor('keith/simulation/didStep', message => message.rewound)
        assert.ok((await connection.sendRequest('keith/simulation/stepBack', { toStep: 0 })).ok)
        assert.equal((await toStart).step, 0)
        const firstAgain = await step({ start: true })
        assert.deepEqual(computed(firstAgain.values), computed(ticks[0].values))
        assert.equal(firstAgain.step, 1)

        // Breakpoints replaced while running are validated against the running model.
        const ambiguous = await connection.sendRequest('keith/simulation/setBreakpoints', { breakpoints: [{ id: 'q', kind: 'state', state: 'Counting.Tick', enabled: true }] })
        assert.ok(ambiguous.accepted[0].ok, JSON.stringify(ambiguous))
        // A state that merely stays active is not entered again: Counting was entered at tick 1 and only its
        // child Tick is re-entered by the count loop.
        const active = await connection.sendRequest('keith/simulation/setBreakpoints', { breakpoints: [{ id: 'counting', kind: 'state', state: 'Counting', enabled: true }] })
        assert.ok(active.accepted[0].ok, JSON.stringify(active))
        const entered = await step({ start: true })
        assert.equal(entered.step, 2)
        assert.equal(entered.breakpoint && entered.breakpoint.id, 'counting', 'tick 2 enters Counting')
        const stillCounting = await step({ start: true })
        assert.equal(stillCounting.step, 3)
        assert.equal(stillCounting.breakpoint, undefined, 'an active state must not count as entered every tick')
        console.log('State breakpoints fire on entry only, not while the state stays active.')
        const stopped = await connection.sendRequest('keith/simulation/stop')
        assert.ok(stopped.successful)
        assert.ok(!/NullPointerException|ConcurrentModificationException|Exception in thread/.test(stderr), stderr)
        console.log('Simulation debug passed: breakpoints, watches, run to breakpoint, history and rewind.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        // The server's working directory is the workspace; on Windows it cannot be removed while the process lives.
        await exited
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
}

main().catch(error => { console.error(error); process.exit(1) })
