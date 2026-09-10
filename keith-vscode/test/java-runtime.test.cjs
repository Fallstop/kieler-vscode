const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({})('src/runtime/java-runtime.ts')

const TEMURIN = 'openjdk version "21.0.12.1" 2026-08-18 LTS\nOpenJDK Runtime Environment Temurin-21.0.12.1+1 (build 21.0.12.1+1-LTS)\nOpenJDK 64-Bit Server VM Temurin-21.0.12.1+1 (build 21.0.12.1+1-LTS, mixed mode, sharing)\n'
const JAVA8 = 'openjdk version "1.8.0_392"\nOpenJDK Runtime Environment (build 1.8.0_392-8u392-ga-1~22.04-b08)\nOpenJDK 64-Bit Server VM (build 25.392-b08, mixed mode)\n'
const JAVA17 = 'openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime Environment (build 17.0.9+9-Ubuntu-122.04)\n'
const ORACLE = 'java version "25" 2025-09-16 LTS\nJava(TM) SE Runtime Environment (build 25+36-LTS-3489)\n'

test('java -version output is parsed for every numbering scheme', () => {
    const { parseJavaVersion, describeJavaVersion } = load()
    assert.equal(parseJavaVersion(TEMURIN), 21)
    assert.equal(parseJavaVersion(JAVA8), 8)
    assert.equal(parseJavaVersion(JAVA17), 17)
    assert.equal(parseJavaVersion(ORACLE), 25)
    assert.equal(parseJavaVersion('bash: java: command not found'), undefined)
    assert.equal(describeJavaVersion(TEMURIN), 'Temurin-21.0.12.1+1')
    assert.equal(describeJavaVersion(ORACLE), '25')
})

function fakeFileSystem(existing, modes = {}) {
    const files = new Set(existing)
    const chmods = []
    return {
        chmods,
        existsSync: (file) => files.has(file),
        accessSync: (file) => { if (modes[file] === 'noexec') throw new Error('EACCES') },
        chmodSync: (file, mode) => { chmods.push([file, mode]); modes[file] = 'exec' },
        readdirSync: (directory) => [...files].filter((file) => path.dirname(file) === directory).map((file) => path.basename(file)),
        statSync: () => ({ isFile: () => true }),
    }
}

test('the bundled runtime wins over every other source', async () => {
    const { findJava } = load()
    const extensionPath = '/ext'
    const bundled = '/ext/server/jre/bin/java'
    const fileSystem = fakeFileSystem([bundled, '/opt/jdk/bin/java'])
    const probed = []
    const result = await findJava({
        extensionPath, javaHome: '/opt/jdk', env: { JAVA_HOME: '/usr/lib/jvm/java-17' }, platform: 'linux', fileSystem,
        probe: async (command) => { probed.push(command); return TEMURIN },
    })
    assert.equal(result.runtime.source, 'bundled')
    assert.equal(result.runtime.command, bundled)
    assert.equal(result.runtime.home, '/ext/server/jre')
    assert.equal(result.runtime.version, 21)
    assert.deepEqual(probed, [bundled])
    assert.deepEqual(result.rejected, [])
})

test('old, broken and missing candidates are rejected in order until one qualifies', async () => {
    const { findJava } = load()
    const fileSystem = fakeFileSystem(['/opt/jdk17/bin/java', '/opt/jdk8/bin/java'])
    const outputs = { '/opt/jdk17/bin/java': JAVA17, '/opt/jdk8/bin/java': JAVA8, java: TEMURIN }
    const result = await findJava({
        extensionPath: '/ext', javaHome: '/opt/jdk17', env: { JDK_HOME: '/opt/jdk8', JAVA_HOME: '/missing' }, platform: 'linux', fileSystem,
        probe: async (command) => outputs[command],
    })
    assert.equal(result.runtime.source, 'PATH')
    assert.equal(result.runtime.command, 'java')
    assert.deepEqual(result.rejected.map((entry) => [entry.source, entry.problem]), [
        ['setting', 'Java 17 is too old, 21 or newer is required'],
        ['JDK_HOME', 'Java 8 is too old, 21 or newer is required'],
        ['JAVA_HOME', 'no java launcher at this path'],
    ])
})

test('no usable Java explains every candidate', async () => {
    const { findJava, explainMissingJava } = load()
    const result = await findJava({
        extensionPath: '/ext', env: {}, platform: 'win32', fileSystem: fakeFileSystem([]),
        probe: async () => { throw new Error('spawn java.exe ENOENT') },
    })
    assert.equal(result.runtime, undefined)
    assert.match(explainMissingJava(result), /PATH: java\.exe \(spawn java\.exe ENOENT\)/)
})

test('a setting may point at the launcher itself and uses java.exe on Windows', () => {
    const { javaCandidates } = load()
    const candidates = javaCandidates({ extensionPath: 'C:\\ext', javaHome: 'C:\\jdk\\bin\\java.exe', env: { JAVA_HOME: 'C:\\other' }, platform: 'win32', fileSystem: fakeFileSystem([]) })
    assert.deepEqual(candidates.map((candidate) => [candidate.source, candidate.command]), [
        ['setting', 'C:\\jdk\\bin\\java.exe'],
        ['JAVA_HOME', path.join('C:\\other', 'bin', 'java.exe')],
        ['PATH', 'java.exe'],
    ])
})

test('the bundled launcher and jspawnhelper get their execute bit back', async () => {
    const { findJava } = load()
    const files = ['/ext/server/jre/bin/java', '/ext/server/jre/bin/keytool', '/ext/server/jre/lib/jspawnhelper']
    const fileSystem = fakeFileSystem(files, { '/ext/server/jre/bin/java': 'noexec', '/ext/server/jre/lib/jspawnhelper': 'noexec' })
    await findJava({ extensionPath: '/ext', env: {}, platform: 'darwin', fileSystem, probe: async () => TEMURIN })
    assert.deepEqual(fileSystem.chmods, [['/ext/server/jre/bin/java', 0o755], ['/ext/server/jre/lib/jspawnhelper', 0o755]])
})
