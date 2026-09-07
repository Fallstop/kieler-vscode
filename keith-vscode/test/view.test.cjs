const assert = require('node:assert/strict')
const { test, beforeEach, afterEach } = require('node:test')
const { JSDOM } = require('jsdom')
const createLoader = require('./load-typescript.cjs')

let dom, load
beforeEach(() => {
    dom = new JSDOM('<div id="keith-diagram_sprotty_container"></div>', { url: 'https://webview.test' })
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'localStorage']) {
        global[key] = dom.window[key]
    }
    global.CSS = { escape: (value) => value.replaceAll('"', '\\"') }
    global.ResizeObserver = class { observe() {} }
    load = createLoader()
})
afterEach(() => dom.window.close())

const input = (next = 0) => ({ id: 'input', label: 'Input', role: 'input', history: [], next, pending: false, internal: false, categories: [] })
const state = (patch = {}) => ({ phase: 'running', tick: 0, firstTick: 1, playing: false, stepDelay: 200, showInternal: false, variables: [input()], ...patch })

test('numeric parsing rejects partial binary values and non-finite numbers', () => {
    const { parseNumber, formatNumber } = load('src-webview/diagram/simulation/format.ts')
    for (const value of ['0b102', '0b12', '-0b2', 'Infinity', '-Infinity', '1e309', 'NaN', '']) {
        assert.equal(parseNumber(value, 'dec'), undefined, value)
    }
    assert.equal(parseNumber('-0xFF'), -255)
    assert.equal(parseNumber('101', 'bin'), 5)
    assert.equal(parseNumber('FF', 'hex'), 255)
    assert.equal(parseNumber(formatNumber(1.5, 'hex'), 'hex'), 1.5)
    assert.equal(parseNumber(formatNumber(1e-7, 'bin'), 'bin'), 1e-7)
    for (const code of [0, 1, 9, 10, 13, 27, 39, 65, 92, 127, 0x1f600]) {
        assert.equal(parseNumber(formatNumber(code, 'char'), 'char'), code)
    }
})

test('JSON inputs retain their shape and remain editable when numbers display in hex', () => {
    const { Timeline, parseLike } = load('src-webview/diagram/simulation/timeline.ts')
    const timeline = new Timeline(() => {}, { get: () => 'hex', cycle() {} })
    document.body.append(timeline.el)
    timeline.render(state({ variables: [input([10, 20])] }))
    assert.equal(timeline.el.querySelector('input').value, '[10,20]')
    assert.deepEqual(parseLike('[11,21]', [10, 20]), [11, 21])
    assert.equal(parseLike('true', [10, 20]), undefined)
    assert.equal(parseLike('[1]', [10, 20]), undefined)
    assert.equal(parseLike('[1,"2"]', [10, 20]), undefined)
})

test('invalid edits keep focus, explain the error, and cannot send a value', () => {
    const { Timeline } = load('src-webview/diagram/simulation/timeline.ts')
    const sent = []
    const timeline = new Timeline((command) => sent.push(command))
    document.body.append(timeline.el)
    timeline.render(state())
    const editor = timeline.el.querySelector('input')
    editor.focus()
    editor.value = '0b12'
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(document.activeElement, editor)
    assert.equal(editor.getAttribute('aria-invalid'), 'true')
    assert.equal(sent.length, 0)
    editor.value = '3'
    editor.dispatchEvent(new window.Event('input'))
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.deepEqual(sent, [{ kind: 'setInput', id: 'input', value: 3 }])
})

test('tick rendering preserves an input edit and its selection', () => {
    const { Timeline } = load('src-webview/diagram/simulation/timeline.ts')
    const timeline = new Timeline(() => {})
    document.body.append(timeline.el)
    timeline.render(state())
    const editor = timeline.el.querySelector('input')
    editor.focus()
    editor.value = '123'
    editor.setSelectionRange(1, 2)
    timeline.render(state({ tick: 1 }))
    assert.equal(document.activeElement.value, '123')
    assert.equal(document.activeElement.selectionStart, 1)
    assert.equal(document.activeElement.selectionEnd, 2)
})

test('boolean inputs keep keyboard focus across tick updates', () => {
    const { Timeline } = load('src-webview/diagram/simulation/timeline.ts')
    const timeline = new Timeline(() => {})
    document.body.append(timeline.el)
    timeline.render(state({ variables: [input(false)] }))
    timeline.el.querySelector('button').focus()
    timeline.render(state({ tick: 1, variables: [input(true)] }))
    assert.equal(document.activeElement.getAttribute('role'), 'switch')
    assert.equal(document.activeElement.getAttribute('aria-checked'), 'true')
})

test('tick updates leave speed sliders and number selectors mounted and focused', () => {
    const { Toolbar } = load('src-webview/diagram/simulation/toolbar.ts')
    const toolbar = new Toolbar({ send() {}, toggleDrawer() {}, drawerOpen: () => true })
    document.body.append(toolbar.el)
    toolbar.render(state({ playing: true }))
    const slider = toolbar.el.querySelector('input')
    const select = toolbar.el.querySelector('.kv-delay-ms')
    slider.focus()
    slider.value = '75'
    toolbar.render(state({ tick: 1, playing: true }))
    assert.equal(toolbar.el.querySelector('input'), slider)
    assert.equal(toolbar.el.querySelector('.kv-delay-ms'), select)
    assert.equal(document.activeElement, slider)
    assert.equal(slider.value, '75')
    assert.equal(toolbar.el.querySelector('.kv-tick-value').textContent, '1')
    assert.equal(toolbar.el.querySelector('[aria-label="Step"]').disabled, true)
})

test('first-tick numeric outputs appear and sustained true outputs are never labelled off', () => {
    const { renderSummary } = load('src-webview/diagram/simulation/summary.ts')
    const output = { ...input(), label: 'Count', role: 'output', history: [7] }
    assert.match(renderSummary(state({ tick: 1, variables: [output] })).textContent, /Count=7/)
    output.label = 'Signal'
    output.history = [true, true]
    const summary = renderSummary(state({ tick: 2, variables: [output] }))
    assert.match(summary.textContent, /Signal/)
    assert.doesNotMatch(summary.textContent, /Signal off/)
})

test('Space respects buttons and selectors, ignores key repeats, and hidden views refresh on return', () => {
    const { SimulationView } = load('src-webview/diagram/simulation/view.ts')
    const sent = []
    let update
    new SimulationView({ onNotification: (_, handler) => { update = handler }, sendNotification: (_, __, command) => sent.push(command) })
    update(state())
    const step = document.querySelector('[aria-label="Step"]')
    const key = (target, options = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...options }))
    key(step)
    key(document.querySelector('.kv-delay-ms'))
    key(document.body, { repeat: true })
    assert.equal(sent.length, 0)
    key(document.body)
    assert.deepEqual(sent.pop(), { kind: 'step' })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new window.Event('visibilitychange'))
    assert.deepEqual(sent.pop(), { kind: 'requestState' })
})
