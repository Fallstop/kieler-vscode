// Cursor-to-diagram sync through the real protocol: keith/diagram/cursor expands the diagram to the element
// under the editor cursor, selects it, and refuses while the diagram shows a compilation snapshot.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const CLIENT = 'keith-diagram_sprotty'

/** Every SModel element with a trace, keyed by the URI fragment of its source element. */
function elementsByFragment(root) {
    const result = new Map()
    const visit = element => {
        if (typeof element.trace === 'string') {
            const fragment = element.trace.slice(element.trace.indexOf('#') + 1)
            result.set(fragment, [...(result.get(fragment) ?? []), element])
        }
        element.children?.forEach(visit)
    }
    visit(root)
    return result
}

function childNodes(element) {
    return (element.children ?? []).filter(child => child.type === 'node')
}

async function main() {
    const { java, serverArgs } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-cursor-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const threads = () => (spawnSync('jstack', [String(server.pid)], { encoding: 'utf8' }).stdout || '').trim()
    const waiters = new Set()
    const received = []
    connection.onNotification((method, params) => {
        received.push({ method, params })
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 40000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}\n${threads()}`)) }, timeout)
        waiters.add(waiter)
    })
    const isModel = message => !!message.action?.newRoot
    const isSelect = message => message.action?.kind === 'elementSelected'
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const text = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
        const file = path.join(workspace, 'demo.sctx')
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })

        const ready = waitFor('diagram/accept', isModel)
        await connection.sendNotification('diagram/accept', { clientId: CLIENT, action: { kind: 'requestModel', requestId: 'source', options: { sourceUri: uri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } })
        let model = (await ready).action.newRoot
        // Sprotty's protocol wraps the root; the first request is answered before every handler settled.
        await new Promise(resolve => setTimeout(resolve, 500))

        // 1. Cursor in EW_Phase with mode expand: NS_Phase's region is off the path and gets collapsed.
        const ewOffset = text.indexOf('leds = {0, 0, 1, 1, 0, 0}')
        assert.ok(ewOffset > 0)
        let updated = waitFor('diagram/accept', isModel)
        let selected = waitFor('diagram/accept', isSelect)
        const expand = await connection.sendRequest('keith/diagram/cursor', { uri, offset: ewOffset, clientId: CLIENT, mode: 'expand' })
        assert.equal(expand.ok, true, JSON.stringify(expand))
        assert.equal(expand.element.kind, 'State')
        assert.equal(expand.element.name, 'green_early')
        assert.ok(expand.collapsed >= 1, `collapsed ${expand.collapsed}`)
        model = (await updated).action.newRoot
        let byFragment = elementsByFragment(model)
        const nsPhase = byFragment.get(expand.element.id.replace(/\/@regions\.0\/@states\.1.*$/, '/@regions.0/@states.0'))
        assert.ok(nsPhase && nsPhase.length, 'NS_Phase is in the diagram')
        // A state node holds its region nodes; a collapsed region has no state children.
        const nsRegion = () => childNodes(byFragment.get(nsPhase[0].trace.slice(nsPhase[0].trace.indexOf('#') + 1))[0])[0]
        assert.ok(nsRegion(), 'NS_Phase has a region node')
        assert.equal(childNodes(nsRegion()).length, 0, 'NS_Phase\'s region is collapsed after focusing EW_Phase')
        const ewNode = byFragment.get(expand.element.id)
        assert.ok(ewNode && ewNode.length, 'green_early of EW_Phase is in the diagram')
        const selection = (await selected).action
        assert.ok(selection.selectedElementsIDs.includes(ewNode[0].id), JSON.stringify(selection))
        console.log(`Expand mode: ${expand.element.kind} ${expand.element.name}, ${expand.expanded} expanded, ${expand.collapsed} collapsed, selected in the diagram.`)

        // 2. Cursor inside NS_Phase with mode focus: the collapsed region is expanded again, nothing else is collapsed.
        const nsOffset = text.indexOf('c_walk = 0;')
        updated = waitFor('diagram/accept', isModel)
        selected = waitFor('diagram/accept', isSelect)
        const focus = await connection.sendRequest('keith/diagram/cursor', { uri, offset: nsOffset, clientId: CLIENT, mode: 'focus' })
        assert.equal(focus.ok, true, JSON.stringify(focus))
        assert.equal(focus.element.name, 'green_walk')
        assert.ok(focus.expanded >= 1, `expanded ${focus.expanded}`)
        assert.equal(focus.collapsed, 0)
        model = (await updated).action.newRoot
        byFragment = elementsByFragment(model)
        assert.ok(childNodes(nsRegion()).length > 0, 'NS_Phase\'s region is expanded again')
        const walkNode = byFragment.get(focus.element.id)
        assert.ok(walkNode && walkNode.length, 'green_walk is in the diagram')
        assert.ok((await selected).action.selectedElementsIDs.includes(walkNode[0].id))
        console.log(`Focus mode: ${focus.element.name} expanded (${focus.expanded}) and selected.`)

        // 3. A transition is selectable but expands nothing new; a declaration maps to the root state.
        const transitionOffset = text.indexOf('if EW_ped_request go to green_walk')
        const transition = await connection.sendRequest('keith/diagram/cursor', { uri, offset: transitionOffset, clientId: CLIENT, mode: 'focus' })
        assert.equal(transition.ok, true, JSON.stringify(transition))
        assert.equal(transition.element.kind, 'Transition')
        const declarationOffset = text.indexOf('input bool NS_raised')
        const declaration = await connection.sendRequest('keith/diagram/cursor', { uri, offset: declarationOffset, clientId: CLIENT, mode: 'focus' })
        assert.equal(declaration.ok, true, JSON.stringify(declaration))
        assert.equal(declaration.element.kind, 'State')
        assert.equal(declaration.element.name, 'timeout_controller_A')
        assert.equal(declaration.expanded, 0)
        console.log('Transitions select their edge; declarations resolve to the root state without expanding.')

        // 4. Bad input is refused, not crashed on.
        const outside = await connection.sendRequest('keith/diagram/cursor', { uri, offset: text.length + 10, clientId: CLIENT, mode: 'focus' })
        assert.equal(outside.ok, false)
        const noDiagram = await connection.sendRequest('keith/diagram/cursor', { uri, offset: nsOffset, clientId: 'nobody', mode: 'focus' })
        assert.equal(noDiagram.ok, false)
        assert.match(noDiagram.message, /No diagram/)

        // 5. Reverse direction: selecting in the diagram reveals the source once the client asks for it.
        await connection.sendNotification('keith/preferences/setPreferences', { 'diagram.shouldSelectText': true })
        const opened = waitFor('diagram/openInTextEditor')
        await connection.sendNotification('diagram/accept', { clientId: CLIENT, action: { kind: 'elementSelected', selectedElementsIDs: [walkNode[0].id], deselectedElementsIDs: [] } })
        const location = (await opened).location
        assert.equal(location.range.start.line, text.slice(0, text.indexOf('state green_walk {')).split('\n').length - 1)
        console.log('Diagram selection reveals the state in the editor.')

        // 6. While a compilation snapshot is shown the cursor is ignored.
        const compiled = waitFor('keith/kicool/didCompile', result => result.finished)
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.extended.core', clientId: CLIENT, inplace: false, showResultingModel: false, snapshot: false })
        await compiled
        const shown = waitFor('diagram/accept', isModel)
        assert.equal(await connection.sendRequest('keith/kicool/show', { uri, clientId: CLIENT, index: 0 }), 'OK')
        await shown
        const snapshot = await connection.sendRequest('keith/diagram/cursor', { uri, offset: nsOffset, clientId: CLIENT, mode: 'focus' })
        assert.equal(snapshot.ok, false, JSON.stringify(snapshot))
        assert.match(snapshot.message, /snapshot/)
        // Showing the source model again (index -1 parses a fresh copy) follows the cursor through URI fragments.
        const source = waitFor('diagram/accept', isModel)
        assert.equal(await connection.sendRequest('keith/kicool/show', { uri, clientId: CLIENT, index: -1 }), 'OK')
        await source
        const again = await connection.sendRequest('keith/diagram/cursor', { uri, offset: nsOffset, clientId: CLIENT, mode: 'focus' })
        assert.equal(again.ok, true, JSON.stringify(again))
        assert.equal(again.element.name, 'green_walk')
        console.log('Snapshots are left alone; the re-shown source model follows the cursor again.')

        assert.ok(!/NullPointerException|ConcurrentModificationException/.test(stderr), stderr)
        console.log('Cursor sync passed.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
    }
}

main().catch(error => { console.error(error); process.exit(1) })
