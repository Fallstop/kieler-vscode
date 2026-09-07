const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function setup() {
    const uri = URI.parse('file:///demo.sctx')
    const issue = { id: '1:0', locations: [{ uri: uri.toString(), offset: 0, length: 4, label: 'flag', traceUris: [uri + '#action'] }], cycle: [], snapshotIndex: 7 }
    const report = { id: 1, uri: uri.toString(), version: 1, status: 'failed', issues: [issue] }
    const document = { uri, version: 1 }
    const shown = [], sent = [], stages = []
    const disposable = { dispose() {} }
    class TabInputText { constructor(uri) { this.uri = uri } }
    const window = {
        visibleTextEditors: [], tabGroups: { all: [] },
        createTextEditorDecorationType: () => disposable,
        showTextDocument: async (_, options) => {
            shown.push(options)
            return { setDecorations() {}, revealRange() {} }
        },
    }
    const vscode = { Uri: URI, TabInputText, window, ThemeColor: class {}, ViewColumn: { Beside: -2 },
        TextEditorRevealType: { InCenterIfOutsideViewport: 2 }, workspace: { openTextDocument: async () => document } }
    const diagnostics = { get: () => report, onDidChange: () => disposable, range: () => 'source-range' }
    const diagrams = { currentUri: uri, onDidChangeDiagram: () => disposable, onWebviewNotification: () => disposable,
        sendToDiagram: (type, payload) => sent.push({ method: type.method, payload }) }
    const { DiagnosticBridge } = createLoader({ vscode })('src/kico/diagnostic-bridge.ts')
    const bridge = new DiagnosticBridge(diagnostics, diagrams, async (...args) => stages.push(args))
    const command = kind => bridge.handle({ kind, build: 1, issue: '1:0', location: 0 })
    return { uri, document, report, window, shown, sent, stages, TabInputText, command }
}

test('source navigation reuses the visible editor instead of opening another group', async () => {
    const { document, window, shown, command } = setup()
    window.visibleTextEditors = [{ document, viewColumn: 1 }]
    await command('source')
    assert.equal(shown[0].viewColumn, 1)
    assert.equal(shown[0].selection, 'source-range')
})

test('source navigation finds an existing tab even when hidden behind another file', async () => {
    const { uri, window, shown, TabInputText, command } = setup()
    window.tabGroups.all = [{ viewColumn: 2, tabs: [{ input: new TabInputText(uri) }] }]
    await command('source')
    assert.equal(shown[0].viewColumn, 2)
})

test('diagram highlight restores the source model, while stage navigation clears the highlight', async () => {
    const { uri, command, stages, sent } = setup()
    await command('highlight')
    assert.deepEqual(stages, [[uri.toString(), -1]])
    assert.ok(sent.at(-1).payload.traceUris[0].length)
    await command('stage')
    assert.deepEqual(stages.at(-1), [uri.toString(), 7])
    assert.deepEqual(sent.at(-1).payload.traceUris, [])
})

test('stale reports cannot navigate or change the diagram', async () => {
    const { report, command, shown, stages, sent } = setup()
    report.status = 'stale'
    await command('highlight')
    await command('source')
    assert.deepEqual([shown, stages, sent], [[], [], []])
})
