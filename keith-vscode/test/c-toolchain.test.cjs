const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({})('src/runtime/c-toolchain.ts')

test('an explicit compiler setting is used when present and never silently replaced', () => {
    const { findCCompiler } = load()
    const fileSystem = { existsSync: (file) => file === 'C:\\mingw\\bin\\gcc.exe' }
    const which = (program) => (program === 'gcc' ? '/usr/bin/gcc' : program === 'clang' ? '/usr/bin/clang' : undefined)
    assert.deepEqual(findCCompiler({ settingPath: 'C:\\mingw\\bin\\gcc.exe', platform: 'win32', fileSystem, which }), { command: 'C:\\mingw\\bin\\gcc.exe', source: 'setting' })
    assert.deepEqual(findCCompiler({ settingPath: 'clang', platform: 'linux', fileSystem, which }), { command: 'clang', source: 'setting' })
    assert.equal(findCCompiler({ settingPath: 'C:\\nowhere\\gcc.exe', platform: 'win32', fileSystem, which }), undefined)
    assert.equal(findCCompiler({ settingPath: 'tcc', platform: 'linux', fileSystem, which }), undefined)
})

test('the downloaded toolchain beats PATH, and PATH is the fallback', () => {
    const { findCCompiler } = load()
    const downloaded = 'C:\\store\\w64devkit\\2.9.1\\w64devkit\\bin\\gcc.exe'
    const fileSystem = { existsSync: (file) => file === downloaded }
    assert.deepEqual(findCCompiler({ downloadedGcc: downloaded, platform: 'win32', fileSystem, which: () => 'C:\\msys\\gcc.exe' }), { command: downloaded, source: 'downloaded' })
    assert.deepEqual(findCCompiler({ downloadedGcc: 'C:\\gone\\gcc.exe', platform: 'win32', fileSystem, which: () => 'C:\\msys\\gcc.exe' }), { command: 'gcc', source: 'PATH' })
    assert.equal(findCCompiler({ platform: 'win32', fileSystem, which: () => undefined }), undefined)
})

test('macOS needs the Command Line Tools even though /usr/bin/gcc always exists', () => {
    const { findCCompiler } = load()
    const which = () => '/usr/bin/gcc'
    assert.equal(findCCompiler({ platform: 'darwin', which, commandLineToolsInstalled: () => false, fileSystem: { existsSync: () => false } }), undefined)
    assert.deepEqual(findCCompiler({ platform: 'darwin', which, commandLineToolsInstalled: () => true, fileSystem: { existsSync: () => false } }), { command: 'gcc', source: 'PATH' })
})

test('install hints name the platform-specific way out', () => {
    const { installHint } = load()
    assert.match(installHint('win32'), /w64devkit/)
    assert.match(installHint('darwin'), /xcode-select --install/)
    assert.match(installHint('linux'), /apt install build-essential/)
})

test('the server environment gets the toolchain and runtime directories in front of PATH', () => {
    const { serverEnvironment } = load()
    const windows = serverEnvironment({ Path: 'C:\\Windows', HOME: 'x' }, ['C:\\w64devkit\\bin', 'C:\\jre\\bin'], 'win32')
    assert.equal(windows.Path, 'C:\\w64devkit\\bin;C:\\jre\\bin;C:\\Windows')
    assert.equal(windows.PATH, undefined)
    assert.equal(windows.HOME, 'x')
    const unix = serverEnvironment({ PATH: '/usr/bin' }, ['/ext/server/jre/bin'], 'linux')
    assert.equal(unix.PATH, '/ext/server/jre/bin:/usr/bin')
    assert.deepEqual(serverEnvironment({ PATH: '/usr/bin' }, [], 'linux'), { PATH: '/usr/bin' })
})

test('the w64devkit installer lays out a versioned, stamped directory', () => {
    const { W64DevkitInstaller } = load()
    const installer = new W64DevkitInstaller('/store', { version: '2.9.1', url: 'https://example/w.7z.exe', sha256: 'abc', size: 1, gcc: 'w64devkit/bin/gcc.exe' })
    assert.equal(installer.directory, require('node:path').join('/store', 'w64devkit', '2.9.1'))
    assert.equal(installer.gcc, require('node:path').join('/store', 'w64devkit', '2.9.1', 'w64devkit', 'bin', 'gcc.exe'))
    assert.equal(installer.isInstalled(), false)
})
