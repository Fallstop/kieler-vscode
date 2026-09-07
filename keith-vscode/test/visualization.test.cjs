const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { waitForVisualization } = require('./load-typescript.cjs')()('src/simulation/visualization.ts')

test('browser visualization waits through startup errors until HTTP is ready', async (t) => {
    let attempts = 0
    const server = createServer((_, response) => {
        response.statusCode = ++attempts === 1 ? 503 : 200
        response.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    await waitForVisualization(`http://127.0.0.1:${server.address().port}`, 2000)
    assert.equal(attempts, 2)
})

test('an unavailable visualization reports a bounded failure', async () => {
    await assert.rejects(waitForVisualization('http://127.0.0.1:1', 10), /did not become ready/)
})
