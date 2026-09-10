const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

// Lays out an installed extension folder with the hook and the storage record it reads.
function install(record) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-uninstall-'))
    const extension = path.join(root, 'extension')
    fs.mkdirSync(path.join(extension, 'scripts'), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../scripts/uninstall.cjs'), path.join(extension, 'scripts/uninstall.cjs'))
    const storage = path.join(root, 'globalStorage', 'qinnovate.sccharts-lab')
    fs.mkdirSync(path.join(storage, 'w64devkit', '2.9.1', 'w64devkit', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(storage, 'w64devkit', '2.9.1', 'w64devkit', 'bin', 'gcc.exe'), '')
    if (record !== undefined) fs.writeFileSync(path.join(extension, 'uninstall.json'), record === 'storage' ? JSON.stringify({ globalStorage: storage }) : record)
    const run = () => spawnSync(process.execPath, [path.join(extension, 'scripts/uninstall.cjs')], { cwd: extension, encoding: 'utf8' })
    return { root, storage, run }
}

test('uninstalling removes the downloaded toolchain and the emptied storage folder', () => {
    const { root, storage, run } = install('storage')
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /removed the downloaded C toolchain/)
    assert.equal(fs.existsSync(storage), false)
    fs.rmSync(root, { recursive: true, force: true })
})

test('other files in the storage folder are kept', () => {
    const { root, storage, run } = install('storage')
    fs.writeFileSync(path.join(storage, 'notes.txt'), 'keep')
    assert.equal(run().status, 0)
    assert.equal(fs.existsSync(path.join(storage, 'w64devkit')), false)
    assert.equal(fs.readFileSync(path.join(storage, 'notes.txt'), 'utf8'), 'keep')
    fs.rmSync(root, { recursive: true, force: true })
})

test('a missing or broken record is not an error and touches nothing', () => {
    for (const record of [undefined, 'not json', JSON.stringify({ globalStorage: 'relative/path' })]) {
        const { root, storage, run } = install(record)
        const result = run()
        assert.equal(result.status, 0, result.stderr)
        assert.equal(fs.existsSync(path.join(storage, 'w64devkit')), true)
        fs.rmSync(root, { recursive: true, force: true })
    }
})
