const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

function setup() {
    const load = createLoader({ vscode: {
        TreeItem: class {}, TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class {},
        commands: { getCommands: async () => ['keith-vscode.show-next'] },
        window: { showErrorMessage: async () => undefined },
    } })
    const { CompilationDataProvider } = load('src/kico/compilation-data-provider.ts')
    const compiler = Object.create(CompilationDataProvider.prototype)
    const finished = []
    for (const map of ['isCompiled', 'resultMap', 'lengthMap', 'indexMap', 'shownStage', 'pendingResults']) compiler[map] = new Map()
    compiler.compilationFinishedEmitter = { fire: (success) => finished.push(success) }
    compiler.stageChangedEmitter = { fire() {} }
    compiler.compilation = { show() {} }
    compiler.output = { appendLine() {} }
    compiler.startTime = Date.now()
    return { compiler, finished }
}

test('compilation progress can exceed the server estimate without crashing or marking success as failure', async () => {
    const { compiler, finished } = setup()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', false, 46, 43)
    assert.ok(compiler.compilation.text.length < 100)
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 46, 43)
    assert.deepEqual(finished, [true])
    assert.match(compiler.compilation.tooltip, /^Compiled in \d+ ms$/)
})

test('cancelled compilations never start a simulation', async () => {
    const { compiler, finished } = setup()
    compiler.cancellingCompilation = true
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 43, 43)
    assert.deepEqual(finished, [false])
})

test('an unloadable source produces a failed build instead of crashing on null results', async () => {
    const { compiler, finished } = setup()
    compiler.compiling = true
    await compiler.handleNewSnapshotDescriptions(null, 'file:///invalid.sctx', true, 0, 1000)
    assert.deepEqual(finished, [false])
    assert.equal(compiler.compiling, false)
    assert.match(compiler.resultMap.get('file:///invalid.sctx').files[0][0].errors[0], /model could not be loaded/)
})

test('cancellation transport failures reach the caller instead of escaping as unhandled rejections', async () => {
    const { compiler, finished } = setup()
    compiler.lsClient = { start: async () => {}, sendNotification: async () => { throw new Error('Server disconnected') } }
    await assert.rejects(compiler.requestCancelCompilation(), /Server disconnected/)
    assert.deepEqual(finished, [])
})
