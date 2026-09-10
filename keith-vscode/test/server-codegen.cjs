const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const model = `scchart Review {
  input bool trigger
  output bool result = false
  initial state Idle
  if trigger do result = true go to Active
  state Active
  if !trigger do result = false go to Idle
}`

async function main() {
    const { java, serverArgs } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-codegen-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const closed = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    function waitFor(method, accept = () => true) {
        return new Promise((resolve, reject) => {
            const waiter = { method, accept, resolve: params => { clearTimeout(timer); waiters.delete(waiter); resolve(params) } }
            const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}`)) }, 30000)
            waiters.add(waiter)
        })
    }
    let sequence = 0
    async function compile(text, target = 'c') {
        const file = path.join(workspace, `model-${++sequence}.sctx`)
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const ready = waitFor('keith/kicool/didCompile', message => message.uri === uri && message.finished)
        const progress = []
        const listener = connection.onNotification('keith/kicool/didCompile', message => {
            if (!message.finished) progress.push(message)
            for (const waiter of waiters) if (waiter.method === 'keith/kicool/didCompile' && waiter.accept(message)) waiter.resolve(message)
        })
        try {
            await connection.sendNotification('keith/kicool/compile', {
                uri, command: target === 'java' ? 'de.cau.cs.kieler.sccharts.netlist.java' : 'de.cau.cs.kieler.sccharts.netlist',
                clientId: 'keith-diagram_sprotty', inplace: false, snapshot: false, showResultingModel: false,
            })
            const response = await ready
            assert.ok(progress.every(message => !message.results?.generatedFiles), 'Only final results carry source files')
            assert.ok(fs.readdirSync(workspace).every(name => name.endsWith('.sctx')), 'Generation must not write artifacts to the workspace')
            return { ...response, uri }
        } finally { listener.dispose() }
    }
    const errors = result => result.results?.files.flat().flatMap(stage => stage.errors ?? []) ?? ['Model could not be loaded']
    const outputs = result => result.results?.generatedFiles ?? []
    function check(command, args) {
        const result = spawnSync(command, args, { encoding: 'utf8' })
        assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr}`)
    }
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    let output
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const c = await compile(model)
        const java = await compile(model, 'java')
        assert.deepEqual(errors(c), [])
        assert.deepEqual(errors(java), [])
        assert.deepEqual(outputs(c).map(file => file.fileName), ['Review.c', 'Review.h'])
        assert.deepEqual(outputs(java).map(file => file.fileName), ['Review.java'])
        output = fs.mkdtempSync(path.join(tmpdir(), 'kieler-export-'))
        for (const file of [...outputs(c), ...outputs(java)]) fs.writeFileSync(path.join(output, file.fileName), file.code)
        check('gcc', ['-std=c99', '-Wall', '-Wextra', '-c', path.join(output, 'Review.c'), '-o', path.join(output, 'Review.o')])
        check('javac', ['-d', output, path.join(output, 'Review.java')])

        const cOnly = '#hostcode-c "int probe(void) { return 42; }"\n' + model
        assert.equal(outputs(await compile(cOnly)).length, 2)
        const incompatible = await compile(cOnly, 'java')
        assert.equal(outputs(incompatible).length, 0)
        assert.match(errors(incompatible).join('\n'), /hostcode-c.*hostcode-java/)
        const diagnostic = incompatible.results.files.flat().flatMap(stage => stage.diagnostics).find(issue => issue.code === 'code-generation')
        assert.equal(diagnostic.locations[0].uri, incompatible.uri)
        assert.equal(diagnostic.locations[0].offset, 0)

        const dualHost = '#hostcode-java "// Java implementation"\n' + cOnly
        assert.equal(outputs(await compile(dualHost, 'java')).length, 1, 'Matching host implementations are allowed')
        const invalid = await compile(model.replace('output bool result', 'output nonexistent result'))
        assert.equal(outputs(invalid).length, 0, 'Invalid source must never be exported')
        assert.ok(errors(invalid).length > 0 || invalid.results?.generationError)
        const broken = await compile(fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8'))
        assert.equal(outputs(broken).length, 0)
        assert.ok(errors(broken).length)
        assert.equal(outputs(await compile(model, 'java')).length, 1, 'Generation recovers after failures')
        console.log('Code generation passed: virtual artifacts, GCC/javac, host-language errors with source locations, invalid input, scheduling failure and recovery.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
        fs.rmSync(workspace, { recursive: true, force: true })
        if (output) fs.rmSync(output, { recursive: true, force: true })
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
