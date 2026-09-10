const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const script = fs.readFileSync(path.join(__dirname, '../scripts/publish-marketplace.cjs'), 'utf8')
const failure = statusCode => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })

async function publish(lookups, uploadError, files = ['release.vsix']) {
    const logs = []
    const uploads = []
    let credential
    let exitCode = 0
    const api = {
        async getExtension() {
            assert.ok(lookups.length, 'Unexpected Marketplace lookup')
            const result = lookups.shift()
            if (result instanceof Error) throw result
            return result
        },
        async updateExtension() { uploads.push('update'); if (uploadError) throw uploadError },
        async createExtension() { uploads.push('create'); if (uploadError) throw uploadError },
    }
    const dependencies = {
        'node:path': path,
        'node:fs': {
            existsSync: () => true,
            readFileSync: () => JSON.stringify({ publisher: 'example', name: 'extension', version: '1.2.3' }),
            createReadStream: () => ({}),
        },
        'azure-devops-node-api/GalleryApi': { GalleryApi: function () { return api } },
        'azure-devops-node-api/WebApi': { getBasicHandler: (_, pat) => { credential = pat } },
    }
    await vm.runInNewContext(script, {
        require: name => { assert.ok(name in dependencies); return dependencies[name] },
        __dirname,
        process: { argv: ['node', 'publish-marketplace.cjs', ...files], env: { VSCE_PAT: ' secret-token\n' }, exit: code => { exitCode = code } },
        console: { log: message => logs.push(message), error: message => logs.push(message) },
    })
    return { logs: logs.join('\n'), uploads, credential, exitCode }
}

test('publishing creates or updates the extension and tolerates copied token whitespace', async () => {
    for (const [lookup, expected] of [[failure(404), 'create'], [{ versions: [{ version: '1.2.2' }] }, 'update']]) {
        const result = await publish([lookup])
        assert.deepEqual(result.uploads, [expected])
        assert.equal(result.credential, 'secret-token')
        assert.equal(result.exitCode, 0)
    }
})

test('release retries skip an existing version and verify conflicting uploads before succeeding', async () => {
    const existing = { versions: [{ version: '1.2.3' }] }
    assert.deepEqual((await publish([existing])).uploads, [])
    assert.equal((await publish([{ versions: [] }, existing], failure(409))).exitCode, 0)
    const failed = await publish([{ versions: [] }, { versions: [] }], failure(409))
    assert.equal(failed.exitCode, 1)
    assert.doesNotMatch(failed.logs, /already exists|Published/)
})

test('authentication errors identify the credential remedy without exposing the token', async () => {
    for (const status of [401, 403]) {
        for (const result of [await publish([failure(status)]), await publish([{ versions: [] }], failure(status))]) {
            assert.equal(result.exitCode, 1)
            assert.match(result.logs, /VSCE_PAT.*All accessible organizations.*Marketplace > Manage/)
            assert.doesNotMatch(result.logs, /secret-token/)
        }
    }
})

test('platform packages are matched against the target platform of published versions', async () => {
    const published = { versions: [{ version: '1.2.3', targetPlatform: 'linux-x64' }, { version: '1.2.3' }] }
    const result = await publish([published], undefined, ['sccharts-lab-linux-x64.vsix', 'sccharts-lab-win32-x64.vsix', 'sccharts-lab.vsix'])
    assert.deepEqual(result.uploads, ['update'])
    assert.match(result.logs, /\(linux-x64\) is already published/)
    assert.match(result.logs, /Published example\.extension v1\.2\.3 \(win32-x64\)/)
    assert.match(result.logs, /v1\.2\.3 is already published/)
    assert.equal(result.exitCode, 0)
})

test('the first upload of a new extension creates it and the following ones update it', async () => {
    const result = await publish([failure(404)], undefined, ['sccharts-lab-linux-x64.vsix', 'sccharts-lab.vsix'])
    assert.deepEqual(result.uploads, ['create', 'update'])
    assert.equal(result.exitCode, 0)
})
