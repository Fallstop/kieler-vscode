const assert = require('node:assert/strict')
const { test } = require('node:test')
const { StepController } = require('./load-typescript.cjs')()('src/simulation/step-controller.ts')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('slow server acknowledgements apply back pressure and pause/resume never duplicates a loop', async (t) => {
    let count = 0
    const steps = new StepController(async () => { count++ })
    t.after(() => steps.reset())
    const first = steps.run(() => 1)
    await sleep(15)
    assert.equal(count, 1)
    steps.pause()
    const second = steps.run(() => 1)
    assert.equal(count, 1)
    steps.acknowledge()
    await sleep(15)
    assert.equal(count, 2)
    steps.reset()
    await Promise.all([first, second])
    await sleep(15)
    assert.equal(count, 2)
})

test('reset cancels pending ticks and wakes sleeping run loops', async () => {
    let count = 0
    const steps = new StepController(async () => { count++ })
    const running = steps.run(() => 60000)
    steps.acknowledge()
    await Promise.resolve()
    steps.reset()
    await running
    assert.equal(count, 1)
})

test('send failure and missing tick responses fail instead of hanging', async () => {
    const failed = new StepController(async () => { throw new Error('disconnected') })
    await assert.rejects(failed.step(), /disconnected/)
    const stalled = new StepController(async () => {}, 10)
    await assert.rejects(stalled.step(), /did not respond/)
})
