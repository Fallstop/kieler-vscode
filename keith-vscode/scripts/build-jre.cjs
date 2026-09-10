// Builds the Java runtime that ships inside a platform-specific VSIX.
//
//   node scripts/build-jre.cjs --target <linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64>
//   node scripts/build-jre.cjs --clean
//   node scripts/build-jre.cjs --refresh <temurin release name, e.g. jdk-21.0.12.1+1>
//
// The runtime is a jlink image, not a stock JRE: server/runtime-manifest.json pins one Eclipse
// Temurin JDK release (URL and sha256 per platform) and the module list the language server
// needs. jlink links an image for any platform from that platform's jmods, so one Linux machine
// produces all six runtimes. jlink insists that its own version equals the target java.base, so
// the host's JDK of the same release is downloaded too and its jlink is used.
//
// Result: server/jre/ with bin/java[.exe] at the top level plus server/jre/sccharts-runtime.json.
// Downloads are cached in out/runtime-cache/ (git-ignored) keyed by sha256.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(root, 'server/runtime-manifest.json')
const output = path.join(root, 'server/jre')
const cache = path.join(root, 'out/runtime-cache')

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']
// VS Code target -> Adoptium API (os, architecture)
const ADOPTIUM = {
    'linux-x64': ['linux', 'x64'],
    'linux-arm64': ['linux', 'aarch64'],
    'darwin-x64': ['mac', 'x64'],
    'darwin-arm64': ['mac', 'aarch64'],
    'win32-x64': ['windows', 'x64'],
    'win32-arm64': ['windows', 'aarch64'],
}

function fail(message) {
    console.error(message)
    process.exit(1)
}

function readManifest() {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function hostTarget() {
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return `${platform}-${arch}`
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fetch(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'user-agent': 'sccharts-lab-build' } }, (response) => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
                    response.resume()
                    resolve(fetch(new URL(response.headers.location, url).href, redirects - 1))
                    return
                }
                if (response.statusCode !== 200) {
                    response.resume()
                    reject(new Error(`${url}: HTTP ${response.statusCode}`))
                    return
                }
                const chunks = []
                response.on('data', (chunk) => chunks.push(chunk))
                response.on('end', () => resolve(Buffer.concat(chunks)))
                response.on('error', reject)
            })
            .on('error', reject)
    })
}

/** Downloads an archive into the cache (once) and returns the verified file path. */
async function download(entry) {
    fs.mkdirSync(cache, { recursive: true })
    const name = path.basename(new URL(entry.url).pathname)
    const file = path.join(cache, `${entry.sha256.slice(0, 12)}-${name}`)
    if (fs.existsSync(file) && sha256(file) === entry.sha256) {
        return file
    }
    console.log(`Downloading ${entry.url}`)
    const data = await fetch(entry.url)
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== entry.sha256) {
        fail(`Checksum mismatch for ${name}: expected ${entry.sha256}, got ${actual}`)
    }
    fs.writeFileSync(file, data)
    return file
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options })
    if (result.error) throw result.error
    if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/** Extracts a Temurin archive into the cache and returns the JDK home (the directory with jmods/). */
function extractJdk(archive, target) {
    const home = path.join(cache, `jdk-${target}-${path.basename(archive).slice(0, 12)}`)
    const marker = path.join(home, '.extracted')
    if (!fs.existsSync(marker)) {
        fs.rmSync(home, { recursive: true, force: true })
        fs.mkdirSync(home, { recursive: true })
        if (archive.endsWith('.zip')) {
            // GNU tar cannot read zip; bsdtar (macOS, Windows) can, unzip exists on Linux runners.
            const unzip = spawnSync('unzip', ['-q', archive, '-d', home], { stdio: 'inherit' })
            if (unzip.error || unzip.status !== 0) run('tar', ['-xf', archive, '-C', home])
        } else {
            run('tar', ['-xzf', archive, '-C', home])
        }
        fs.writeFileSync(marker, '')
    }
    const jmods = findDirectory(home, 'jmods', 4)
    if (!jmods) fail(`No jmods directory inside ${archive}`)
    return path.dirname(jmods)
}

