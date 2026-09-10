const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({ vscode: {} })('src/runtime/runtime-manager.ts')

test('compilation systems are classified by target language', () => {
    const { buildLanguageOf } = load()
    assert.equal(buildLanguageOf('de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', 'Netlist-based Simulation (C)'), 'c')
    assert.equal(buildLanguageOf('de.cau.cs.kieler.sccharts.simulation.tts.netlist.java', 'Netlist-based Simulation (Java)'), 'java')
    assert.equal(buildLanguageOf('de.cau.cs.kieler.sccharts.netlist.java'), 'java')
    assert.equal(buildLanguageOf('de.cau.cs.kieler.sccharts.priority.simulation', 'Priority-based Simulation'), 'c')
    assert.equal(buildLanguageOf('custom.system', 'Simulation via Java'), 'java')
})
