const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const { keepsViewport } = createLoader()('src-webview/diagram/viewport-policy.ts')

test('model updates keep the viewport while a simulation runs', () => {
    assert.equal(keepsViewport('updateModel', true), true)
    assert.equal(keepsViewport('setModel', true), true)
})

test('outside a simulation the diagram is refitted as before', () => {
    assert.equal(keepsViewport('updateModel', false), false)
    assert.equal(keepsViewport('setModel', false), false)
})

test('other server actions are untouched either way', () => {
    assert.equal(keepsViewport('elementSelected', true), false)
    assert.equal(keepsViewport('requestBounds', true), false)
    assert.equal(keepsViewport(undefined, true), false)
})
