const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const createLoader = require('./load-typescript.cjs')
const load = createLoader()
const { mapNativeLocation, arrayCopyFix } = load('src/kico/source-mapping.ts')
const uri = 'file:///demo.sctx'

test('embedded C diagnostics map escaped quotes and UTF-8 columns to source offsets', () => {
    const source = '#hostcode-c "\nint probe() { char* p = \\"é\\"; return missing; }\n"\nscchart Demo {}'
    const generatedLine = 'int probe() { char* p = "é"; return missing; }'
    const mapped = mapNativeLocation(uri, source, { generatedLine, column: Buffer.byteLength(generatedLine.slice(0, generatedLine.indexOf('missing'))), label: 'unknown identifier' })
    assert.equal(source.slice(mapped.offset, mapped.offset + mapped.length), 'missing')
    assert.equal(mapped.uri, uri)
})

test('ambiguous host lines and generated names stay in the generated file', () => {
    assert.equal(mapNativeLocation(uri, '#hostcode-c "\nbad();\nbad();\n"', { generatedLine: 'bad();', column: 0 }), undefined)
    assert.equal(mapNativeLocation(uri, 'int x\n', { generatedLine: 'd->_g4 = missing;', column: 8 }), undefined)
    assert.equal(mapNativeLocation(uri, '/*\n#hostcode-c "\nbad();\n"\n*/', { generatedLine: 'bad();', column: 0 }), undefined)
    assert.equal(mapNativeLocation(uri, '// a = b\n', { generatedLine: 'd->a = d->b;', column: 0 }), undefined)
})

test('demo array-copy error maps to its source and offers explicit element copies', () => {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
    const mapped = mapNativeLocation(uri, source, { generatedLine: '    d->timeout_vals = d->timeout_buf;', column: 20 })
    assert.equal(source.slice(mapped.offset, mapped.offset + mapped.length), 'timeout_vals = timeout_buf')
    const fix = arrayCopyFix(source, mapped)
    assert.equal(fix.split('\n').length, 6)
    assert.match(fix, /timeout_vals\[5\] = timeout_buf\[5\]$/)
    assert.equal(arrayCopyFix(source.replace('int timeout_buf[6]', 'int timeout_buf[5]'), mapped), undefined)
})

test('diagram selection matches the nearest traced action and never another source file', () => {
    const mocked = createLoader({ sprotty: {}, 'sprotty-protocol': {} })
    const { findDiagramElements } = mocked('src-webview/diagram/diagnostics/highlight.ts')
    const model = { id: 'root', children: [{ id: 'transition', trace: 'file:///demo.sctx?20:0-20:40#//@states.0/@transitions.0' }, { id: 'other', trace: 'file:///other.sctx?20:0-20:40#//@states.0/@transitions.0' }] }
    assert.deepEqual(findDiagramElements(model, [['file:///demo.sctx#//@states.0/@transitions.0/@effects.0', 'file:///demo.sctx#//@states.0/@transitions.0']]), ['transition'])
    assert.deepEqual(findDiagramElements(model, [['file:///missing.sctx#//@states.0']]), [])
})

test('failure panel exposes source, explanation and details, disables stale source actions', () => {
    const dom = new JSDOM('<div class="kv-root"><header class="kv-toolbar"></header></div>')
    for (const name of ['document', 'window', 'HTMLElement', 'Event']) global[name] = dom.window[name]
    const ui = createLoader()
    const { DiagnosticView } = ui('src-webview/diagram/diagnostics/view.ts')
    const sent = []
    const view = new DiagnosticView({ onNotification() {}, sendNotification: (_, __, command) => sent.push(command) })
    const issue = { id: '1:0', stage: 'Scheduler', message: 'Circular dependency involving flag.', severity: 'error', code: 'scheduling-cycle', locations: [{ uri, offset: 0, length: 4, label: '<script>flag</script>', traceUris: [uri] }], cycle: [{ from: '_g1', to: '_g2', fromLabel: 'flag = true', toLabel: 'flag = false', reason: 'Concurrent writes require this ordering.', locations: [] }] }
    const report = { id: 1, uri, version: 1, status: 'failed', issues: [issue], rawCount: 48 }
    view.render(report)
    assert.match(view.el.querySelector('[role="alert"]').textContent, /Compilation failed/)
    assert.equal(view.el.querySelector('script'), null)
    assert.match(view.el.querySelector('.kd-cycle').textContent, /flag = true/)
    view.el.querySelector('.kd-sources button').click()
    assert.deepEqual(sent.pop(), { kind: 'source', build: 1, issue: '1:0', location: 0 })
    view.render({ ...report, status: 'stale' })
    assert.equal(view.el.querySelector('.kd-sources button').disabled, true)
    view.render(undefined)
    assert.equal(view.el.hidden, true)
    dom.window.close()
})
