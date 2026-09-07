const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

class EventEmitter {
    handlers = new Set()
    event = (handler) => {
        this.handlers.add(handler)
        return { dispose: () => this.handlers.delete(handler) }
    }
    fire(value) { for (const handler of this.handlers) handler(value) }
    dispose() { this.handlers.clear() }
}

function deferred() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

function setup(t) {
    const commands = new Map()
    const sent = []
    const notifications = new Map()
    const state = new EventEmitter()
    const noop = () => {}
    const vscode = {
        EventEmitter,
        StatusBarAlignment: { Left: 0 },
        Uri: { parse: (uri) => ({ toString: () => uri, path: new URL(uri).pathname }) },
        commands: {
            registerCommand: (id, handler) => { commands.set(id, handler); return { dispose: noop } },
            executeCommand: async (id, ...args) => commands.get(id)?.(...args),
        },
        window: {
            createOutputChannel: () => ({ appendLine: noop, dispose: noop }),
            createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showQuickPick: async (items) => items[0],
        },
    }
    const client = {
        start: async () => {},
        onNotification: (name, handler) => { notifications.set(name, handler); return { dispose: noop } },
        onDidChangeState: state.event,
        sendNotification: async (name, params) => { sent.push({ name, params }) },
        sendRequest: async () => ({ successful: true }),
    }
    const compiler = {
        newSimulationCommands: new EventEmitter().event,
        compilationStarted: new EventEmitter().event,
        compilationFinished: new EventEmitter().event,
        lastCompiledUri: 'file:///models/clock.sctx',
        editor: { document: { uri: vscode.Uri.parse('file:///models/clock.sctx'), isDirty: false } },
        compile: async () => {},
    }
    const load = createLoader({ vscode, 'vscode-languageclient/node': { State: { Stopped: 1 } }, '@kieler/table-webview/lib/table-webview': {} })
    const { SimulationTableDataProvider } = load('src/simulation/simulation-table-data-provider.ts')
    const settings = { get: (key) => key === 'simulationStepDelay' ? 1 : 'Manual' }
    const sim = new SimulationTableDataProvider(client, compiler, { subscriptions: [] }, settings)
    t.after(() => sim.dispose())
    const started = { successful: true, dataPool: { input: false, output: 0 }, propertySet: { input: ['input'], output: ['output'] } }
    const start = async () => { await sim.simulate(); await sim.handleSimulationStarted(started) }
    return { sim, client, compiler, sent, commands, started, start, state }
}

test('simulation starts without ever opening the sidebar and deduplicates starts', async (t) => {
    const { sim, sent, started } = setup(t)
    await Promise.all([sim.simulate(), sim.simulate()])
    assert.equal(sent.length, 1)
    await sim.handleSimulationStarted(started)
    assert.equal(sim.phase, 'running')
    assert.equal(sim.simulationStep, 0)
})

test('a tick preserves input edits made while waiting for its response', async (t) => {
    const { sim, sent, start } = setup(t)
    await start()
    const input = sim.simulationData.get('input')
    sim.setInputValue(input, true)
    const tick = sim.executeSimulationStep()
    sim.setInputValue(input, false)
    const duplicate = sim.executeSimulationStep()
    assert.equal(sent.filter((message) => message.name.endsWith('/step')).length, 1)
    sim.handleStepMessage({ values: { input: true, output: 1 } })
    await Promise.all([tick, duplicate])
    assert.equal(sim.valuesForNextStep.get('input'), false)
    assert.equal(sim.changedValuesForNextStep.has('input'), true)
    const next = sim.executeSimulationStep()
    assert.equal(sent.at(-1).params.valuesForNextStep.input, false)
    sim.handleStepMessage({ values: { input: false, output: 2 } })
    await next
    assert.deepEqual(input.data, [true, false])
})

test('stopping deduplicates requests and ignores late ticks and start replies', async (t) => {
    const { sim, client, start, started } = setup(t)
    await start()
    const response = deferred()
    let stops = 0
    client.sendRequest = () => { stops++; return response.promise }
    const first = sim.stopSimulation()
    const second = sim.stopSimulation()
    assert.equal(sim.phase, 'stopping')
    assert.equal(sim.handleStepMessage({ values: { unknown: true } }), false)
    await sim.handleSimulationStarted(started)
    assert.equal(sim.phase, 'stopping')
    response.resolve({ successful: true })
    await Promise.all([first, second])
    assert.equal(stops, 1)
    assert.equal(sim.phase, 'idle')
    assert.equal(sim.simulationData.size, 0)
    assert.equal(sim.changedValuesForNextStep.size, 0)
})

