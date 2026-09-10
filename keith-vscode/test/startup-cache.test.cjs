const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({})('src/runtime/startup-cache.ts')

/** An in-memory file system with just the operations the cache uses. */
function fakeFileSystem(files = {}) {
    const store = new Map(Object.entries(files).map(([file, content]) => [file, { content, mtimeMs: 1000 }]))
    return {
        store,
        existsSync: (file) => store.has(file) || [...store.keys()].some((f) => f.startsWith(`${file}${path.sep}`)),
        statSync: (file) => {
            const entry = store.get(file)
            if (!entry) throw new Error(`ENOENT ${file}`)
            return { size: Buffer.byteLength(entry.content), mtimeMs: entry.mtimeMs }
        },
        mkdirSync: () => undefined,
        rmSync: (file, options = {}) => {
            for (const key of [...store.keys()]) {
                if (key === file || (options.recursive && key.startsWith(`${file}${path.sep}`))) store.delete(key)
            }
        },
        readdirSync: (directory) => [
            ...new Set(
                [...store.keys()]
                    .filter((f) => f.startsWith(`${directory}${path.sep}`))
                    .map((f) => path.relative(directory, f).split(path.sep)[0])
            ),
        ],
        renameSync: (from, to) => {
            store.set(to, store.get(from))
            store.delete(from)
        },
        writeFileSync: (file, content) => store.set(file, { content, mtimeMs: 2000 }),
        readFileSync: (file) => store.get(file).content,
        readHead: (file) => Buffer.from(store.get(file).content.slice(0, 1024 * 1024)),
    }
}

const jar = '/ext/server/sccharts-lite-server.jar'
const runtime = { command: '/ext/server/jre/bin/java', description: 'Temurin-21.0.12.1+1' }
const root = '/storage/cds'

test('the archive key pins the jar bytes, size, mtime and the Java binary', () => {
    const { archiveKey } = load()
    const fileSystem = fakeFileSystem({ [jar]: 'PK build one' })
    const key = archiveKey(jar, runtime, fileSystem)
    assert.match(key, /^[0-9a-f]{16}$/)
    assert.equal(archiveKey(jar, runtime, fileSystem), key, 'stable for the same inputs')
    fileSystem.store.get(jar).content = 'PK build two'
    const otherContent = archiveKey(jar, runtime, fileSystem)
    assert.notEqual(otherContent, key)
    fileSystem.store.get(jar).mtimeMs = 5000
    assert.notEqual(
        archiveKey(jar, runtime, fileSystem),
        otherContent,
        'a rebuilt jar with the same bytes still changes the key'
    )
    assert.notEqual(
        archiveKey(jar, { ...runtime, description: 'Temurin-21.0.13+1' }, fileSystem),
        archiveKey(jar, runtime, fileSystem),
        'a runtime update invalidates it'
    )
    assert.notEqual(
        archiveKey(jar, { ...runtime, command: '/usr/bin/java' }, fileSystem),
        archiveKey(jar, runtime, fileSystem),
        'so does another launcher'
    )
})

