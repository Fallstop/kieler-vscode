// Downloads the untracked server runtime (KIELER language server + Jetty 10) into server/
// and verifies every file against server/manifest.json. Idempotent: matching files are kept.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const serverDir = path.join(root, 'server')
const manifest = JSON.parse(fs.readFileSync(path.join(serverDir, 'manifest.json'), 'utf8'))

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function upToDate(file, expected) {
    return fs.existsSync(file) && sha256(file) === expected
}
function verify(file, expected) {
    const actual = sha256(file)
    if (actual !== expected) {
        fs.rmSync(file, { force: true })
        throw new Error(`${path.relative(root, file)}: expected sha256 ${expected}, got ${actual}`)
    }
    console.log(`verified ${path.relative(root, file)}`)
}
async function download(url) {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    let bytes = Buffer.from(await response.arrayBuffer())
    // The Marketplace serves the vsix as a gzip body that some clients leave undecoded.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes)
    return bytes
}
function unzipEntry(archive, entry, destination) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-lab-server-'))
    const result = spawnSync('unzip', ['-o', '-q', archive, entry, '-d', tmp], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`unzip failed for ${entry} (is unzip installed?)`)
    fs.renameSync(path.join(tmp, entry), destination)
    fs.rmSync(tmp, { recursive: true, force: true })
}

async function main() {
    fs.mkdirSync(path.join(serverDir, 'jetty10'), { recursive: true })

    const ls = manifest.languageServer
    const lsFile = path.join(serverDir, ls.file)
    if (upToDate(lsFile, ls.sha256)) {
        console.log(`kept ${ls.file}`)
    } else {
        console.log(`downloading language server from ${ls.url}`)
        const vsix = path.join(os.tmpdir(), 'kieler-upstream.vsix')
        fs.writeFileSync(vsix, await download(ls.url))
        unzipEntry(vsix, ls.entry, lsFile)
        fs.rmSync(vsix, { force: true })
        verify(lsFile, ls.sha256)
    }

    for (const lib of manifest.jetty10) {
        const file = path.join(serverDir, 'jetty10', lib.file)
        if (upToDate(file, lib.sha256)) {
            console.log(`kept jetty10/${lib.file}`)
            continue
        }
        console.log(`downloading ${lib.url}`)
        fs.writeFileSync(file, await download(lib.url))
        verify(file, lib.sha256)
    }
}

main().catch(error => {
    console.error(error.message)
    process.exit(1)
})