test('restart waits for stop and keeps the original model after another file compiles', async (t) => {
    const { sim, client, compiler, sent, start } = setup(t)
    await start()
    compiler.lastCompiledUri = 'file:///models/another.sctx'
    const response = deferred()
    client.sendRequest = () => response.promise
    const restart = sim.restartSimulation()
    assert.equal(sent.length, 1)
    response.resolve({ successful: true })
    await restart
    assert.equal(sent.at(-1).params.uri, 'file:///models/clock.sctx')
})

test('failed stop prevents restart from starting another server simulation', async (t) => {
    const { sim, client, sent, start } = setup(t)
    await start()
    client.sendRequest = async () => ({ successful: false, message: 'busy' })
    await assert.rejects(sim.restartSimulation(), /busy/)
    assert.equal(sent.length, 1)
    assert.match(sim.lastError, /could not be stopped/)
})

test('server reset cancels a start waiting for the client and clears queued values', async (t) => {
    const { sim, client, sent } = setup(t)
    const ready = deferred()
    client.start = () => ready.promise
    const starting = sim.simulate()
    sim.changedValuesForNextStep.set('old', true)
    sim.compilingSimulation = true
    sim.resetForRestart()
    ready.resolve()
    await starting
    assert.equal(sent.length, 0)
    assert.equal(sim.compilingSimulation, false)
    assert.equal(sim.changedValuesForNextStep.size, 0)
    assert.equal(sim.phase, 'idle')
})

test('snapshot compilation sets the simulation start flag before compilation begins', async (t) => {
    const { sim, compiler } = setup(t)
    sim.registerSimulationCommands({ systems: [], snapshotSystems: [{ id: 'sim', label: 'Sim', snapshotSystem: true }] })
    let args
    compiler.compile = async (...values) => { assert.equal(sim.compilingSimulation, true); args = values }
    await sim.compileAndSimulate(true)
    assert.deepEqual(args, ['sim', true, false, true, 'file:///models/clock.sctx'])
})

test('partial tick data keeps every variable aligned to the same tick', async (t) => {
    const { sim, start } = setup(t)
    await start()
    sim.handleStepMessage({ values: { input: true, output: 1 } })
    sim.handleStepMessage({ values: { output: 2 } })
    assert.deepEqual(sim.simulationData.get('input').data, [true, true])
    assert.deepEqual(sim.simulationData.get('output').data, [1, 2])
})

test('Run and Pause commands are idempotent and never send ticks without an active simulation', async (t) => {
    const { sim, sent, start, commands } = setup(t)
    await commands.get('keith-vscode.simulation-run')()
    assert.equal(sent.length, 0)
    await start()
    const running = commands.get('keith-vscode.simulation-run')()
    await commands.get('keith-vscode.simulation-run')()
    await commands.get('keith-vscode.simulation-pause')()
    await commands.get('keith-vscode.simulation-pause')()
    assert.equal(sim.play, false)
    sim.handleStepMessage({ values: { input: false, output: 1 } })
    await running
    assert.equal(sent.filter((message) => message.name.endsWith('/step')).length, 1)
})

test('a server reset during restart cannot revive the old model', async (t) => {
    const { sim, client, sent, start } = setup(t)
    await start()
    const response = deferred()
    client.sendRequest = () => response.promise
    const restarting = sim.restartSimulation()
    sim.resetForRestart()
    response.resolve({ successful: true })
    await restarting
    assert.equal(sent.length, 1)
    assert.equal(sim.phase, 'idle')
})

test('controls and input edits are rejected while stop is pending', async (t) => {
    const { sim, client, sent, start } = setup(t)
    await start()
    const input = sim.simulationData.get('input')
    const response = deferred()
    client.sendRequest = () => response.promise
    const stopping = sim.stopSimulation()
    sim.setInputValue(input, true)
    await sim.executeSimulationStep()
    assert.equal(sim.changedValuesForNextStep.size, 0)
    assert.equal(sent.length, 1)
    response.resolve({ successful: true })
    await stopping
})

