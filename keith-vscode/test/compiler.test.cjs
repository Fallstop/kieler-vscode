const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

function setup() {
    const load = createLoader({ vscode: { TreeItem: class {}, commands: { getCommands: async () => ['keith-vscode.show-next'] } } })
    const { CompilationDataProvider } = load('src/kico/compilation-data-provider.ts')
    const compiler = Object.create(CompilationDataProvider.prototype)
    const finished = []
    for (const map of ['isCompiled', 'resultMap', 'lengthMap', 'indexMap']) compiler[map] = new Map()
    compiler.compilationFinishedEmitter = { fire: (success) => finished.push(success) }
    compiler._onDidChangeTreeData = { fire() {} }
    compiler.compilation = { show() {} }
    compiler.startTime = Date.now()
    return { compiler, finished }
}

test('compilation progress can exceed the server estimate without crashing or marking success as failure', async () => {
    const { compiler, finished } = setup()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', false, 46, 43)
    assert.ok(compiler.compilation.text.length < 100)
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 46, 43)
    assert.deepEqual(finished, [true])
    assert.equal(compiler.compilation.tooltip, 'Compilation finished')
})

test('cancelled compilations never start a simulation', async () => {
    const { compiler, finished } = setup()
    compiler.cancellingCompilation = true
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 43, 43)
    assert.deepEqual(finished, [false])
})
