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

test('the startup cache command and setting are contributed under the ids the manager uses', () => {
    const { CLEAR_STARTUP_CACHE, STARTUP_CACHE_SETTING, STARTUP_CACHE_DIRECTORY } = load()
    const manifest = require('../package.json')
    assert.ok(manifest.contributes.commands.some((command) => command.command === CLEAR_STARTUP_CACHE))
    assert.ok(manifest.contributes.menus.commandPalette.some((entry) => entry.command === CLEAR_STARTUP_CACHE))
    const setting = manifest.contributes.configuration.properties[`keith-vscode.${STARTUP_CACHE_SETTING}`]
    assert.equal(setting.type, 'boolean')
    assert.equal(setting.default, true)
    assert.equal(STARTUP_CACHE_DIRECTORY, 'cds')
})