test('external inputs update the view without overwriting local queued edits', async (t) => {
    const { sim, start } = setup(t)
    await start()
    sim.handleExternalNewUserValue({ input: true })
    assert.equal(sim.valuesForNextStep.get('input'), true)
    sim.setInputValue(sim.simulationData.get('input'), false)
    sim.handleExternalNewUserValue({ input: true })
    assert.equal(sim.valuesForNextStep.get('input'), false)
    sim.setInputValue(sim.simulationData.get('input'), 'invalid')
    assert.equal(sim.valuesForNextStep.get('input'), false)
})

test('failed tick data cannot become a successful history entry', async (t) => {
    const { sim, start } = setup(t)
    await start()
    const pending = sim.executeSimulationStep()
    assert.equal(sim.handleStepMessage({ successful: false, error: 'crashed', values: {} }), false)
    await pending
    assert.equal(sim.phase, 'idle')
    assert.match(sim.lastError, /crashed/)
})

test('counterexample readiness waits for simulation startup and terminates on failure', async (t) => {
    const { sim, started } = setup(t)
    await sim.simulate()
    let complete = false
    const ready = sim.waitForRunning().then((value) => { complete = true; return value })
    await Promise.resolve()
    assert.equal(complete, false)
    await sim.handleSimulationStarted(started)
    assert.equal(await ready, true)
    sim.resetForRestart()
    await sim.simulate()
    const failed = sim.waitForRunning()
    await sim.handleSimulationStarted({ successful: false, error: 'compile failed' })
    assert.equal(await failed, false)
})

test('uninitialized strings are registered from the interface and accept their first input and output values', async (t) => {
    const { sim, sent } = setup(t)
    await sim.simulate()
    await sim.handleSimulationStarted({
        successful: true,
        dataPool: { '#interface': {
            timeout_update_vals: { type: 'string', properties: ['input'] },
            echoed: { type: 'string', properties: ['output'] },
        } },
        propertySet: { input: ['timeout_update_vals'], output: ['echoed'] },
    })
    const input = sim.simulationData.get('timeout_update_vals')
    assert.ok(input)
    assert.equal(input.input, true)
    assert.equal(sim.isVisible(input), true)
    assert.equal(sim.simulationData.get('echoed').output, true)
    assert.equal(sim.valuesForNextStep.get(input.id), '')
    assert.equal(sim.changedValuesForNextStep.size, 0, 'Displaying an unset string must not send a default')
    sim.setInputValue(input, 42)
    assert.equal(sim.changedValuesForNextStep.size, 0)
    const packet = '10,20,30,40,50,60\n'
    sim.setInputValue(input, packet)
    const step = sim.executeSimulationStep()
    assert.equal(sent.at(-1).params.valuesForNextStep.timeout_update_vals, packet)
    assert.equal(sim.handleStepMessage({ values: { timeout_update_vals: packet, echoed: packet } }), true)
    await step
    assert.equal(sim.phase, 'running')
    assert.deepEqual(sim.simulationData.get('echoed').data, [packet])
})

test('null strings and string arrays stay editable across server updates without replacing queued edits', async (t) => {
    const { sim } = setup(t)
    await sim.simulate()
    await sim.handleSimulationStarted({
        successful: true,
        dataPool: { text: null, messages: [null, 'initial'], '#interface': {
            text: { type: 'string' }, messages: { type: 'string' },
        } },
        propertySet: { input: ['text', 'messages'] },
    })
    assert.equal(sim.valuesForNextStep.get('text'), '')
    assert.deepEqual(sim.valuesForNextStep.get('messages'), ['', 'initial'])
    sim.setInputValue(sim.simulationData.get('messages'), ['one', 'two'])
    assert.deepEqual(sim.valuesForNextStep.get('messages'), ['one', 'two'])
    sim.handleExternalNewUserValue({ text: 'external', messages: [null, null] })
    assert.deepEqual(sim.valuesForNextStep.get('messages'), ['one', 'two'])
    sim.handleStepMessage({ values: { text: null } })
    assert.equal(sim.valuesForNextStep.get('text'), '')
    sim.setInputValue(sim.simulationData.get('text'), 'next')
    sim.handleStepMessage({ values: { text: null } })
    assert.equal(sim.valuesForNextStep.get('text'), 'next')
})