test('the first start records the class list, the dump builds the archive, later starts map it', () => {
    const { StartupCache, JVM_LOGGING_ARGS } = load()
    const fileSystem = fakeFileSystem()
    const cache = new StartupCache(root, 'abc', fileSystem)
    assert.equal(cache.directory, path.join(root, 'abc'))
    assert.deepEqual(JVM_LOGGING_ARGS, ['-Xlog:disable', '-Xlog:all=warning:stderr'])

    const first = cache.launchArguments()
    assert.equal(first.state, 'empty')
    assert.deepEqual(first.args, [`-XX:DumpLoadedClassList=${cache.classList}`])
    assert.equal(cache.needsDump(), false, 'nothing to dump before the list exists')

    // An empty list (the JVM died before loading anything) does not count.
    fileSystem.writeFileSync(cache.classList, '')
    assert.equal(cache.state(), 'empty')
    fileSystem.writeFileSync(cache.classList, 'java/lang/Object\n@lambda-proxy ...\n')
    assert.equal(cache.state(), 'classlist')
    assert.deepEqual(
        cache.launchArguments(),
        { state: 'classlist', args: [] },
        'the server starts plainly while the dump is pending'
    )
    assert.equal(cache.needsDump(), true)

    cache.beginDump(10_000)
    assert.equal(cache.needsDump(10_001), false, 'a running dump is not started twice')
    assert.equal(cache.needsDump(10_000 + 11 * 60 * 1000), true, 'a dump that never finished is retried')
    assert.deepEqual(cache.dumpArguments(jar), [
        '-Xshare:dump',
        `-XX:SharedClassListFile=${cache.classList}`,
        `-XX:SharedArchiveFile=${path.join(cache.directory, 'server.jsa.tmp')}`,
        '-Djava.awt.headless=true',
        '-cp',
        jar,
    ])
    fileSystem.writeFileSync(path.join(cache.directory, 'server.jsa.tmp'), 'archive bytes')
    cache.completeDump(true)
    assert.equal(cache.state(), 'archive')
    assert.equal(fileSystem.existsSync(path.join(cache.directory, 'dump.lock')), false)
    const later = cache.launchArguments()
    assert.equal(later.state, 'archive')
    assert.deepEqual(later.args, [`-XX:SharedArchiveFile=${cache.archive}`, '-Xshare:auto', '-XX:+VerifySharedSpaces'])
    assert.equal(cache.needsDump(), false)
})

test('a failed dump is remembered instead of retried on every start', () => {
    const { StartupCache } = load()
    const fileSystem = fakeFileSystem()
    const cache = new StartupCache(root, 'abc', fileSystem)
    fileSystem.writeFileSync(cache.classList, 'java/lang/Object\n')
    cache.beginDump()
    cache.completeDump(false)
    assert.equal(cache.state(), 'failed')
    assert.deepEqual(cache.launchArguments(), { state: 'failed', args: [] })
    assert.equal(cache.needsDump(), false)
    assert.equal(fileSystem.existsSync(path.join(cache.directory, 'server.jsa.tmp')), false)
})

test('a crash right after starting with the archive discards it; a later or clean exit does not', () => {
    const { StartupCache } = load()
    const fileSystem = fakeFileSystem()
    const cache = new StartupCache(root, 'abc', fileSystem)
    fileSystem.writeFileSync(cache.archive, 'archive bytes')
    const plan = cache.launchArguments()
    assert.equal(plan.state, 'archive')
    assert.equal(cache.handleExit(plan, 0, null, 500), false, 'a clean exit')
    assert.equal(cache.handleExit(plan, 1, null, 3_600_000), false, 'a failure an hour later is not the archive')
    assert.equal(cache.handleExit({ state: 'empty', args: [] }, 134, null, 500), false, 'no archive was in use')
    assert.equal(cache.state(), 'archive')
    assert.equal(cache.handleExit(plan, null, 'SIGSEGV', 800), true)
    assert.equal(cache.state(), 'failed')
    assert.equal(fileSystem.existsSync(cache.archive), false)
    assert.match(fileSystem.readFileSync(path.join(cache.directory, 'dump-failed'), 'utf8'), /SIGSEGV after 800 ms/)
})

test('archives of other jars and runtimes are deleted, and clear removes everything', () => {
    const { StartupCache } = load()
    const fileSystem = fakeFileSystem({
        [path.join(root, 'old1', 'server.jsa')]: 'x',
        [path.join(root, 'old2', 'classes.lst')]: 'x',
        [path.join(root, 'current', 'server.jsa')]: 'x',
    })
    const cache = new StartupCache(root, 'current', fileSystem)
    assert.deepEqual(cache.removeOthers().sort(), ['old1', 'old2'])
    assert.deepEqual(cache.removeOthers(), [])
    assert.equal(cache.state(), 'archive')
    StartupCache.clear(root, fileSystem)
    assert.equal(fileSystem.store.size, 0)
    assert.deepEqual(new StartupCache(root, 'current', fileSystem).removeOthers(), [], 'a missing root is fine')
})
