const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function setup() {
    class EventEmitter {
        listeners = []
        event = callback => { this.listeners.push(callback); return { dispose() {} } }
        fire(value) { this.listeners.forEach(listener => listener(value)) }
        dispose() {}
    }
    class Range {
        constructor(a, b, c, d) {
            this.start = typeof a === 'object' ? a : { line: a, character: b }
            this.end = typeof a === 'object' ? b : { line: c, character: d }
        }
        intersection() { return this }
    }
    const changes = new EventEmitter()
    const deletes = new EventEmitter()
    const entries = new Map()
    const documents = []
    let actions
    const mock = {
        Uri: URI, EventEmitter, Range,
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }) } },
        DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }) } },
        Location: class { constructor(uri, range) { Object.assign(this, { uri, range }) } },
        CodeActionKind: { QuickFix: 'quickfix' },
        CodeAction: class { constructor(title) { this.title = title } },
        WorkspaceEdit: class { replace(uri, range, text) { Object.assign(this, { uri, range, text }) } },
        languages: {
            createDiagnosticCollection: () => ({ set: (uri, value) => entries.set(uri.toString(), value), delete: uri => entries.delete(uri.toString()), clear: () => entries.clear(), dispose() {} }),
            registerCodeActionsProvider: (_, provider) => { actions = provider; return { dispose() {} } },
        },
        workspace: {
            textDocuments: documents,
            openTextDocument: async uri => documents.find(doc => doc.uri.toString() === uri.toString()),
            onDidChangeTextDocument: changes.event,
            onDidDeleteFiles: deletes.event,
        },
    }
    const { CompilerDiagnostics } = createLoader({ vscode: mock })('src/kico/compiler-diagnostics.ts')
    const diagnostics = new CompilerDiagnostics()
    function document(uri, text = 'scchart Demo {}') {
        const doc = { uri: URI.parse(uri), version: 1, getText: () => text, lineCount: text.split('\n').length,
            positionAt: offset => ({ line: text.slice(0, offset).split('\n').length - 1, character: offset - text.lastIndexOf('\n', offset - 1) - 1 }),
            lineAt: line => ({ text: text.split('\n')[line] }), validateRange: range => range }
        documents.push(doc)
        return doc
    }
    const stage = (locations = [], overrides = {}) => [[{ name: 'Compiler', index: 0, errors: ['raw error'], diagnostics: [{ code: 'c-compiler', message: 'Compiler failed', severity: 'error', locations, cycle: [], ...overrides }] }]]
    return { diagnostics, changes, deletes, entries, document, stage, actions }
}

test('edits invalidate diagnostics and late build results cannot restore stale errors', async () => {
    const { diagnostics, changes, entries, document, stage } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage(), false)
    assert.equal(entries.get(uri).length, 1)
    doc.version++
    changes.fire({ document: doc })
    assert.equal(diagnostics.get(uri).status, 'stale')
    assert.equal(entries.size, 0)
    diagnostics.finish(uri, stage(), false)
    assert.equal(entries.size, 0)
    await diagnostics.begin(uri)
    doc.version++
    changes.fire({ document: doc })
    diagnostics.finish(uri, stage(), false)
    assert.equal(diagnostics.get(uri).status, 'stale')
    assert.equal(entries.size, 0)
})

test('rebuild, cancellation, deletion and restart clear owned errors without affecting another model', async () => {
    const { diagnostics, deletes, entries, document, stage } = setup()
    const a = document('file:///a.sctx').uri.toString()
    const b = document('file:///b.sctx').uri.toString()
    await diagnostics.begin(a)
    diagnostics.finish(a, stage([{ uri: 'file:///generated.c', line: 2, column: 3, offset: 0, length: 1, label: 'Generated code' }]), false)
    await diagnostics.begin(b)
    diagnostics.finish(b, stage(), false)
    assert.equal(entries.size, 2)
    await diagnostics.begin(a)
    assert.deepEqual([...entries.keys()], [b])
    diagnostics.cancel(a)
    diagnostics.finish(a, stage(), false)
    assert.equal(diagnostics.get(a).status, 'cancelled')
    assert.deepEqual([...entries.keys()], [b])
    deletes.fire({ files: [URI.parse(b)] })
    assert.equal(entries.size, 0)
    assert.equal(diagnostics.get(b), undefined)
    diagnostics.reset()
    assert.equal(diagnostics.get(a), undefined)
})

test('mapped array errors keep generated related information and a version-bound quick fix', async () => {
    const { diagnostics, changes, entries, document, stage, actions } = setup()
    const text = 'scchart Demo {\n int a[2]\n int b[2]\n initial state A\n entry do a = b\n}'
    const doc = document('file:///demo.sctx', text)
    const uri = doc.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage([{ uri: 'file:///generated.c', line: 10, column: 7, offset: 0, length: 1, generatedLine: 'd->a = d->b;', label: 'Array assignment' }], { message: "array type 'int[2]' is not assignable" }), false)
    const problem = entries.get(uri)[0]
    assert.equal(problem.relatedInformation[0].location.uri.toString(), 'file:///generated.c')
    const fix = actions.provideCodeActions(doc, problem.range)
    assert.match(fix[0].edit.text, /a\[0\] = b\[0\];\n a\[1\] = b\[1\]/)
    doc.version++
    changes.fire({ document: doc })
    assert.deepEqual(actions.provideCodeActions(doc, problem.range), [])
})

test('loop warnings explained by a scheduler cycle are dropped; standalone ones keep their source', async () => {
    const { diagnostics, document } = setup()
    const doc = document('file:///demo.sctx', 'scchart Demo { int x\n }')
    const uri = doc.uri.toString()
    const at = (offset, label) => ({ uri, offset, length: 3, label })
    const loop = (locations) => ({ code: 'instantaneous-loop', message: 'Instantaneous loop detected!', severity: 'warning', hint: 'Make one transition delayed.', locations, cycle: [] })
    const cycle = { code: 'scheduling-cycle', message: 'Circular dependency prevents scheduling this tick.', severity: 'error', locations: [at(15, 'x = 1'), at(19, 'x = 2')], cycle: [] }
    await diagnostics.begin(uri)
    let report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 1'), at(19, 'x = 2')])] },
        { name: 'Basic Blocks', index: 1, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 1'), at(19, 'x = 2')])] },
        { name: 'Scheduler', index: 2, errors: ['The SCG is NOT asc-schedulable!'], diagnostics: [cycle] },
    ]], false)
    assert.deepEqual(report.issues.map(issue => issue.code), ['scheduling-cycle'])
    assert.equal(report.status, 'failed')

    await diagnostics.begin(uri)
    report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 0')])] },
        { name: 'Basic Blocks', index: 1, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 0')])] },
    ]], false)
    assert.equal(report.status, 'succeeded')
    assert.equal(report.issues.length, 1, 'Both analyzer runs describe the same loop')
    assert.equal(report.issues[0].message, 'Potential instantaneous loop through x.')
    assert.equal(report.issues[0].hint, 'Make one transition delayed.')
    assert.equal(report.issues[0].severity, 'warning')

    await diagnostics.begin(uri)
    report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([])] },
        { name: 'Scheduler', index: 1, errors: ['The SCG is NOT asc-schedulable!'], diagnostics: [cycle] },
    ]], false)
    assert.deepEqual(report.issues.map(issue => issue.code), ['scheduling-cycle'], 'An unlocated loop warning adds nothing to a cycle error')
})
