// Live diagnostics: the server analyses an open .sctx document after every edit, debounced, and
// publishes located issues as keith/diagnostics/live without a compile request.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const { java, serverArgs, sameFile } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-live-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const live = []
    const waiters = new Set()
    connection.onNotification((method, params) => {
        if (method === 'keith/diagnostics/live') live.push(params)
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 60000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}`)) }, timeout)
        waiters.add(waiter)
    })
    const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 240000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('keith/diagnostics/configure', { enabled: true, debounceMs: 150 })

        const demo = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
        const file = path.join(workspace, 'live.sctx')
        fs.writeFileSync(file, demo)
        const uri = pathToFileURL(file).href
        let version = 1
        const forUri = params => sameFile(params.uri, uri)

        // Opening the broken demo is enough: no compile request is ever sent in this suite.
        const opened = waitFor('keith/diagnostics/live', params => forUri(params) && params.issues.length > 0)
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version, text: demo } })
        const first = await opened
        const cold = first.durationMs
        assert.equal(first.version, 1)
        const cycles = first.issues.filter(issue => issue.code === 'scheduling-cycle')
        assert.equal(cycles.length, 1, JSON.stringify(first.issues.map(i => [i.code, i.message])))
        assert.match(cycles[0].message, /^Circular dependency involving timeout_update prevents scheduling this tick\.$/)
        assert.ok(cycles[0].hint, 'The scheduler owns the hint')
        for (const location of cycles[0].locations) {
            assert.equal(demo.slice(location.offset, location.offset + location.length).trim().replace(/\s+/g, ' '), location.label)
        }
        assert.ok(cycles[0].locations.some(l => l.label === 'timeout_update = false'))
        assert.ok(cycles[0].locations.some(l => l.label === 'timeout_update = true'))
        const loops = first.issues.filter(issue => issue.code === 'instantaneous-loop')
        assert.ok(loops.length > 0 && loops.every(loop => loop.locations.length > 0 && /^Potential instantaneous loop/.test(loop.message)), JSON.stringify(loops))
        assert.ok(first.issues.every(issue => issue.locations.length > 0), 'Live issues are always located')
        assert.ok(!first.issues.some(issue => issue.code === 'compiler' && /Can't schedule|NOT asc-schedulable|Instantaneous loop detected/.test(issue.message)), 'Legacy texts stay suppressed')
        console.log(`Live: scheduling cycle and loops reported on open without compiling (cold ${cold} ms).`)

        // Removing the conflicting write clears the cycle; the analysis reports the fixed version.
        const fix = demo.replace('timeout_update = false;', '')
        const change = (text) => {
            version++
            return connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
        }
        const fixed = waitFor('keith/diagnostics/live', params => forUri(params) && params.version === 2)
        await change(fix)
        const second = await fixed
        assert.equal(second.issues.filter(issue => issue.code === 'scheduling-cycle').length, 0, JSON.stringify(second.issues.map(i => i.message)))
        const warm = second.durationMs
        console.log(`Live: removing the write clears the cycle (warm ${warm} ms).`)

        // Reintroduce it, then fix it again in a burst of edits: only the last version is reported.
        live.length = 0
        const last = version + 3
        const burstDone = waitFor('keith/diagnostics/live', params => forUri(params) && params.version === last, 90000)
        await change(demo)
        await settle(20)
        await change(demo.replace('bool timeout_update = false', 'bool timeout_update = false // edited'))
        await settle(20)
        await change(fix)
        await burstDone
        await settle(Math.max(1500, warm * 2))
        const versions = live.filter(forUri).map(params => params.version)
        assert.deepEqual(versions, [version], `Only the latest edit of a burst is analysed, got ${JSON.stringify(versions)}`)
        assert.equal(live.filter(forUri).at(-1).issues.filter(issue => issue.code === 'scheduling-cycle').length, 0)
        console.log('Live: a burst of edits yields one result, for the last version.')

        // A document that no longer parses gets no live issues (Xtext reports the syntax error itself).
        const brokenVersion = version + 1
        const broken = waitFor('keith/diagnostics/live', params => forUri(params) && params.version === brokenVersion)
        await change(demo.replace('scchart', 'sccha rt'))
        const syntax = await broken
        assert.deepEqual(syntax.issues, [])
        assert.equal(syntax.reason, 'syntax')
        console.log('Live: a syntax-broken document clears live issues instead of guessing.')

        // Disabled: the next edit produces nothing; enabled again: it does.
        await connection.sendNotification('keith/diagnostics/configure', { enabled: false })
        live.length = 0
        await change(demo)
        await settle(Math.max(2000, cold + 500))
        assert.ok(!live.some(params => forUri(params) && params.issues.length > 0), 'No analysis while disabled')
        await connection.sendNotification('keith/diagnostics/configure', { enabled: true })
        const again = waitFor('keith/diagnostics/live', params => forUri(params) && params.issues.length > 0)
        await connection.sendNotification('keith/diagnostics/analyze', uri)
        await again
        console.log('Live: configure toggles the analysis; analyze runs it on demand.')

        // Analyzers other than the scheduler report structured, located issues with their own hints.
        async function openFixture(name) {
            const text = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
            const other = path.join(workspace, name)
            fs.writeFileSync(other, text)
            const otherUri = pathToFileURL(other).href
            const result = waitFor('keith/diagnostics/live', params => sameFile(params.uri, otherUri) && params.reason !== 'syntax' && params.version === 1)
            await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: otherUri, languageId: 'sctx', version: 1, text } })
            const params = await result
            await connection.sendNotification('textDocument/didClose', { textDocument: { uri: otherUri } })
            return { text, issues: params.issues }
        }
        const clock = await openFixture('shared-clock.sctx')
        const shared = clock.issues.filter(issue => issue.code === 'shared-clock')
        assert.ok(shared.length >= 1, JSON.stringify(clock.issues.map(i => [i.code, i.message])))
        assert.match(shared[0].message, /Clock t is read by several concurrent regions of SharedClock\./)
        assert.ok(shared[0].hint.includes('one clock per region'), shared[0].hint)
        assert.ok(shared[0].locations.some(l => clock.text.slice(l.offset, l.offset + l.length).startsWith('scchart SharedClock')), JSON.stringify(shared[0].locations))
        assert.ok(shared[0].locations.some(l => l.label === 't = 0'), 'The clock declaration is a related location')
        assert.ok(!clock.issues.some(issue => issue.code === 'compiler' && /Cannot handle/.test(issue.message)), 'No duplicate bare text')
        console.log('Timed automata: a shared clock is a located issue with the transformation\'s hint.')

        const inherited = await openFixture('inherited-clash.sctx')
        const conflicts = inherited.issues.filter(issue => issue.code === 'inheritance-conflict')
        assert.ok(conflicts.length >= 1, JSON.stringify(inherited.issues.map(i => [i.code, i.message])))
        assert.ok(conflicts.some(issue => /Variable shared is declared again|Region Main exists more than once/.test(issue.message)), JSON.stringify(conflicts.map(i => i.message)))
        assert.ok(conflicts.every(issue => issue.locations.length > 0 && issue.hint))
        console.log('Inheritance: redeclared variables and regions are located issues with hints.')

        // Closing the document clears the live issues.
        const closed = waitFor('keith/diagnostics/live', params => forUri(params) && params.issues.length === 0)
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
        await closed
        assert.ok(!/NullPointerException|ConcurrentModificationException/.test(stderr), stderr)
        console.log(`Live diagnostics passed: cold ${cold} ms, warm ${warm} ms on broken-demo.sctx.`)
    } finally {
        clearTimeout(watchdog)
        try { await connection.sendRequest('shutdown') } catch { /* server gone */ }
        connection.sendNotification('exit')
        connection.dispose()
        server.kill()
        // The server's working directory is the workspace; on Windows it cannot be removed while the process lives.
        await exited
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
}

main().catch(error => { console.error(error); process.exit(1) })
