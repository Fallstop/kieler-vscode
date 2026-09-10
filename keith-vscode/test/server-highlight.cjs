// textDocument/documentHighlight must answer with no highlights, not an "Internal error", when the
// editor asks about a position the server's copy of the document does not have. The editor and the
// server can drift apart (a lost or duplicated didChange), and the editor sends this request on every
// cursor move, so an out-of-range position must degrade silently.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const extension = path.resolve(__dirname, '..')
    const { classpath, java, serverArgs } = require('./server-launch.cjs')
    assert.ok(fs.existsSync(classpath), 'The language server JAR is required; run npm run build:server')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-highlight-'))
    const fixture = path.join(workspace, 'audit.sctx')
    fs.copyFileSync(path.join(__dirname, 'fixtures/audit.sctx'), fixture)
    const text = fs.readFileSync(fixture, 'utf8')
    const lines = text.split('\n')
    const uri = pathToFileURL(fixture).href
    const server = spawn(java, serverArgs, { cwd: extension })
    const closed = new Promise((resolve) => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    connection.onRequest('workspace/configuration', (params) => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 60000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const highlight = (line, character) =>
            connection.sendRequest('textDocument/documentHighlight', { textDocument: { uri }, position: { line, character } })

        // A real identifier: the first line reads "scchart <name> {", so column 9 sits inside the name.
        const onName = await highlight(0, 9)
        assert.ok(Array.isArray(onName) && onName.length > 0, `Expected highlights on the chart name, got ${JSON.stringify(onName)}`)
        console.log(`Highlights on the chart name: ${onName.length}`)

        // Past the end of a line (the case from the field: column 20 on a 15-character line).
        const shortLine = lines.findIndex((line) => line.trim().length > 0 && line.length < 20)
        assert.ok(shortLine >= 0)
        assert.deepEqual(await highlight(shortLine, lines[shortLine].length + 5), [])
        // Past the end of the document.
        assert.deepEqual(await highlight(lines.length + 10, 0), [])
        assert.ok(!/documentHighlight failed/.test(stderr), `Server logged a failed highlight request:\n${stderr}`)
        console.log('Out-of-range highlight positions answered with no highlights')
        await connection.sendRequest('shutdown')
        connection.sendNotification('exit')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}

main().catch((error) => { console.error(error); process.exit(1) })
