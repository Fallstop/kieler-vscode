const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({ vscode: {} })('src/conflicts.ts')

test('the upstream KIELER extension is reported as a conflict', () => {
    const { findConflictingExtensions } = load()
    const installed = new Set(['kieler.keith-vscode', 'kieler.klighd-vscode'])
    const conflicts = findConflictingExtensions({ getExtension: id => (installed.has(id) ? { id } : undefined) })
    assert.deepEqual(conflicts.map(extension => extension.id), ['kieler.keith-vscode'])
    assert.deepEqual(findConflictingExtensions({ getExtension: () => undefined }), [])
})

test('activation stops and offers to show the conflicting extension', async () => {
    const { reportConflictingExtensions } = load()
    const executed = []
    const window = { showErrorMessage: async (message, action) => { assert.match(message, /KIELER VS Code/); return action } }
    const commands = { executeCommand: async (...args) => { executed.push(args) } }
    assert.equal(await reportConflictingExtensions([{ id: 'kieler.keith-vscode', name: 'KIELER VS Code' }], window, commands), true)
    assert.deepEqual(executed, [['workbench.extensions.search', '@installed kieler.keith-vscode']])
    assert.equal(await reportConflictingExtensions([], window, commands), false)
})
