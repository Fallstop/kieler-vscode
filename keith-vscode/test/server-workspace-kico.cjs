// Compilation systems defined by .kico files in the workspace: loaded at start, listed with their source file,
// usable for compilation, validated with diagnostics on the file, replaced on edit and dropped on delete.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const GOOD = [
    'public system my.custom',
    '    label "My Custom C"',
    '    system de.cau.cs.kieler.sccharts.netlist',
    '',
].join('\n')
const BAD = 'public system my.bad label "Bad" {\n'
const UNKNOWN_PROCESSOR = 'public system my.unknown label "Unknown" de.cau.cs.kieler.does.not.exist\n'
const DUPLICATE = 'public system de.cau.cs.kieler.sccharts.netlist label "Shadow" system de.cau.cs.kieler.sccharts.netlist\n'

async function main() {
    const { classpath, java, serverArgs, sameFile } = require('./server-launch.cjs')
    assert.ok(fs.existsSync(classpath), 'The language server JAR is required; run npm run build:server')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-kico-'))
    const write = (relative, text) => {
        const file = path.join(workspace, relative)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, text)
        return pathToFileURL(file).href
    }
    const good = write('kico/my.kico', GOOD)
    const bad = write('kico/bad.kico', BAD)
    const unknown = write('kico/unknown.kico', UNKNOWN_PROCESSOR)
    const duplicate = write('kico/duplicate.kico', DUPLICATE)
    const root = write('root.kico', 'public system my.root label "Root level" system de.cau.cs.kieler.sccharts.netlist\n')
    // The file the "New compilation system" command creates must load as is.
    const { SYSTEM_TEMPLATE } = require('./load-typescript.cjs')({ vscode: { QuickPickItemKind: {}, workspace: {}, window: {}, commands: {} }, 'vscode-languageclient/node': {} })('src/kico/workspace-systems.ts')
    write('kico/template.kico', SYSTEM_TEMPLATE('my.template'))
    write('node_modules/ignored/ignored.kico', 'public system my.ignored label "Ignored" system de.cau.cs.kieler.sccharts.netlist\n')
    const outside = fs.mkdtempSync(path.join(tmpdir(), 'kieler-kico-shared-'))
    fs.writeFileSync(path.join(outside, 'team.kico'), 'public system team.shared label "Team system" system de.cau.cs.kieler.sccharts.netlist\n')
    const model = write('kico/model.sctx', fs.readFileSync(path.join(__dirname, 'fixtures/audit.sctx'), 'utf8'))

    const server = spawn(java, serverArgs, { cwd: workspace })
    const closed = new Promise((resolve) => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    const diagnostics = new Map()
    connection.onNotification((method, params) => {
        if (method === 'textDocument/publishDiagnostics') diagnostics.set(params.uri, params.diagnostics)
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', (params) => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: (params) => { clearTimeout(timer); waiters.delete(waiter); resolve(params) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${method}\n${stderr}`)) }, 40000)
        waiters.add(waiter)
    })
    const diagnosticsOf = (uri) => [...diagnostics.entries()].find(([key]) => sameFile(key, uri))?.[1]
    const systemsFor = async (uri) => {
        const ready = waitFor('keith/kicool/compilation-systems')
        await connection.sendNotification('keith/kicool/get-systems', uri)
        return (await ready).systems
    }
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 170000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: 'workspace' }] })
        await connection.sendNotification('initialized', {})

        // Start: every .kico in the workspace is loaded once the initial build ran; failures are reported, not skipped.
        const initial = await waitFor('keith/kicool/systemsChanged', (params) => params.added.some((entry) => entry.id === 'my.custom'))
        assert.deepEqual(initial.added.map((entry) => entry.id).sort(), ['my.custom', 'my.root', 'my.template'])
        assert.deepEqual(initial.errors.map((entry) => path.basename(entry.file)).sort(), ['bad.kico', 'duplicate.kico', 'unknown.kico'])
        assert.ok(diagnosticsOf(bad).some((d) => d.severity === 1), 'Syntax errors reach the .kico file as diagnostics')
        const unknownDiagnostic = diagnosticsOf(unknown)[0]
        assert.match(unknownDiagnostic.message, /Unknown processor 'de.cau.cs.kieler.does.not.exist'/)
        assert.equal(unknownDiagnostic.range.start.line, 0)
        assert.equal(UNKNOWN_PROCESSOR.slice(unknownDiagnostic.range.start.character, unknownDiagnostic.range.end.character), 'de.cau.cs.kieler.does.not.exist')
        assert.match(diagnosticsOf(duplicate)[0].message, /built-in compilation system/)
        assert.deepEqual(diagnosticsOf(good), [])
        console.log('Start: workspace systems loaded, root-level file included, node_modules ignored, broken files diagnosed.')

        // Listing: workspace systems carry their source file; the compile menu can group them.
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: model, languageId: 'sctx', version: 1, text: fs.readFileSync(path.join(__dirname, 'fixtures/audit.sctx'), 'utf8') } })
        let systems = await systemsFor(model)
        const custom = systems.find((system) => system.id === 'my.custom')
        assert.ok(custom, JSON.stringify(systems.map((system) => system.id)))
        assert.equal(custom.label, 'My Custom C')
        assert.ok(sameFile(custom.source, good), custom.source)
        assert.ok(systems.find((system) => system.id === 'my.root'))
        assert.ok(!systems.find((system) => system.id === 'my.ignored'), 'node_modules is not scanned')
        assert.ok(systems.filter((system) => !system.source).length > 10, 'Built-in systems are still there')
        console.log('Listing: workspace systems appear with their source file next to the built-in ones.')

        // Compiling with a workspace system runs the referenced built-in chain to the end.
        const compiled = waitFor('keith/kicool/didCompile', (params) => params.finished && sameFile(params.uri, model))
        await connection.sendNotification('keith/kicool/compile', { uri: model, command: 'my.custom', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await compiled
        const stages = result.results.files.flat()
        assert.deepEqual(stages.flatMap((stage) => stage.errors ?? []), [])
        assert.ok(stages.some((stage) => /C Code/i.test(stage.name)), stages.map((stage) => stage.name).join(', '))
        console.log('Compile: a workspace system that includes the netlist system generates C.')

        // Extra folders outside the workspace, as the client passes them from keith-vscode.compilationSystems.folders.
        const shared = waitFor('keith/kicool/systemsChanged', (params) => params.added.some((entry) => entry.id === 'team.shared'))
        await connection.sendNotification('keith/kicool/systemFolders', { folders: [outside], workspaceFolders: [workspace] })
        await shared
        systems = await systemsFor(model)
        assert.ok(systems.find((system) => system.id === 'team.shared'))
        const listed = await connection.sendRequest('keith/kicool/workspaceSystems')
        assert.deepEqual(listed.filter((entry) => entry.loaded).map((entry) => entry.id).sort(), ['my.custom', 'my.root', 'my.template', 'team.shared'], JSON.stringify(listed, null, 1))
        assert.deepEqual(listed.filter((entry) => !entry.loaded).map((entry) => path.basename(entry.file)).sort(), ['bad.kico', 'duplicate.kico', 'unknown.kico'])
        console.log('Folders: a directory outside the workspace contributes systems too.')

        // Editing a file replaces its system (new id, old one gone); a fixed file loses its diagnostics.
        const replaced = waitFor('keith/kicool/systemsChanged', (params) => params.added.some((entry) => entry.id === 'my.custom.v2'))
        fs.writeFileSync(path.join(workspace, 'kico/my.kico'), GOOD.replace('my.custom', 'my.custom.v2').replace('My Custom C', 'My Custom C v2'))
        fs.writeFileSync(path.join(workspace, 'kico/bad.kico'), 'public system my.fixed label "Fixed" system de.cau.cs.kieler.sccharts.netlist\n')
        await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: good, type: 2 }, { uri: bad, type: 2 }] })
        const change = await replaced
        const afterEdit = await connection.sendRequest('keith/kicool/workspaceSystems')
        assert.deepEqual(change.removed.map((entry) => entry.id), ['my.custom'], `change ${JSON.stringify(change)}\nclient uri ${good}\nlisting ${JSON.stringify(afterEdit, null, 1)}`)
        await waitFor('keith/kicool/systemsChanged', (params) => params.added.some((entry) => entry.id === 'my.fixed')).catch(() => undefined)
        systems = await systemsFor(model)
        assert.ok(!systems.find((system) => system.id === 'my.custom'), 'The old id is gone')
        assert.equal(systems.find((system) => system.id === 'my.custom.v2')?.label, 'My Custom C v2')
        assert.ok(systems.find((system) => system.id === 'my.fixed'))
        assert.deepEqual(diagnosticsOf(bad), [])
        console.log('Edit: a changed file replaces its system and a repaired file is loaded and cleared.')

        // Unsaved editor content counts too: the system follows what the editor shows.
        const edited = waitFor('keith/kicool/systemsChanged', (params) => params.added.some((entry) => entry.label === 'Renamed in editor'))
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: root, languageId: 'kico', version: 1, text: fs.readFileSync(path.join(workspace, 'root.kico'), 'utf8') } })
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri: root, version: 2 }, contentChanges: [{ text: 'public system my.root label "Renamed in editor" system de.cau.cs.kieler.sccharts.netlist\n' }] })
        await edited
        systems = await systemsFor(model)
        assert.equal(systems.find((system) => system.id === 'my.root')?.label, 'Renamed in editor')
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri: root } })
        console.log('Editor: unsaved .kico edits are reflected immediately.')

        // Deleting a file removes its system.
        const removed = waitFor('keith/kicool/systemsChanged', (params) => params.removed.some((entry) => entry.id === 'my.custom.v2'))
        fs.unlinkSync(path.join(workspace, 'kico/my.kico'))
        await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: good, type: 3 }] })
        await removed
        systems = await systemsFor(model)
        assert.ok(!systems.find((system) => system.id === 'my.custom.v2'))
        assert.deepEqual(diagnosticsOf(good), [])
        console.log('Delete: a removed file takes its system with it.')

        assert.ok(!/Exception/.test(stderr), stderr)
        console.log('Workspace compilation systems passed.')
    } finally {
        clearTimeout(watchdog)
        try { await connection.sendRequest('shutdown') } catch { /* ignored */ }
        connection.sendNotification('exit')
        connection.dispose()
        setTimeout(() => server.kill(), 2000)
        await closed
        fs.rmSync(workspace, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
    }
}

main().catch((error) => { console.error(error); process.exit(1) })
