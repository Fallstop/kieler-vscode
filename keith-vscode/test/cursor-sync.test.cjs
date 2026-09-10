const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

const Kind = { Keyboard: 1, Mouse: 2, Command: 3 }

function setup(options = {}) {
    let listener
    const vscode = {
        Uri: URI,
        TextEditorSelectionChangeKind: Kind,
        window: {
            onDidChangeTextEditorSelection: (handler) => { listener = handler; return { dispose() {} } },
            activeTextEditor: undefined,
        },
    }
    const { CursorSync } = createLoader({ vscode })('src/diagram/cursor-sync.ts')
    const uri = URI.parse('file:///demo.sctx')
    const sent = []
    let now = 10000
    const state = { mode: 'focus', diagramUri: uri, lastInteraction: 0, fail: false }
    const sync = new CursorSync({
        send: async (params) => { sent.push(params); if (state.fail) throw new Error('down'); return { ok: true, expanded: 1, collapsed: 0 } },
        mode: () => state.mode,
        diagramUri: () => state.diagramUri,
        clientId: 'keith-diagram_sprotty',
        lastDiagramInteraction: () => state.lastInteraction,
        debounceMs: 5,
        now: () => now,
        ...options,
    })
    const editor = (offset = 42, languageId = 'sctx') => ({
        document: { uri, languageId, offsetAt: () => offset },
        selection: { active: { line: 0, character: offset }, isSingleLine: true, isEmpty: true },
    })
    const event = (overrides = {}) => ({
        textEditor: editor(),
        selections: [{ isSingleLine: true, isEmpty: true }],
        kind: Kind.Mouse,
        ...overrides,
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    return { sync, sent, state, editor, event, fire: (e) => listener(e), settle, setNow: (value) => { now = value }, vscode }
}

test('a user cursor move is sent once after the debounce with the UTF-16 offset', async () => {
    const { sync, sent, event, fire, settle } = setup()
    assert.equal(sync.skipReason(event()), undefined)
    fire(event())
    fire(event())
    fire(event())
    assert.equal(sent.length, 0, 'debounced')
    await settle()
    assert.deepEqual(sent, [{ uri: 'file:///demo.sctx', offset: 42, clientId: 'keith-diagram_sprotty', mode: 'focus' }])
})

test('programmatic, multi-cursor and multi-line selections are ignored', () => {
    const { sync, event } = setup()
    assert.equal(sync.skipReason(event({ kind: undefined })), 'not a user selection')
    assert.equal(sync.skipReason(event({ kind: Kind.Command })), 'not a user selection')
    assert.equal(sync.skipReason(event({ selections: [{ isSingleLine: true }, { isSingleLine: true }] })), 'multiple cursors')
    assert.equal(sync.skipReason(event({ selections: [{ isSingleLine: false }] })), 'multi-line selection')
})

test('only the SCChart shown in the diagram is followed, and only when enabled', () => {
    const { sync, state, event, editor } = setup()
    assert.equal(sync.skipReason(event({ textEditor: editor(1, 'scl') })), 'not an SCChart')
    state.diagramUri = URI.parse('file:///other.sctx')
    assert.equal(sync.skipReason(event()), 'diagram shows another model')
    state.diagramUri = undefined
    assert.equal(sync.skipReason(event()), 'diagram shows another model')
    state.diagramUri = URI.parse('file:///demo.sctx')
    state.mode = 'off'
    assert.equal(sync.skipReason(event()), 'disabled')
    state.mode = 'expand'
    assert.equal(sync.skipReason(event()), undefined)
})

test('the diagram is left alone right after the user acted on it', () => {
    const { sync, state, event, setNow } = setup()
    state.lastInteraction = 10000
    setNow(10300)
    assert.equal(sync.skipReason(event()), 'user is working in the diagram')
    setNow(10600)
    assert.equal(sync.skipReason(event()), undefined)
})

test('the same cursor is not sent twice, but is sent again after a reset or a failed request', async () => {
    const { sync, sent, state, editor } = setup()
    await sync.reveal(editor(7))
    await sync.reveal(editor(7))
    assert.equal(sent.length, 1)
    await sync.reveal(editor(8), 'expand')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].mode, 'expand')
    sync.reset()
    await sync.reveal(editor(8), 'expand')
    assert.equal(sent.length, 3)
    state.fail = true
    await sync.reveal(editor(9))
    state.fail = false
    assert.equal((await sync.reveal(editor(9))).ok, true, 'the retry after a failure is sent again')
    assert.equal(sent.length, 5, 'a failed request does not pin the cursor')
})

test('reveal without an open diagram of the file does nothing', async () => {
    const { sync, sent, state, editor } = setup()
    state.diagramUri = undefined
    assert.equal(await sync.reveal(editor()), undefined)
    assert.equal(sent.length, 0)
})
