// Downloads the untracked server runtime (KIELER language server + Jetty 10) into server/
// and verifies every file against server/manifest.json. Idempotent: matching files are kept.
//
// The upstream language server JAR is cached under out/upstream/ and trimmed by
// scripts/trim-server.cjs into server/, which is what the extension runs and packages.
// A stamp next to the trimmed JAR records the upstream hash and the trim script hash,
// so the trim reruns only when either changes.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const { trim } = require('./trim-server.cjs')

const root = path.resolve(__dirname, '..')
const serverDir = path.join(root, 'server')
const upstreamDir = path.join(root, 'out', 'upstream')
const trimScript = path.join(__dirname, 'trim-server.cjs')
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
    const upstream = path.join(upstreamDir, ls.file)
    const stampFile = `${lsFile}.stamp`
    const stamp = `upstream ${ls.sha256}\ntrim ${sha256(trimScript)}\n`
    const stamped = fs.existsSync(lsFile) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp
    if (stamped) {
        console.log(`kept ${ls.file} (trimmed)`)
    } else {
        fs.mkdirSync(upstreamDir, { recursive: true })
        if (upToDate(upstream, ls.sha256)) {
            console.log(`kept upstream ${ls.file}`)
        } else if (upToDate(lsFile, ls.sha256)) {
            // An untrimmed JAR from an earlier checkout is the upstream file; keep it as the cache.
            fs.renameSync(lsFile, upstream)
            console.log(`moved untrimmed ${ls.file} to out/upstream`)
        } else {
            console.log(`downloading language server from ${ls.url}`)
            const vsix = path.join(os.tmpdir(), 'kieler-upstream.vsix')
            fs.writeFileSync(vsix, await download(ls.url))
            unzipEntry(vsix, ls.entry, upstream)
            fs.rmSync(vsix, { force: true })
            verify(upstream, ls.sha256)
        }
        fs.rmSync(stampFile, { force: true })
        trim(upstream, lsFile)
        fs.writeFileSync(stampFile, stamp)
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