function findDirectory(start, name, depth) {
    if (depth < 0 || !fs.existsSync(start)) return undefined
    for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = path.join(start, entry.name)
        if (entry.name === name) return candidate
        const nested = findDirectory(candidate, name, depth - 1)
        if (nested) return nested
    }
    return undefined
}

async function build(target) {
    if (!TARGETS.includes(target)) fail(`Unknown target ${target}. One of: ${TARGETS.join(', ')}`)
    const manifest = readManifest()
    const java = manifest.java
    const entry = java.platforms[target]
    const host = hostTarget()
    const hostEntry = java.platforms[host]
    if (!entry) fail(`No ${target} entry in ${path.relative(root, manifestPath)}`)
    if (!hostEntry) fail(`This machine (${host}) has no JDK entry to run jlink with`)

    const targetHome = extractJdk(await download(entry), target)
    const hostHome = target === host ? targetHome : extractJdk(await download(hostEntry), host)
    const jlink = path.join(hostHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink')

    fs.rmSync(output, { recursive: true, force: true })
    console.log(`Linking ${java.release} for ${target} with ${java.modules.length} modules`)
    run(jlink, [
        '--module-path',
        path.join(targetHome, 'jmods'),
        '--add-modules',
        java.modules.join(','),
        ...java.jlink,
        '--output',
        output,
    ])

    const launcher = path.join(output, 'bin', target.startsWith('win32') ? 'java.exe' : 'java')
    if (!fs.existsSync(launcher)) fail(`jlink produced no launcher at ${launcher}`)
    fs.writeFileSync(
        path.join(output, 'sccharts-runtime.json'),
        `${JSON.stringify({ target, distribution: java.distribution, release: java.release, modules: java.modules }, null, 2)}\n`
    )
    if (target === host) {
        run(launcher, ['-version'])
    }
    const size = directorySize(output)
    console.log(`Runtime ready in ${path.relative(root, output)} (${(size / 1e6).toFixed(0)} MB on disk)`)
}

function directorySize(directory) {
    let total = 0
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        total += entry.isDirectory() ? directorySize(file) : fs.statSync(file).size
    }
    return total
}

/** Rewrites the Java platform entries from the Adoptium API for the given release name. */
async function refresh(release) {
    const manifest = readManifest()
    const api = `https://api.adoptium.net/v3/assets/release_name/eclipse/${encodeURIComponent(release)}?image_type=jdk&heap_size=normal&project=jdk`
    const info = JSON.parse((await fetch(api)).toString('utf8'))
    const platforms = {}
    for (const target of TARGETS) {
        const [osName, arch] = ADOPTIUM[target]
        const binary = info.binaries.find((b) => b.os === osName && b.architecture === arch && b.image_type === 'jdk')
        if (!binary) fail(`${release} has no JDK for ${target}`)
        platforms[target] = { url: binary.package.link, sha256: binary.package.checksum, size: binary.package.size }
    }
    const previous = manifest.java.release
    manifest.java.release = info.release_name
    manifest.java.feature = info.version_data.major
    manifest.java.platforms = platforms
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`${path.relative(root, manifestPath)}: ${previous} -> ${info.release_name}`)
}

async function main() {
    const args = process.argv.slice(2)
    const option = (name) => {
        const index = args.indexOf(name)
        return index === -1 ? undefined : (args[index + 1] ?? '')
    }
    if (args.includes('--clean')) {
        fs.rmSync(output, { recursive: true, force: true })
        console.log(`Removed ${path.relative(root, output)}`)
        return
    }
    const release = option('--refresh')
    if (release !== undefined) {
        if (!release) fail('--refresh needs a Temurin release name such as jdk-21.0.12.1+1')
        await refresh(release)
        return
    }
    const target = option('--target') ?? (args.includes('--host') ? hostTarget() : undefined)
    if (!target) fail('Usage: build-jre.cjs --target <vscode target> | --host | --clean | --refresh <release>')
    await build(target)
}

if (require.main === module) {
    main().catch((error) => fail(error.stack ?? String(error)))
}

module.exports = { TARGETS, hostTarget }
