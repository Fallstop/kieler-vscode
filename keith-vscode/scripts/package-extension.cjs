// Packages the extension as a VSIX.
//
//   yarn package                         universal package, no bundled runtime -> sccharts-lab.vsix
//   yarn package:platform <target>       bundled Java runtime for linux-x64, linux-arm64, darwin-x64,
//                                        darwin-arm64, win32-x64 or win32-arm64 -> sccharts-lab-<target>.vsix
//
// Add --pre-release (or set SCCHARTS_PRERELEASE=true) to flag the package as a Marketplace
// pre-release version; VS Code then offers it only to users who opted into pre-releases.
// A platform package first links server/jre for the target (scripts/build-jre.cjs); the universal
// package removes any leftover server/jre so it never ships a runtime by accident.
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { TARGETS } = require('./build-jre.cjs')

const args = process.argv.slice(2)
const preRelease = args.includes('--pre-release') || /^(1|true|yes)$/i.test(process.env.SCCHARTS_PRERELEASE ?? '')
const target = args.find((arg) => !arg.startsWith('--'))
if (target && !TARGETS.includes(target)) {
    console.error(`Unknown target ${target}. One of: ${TARGETS.join(', ')}`)
    process.exit(2)
}

const root = path.resolve(__dirname, '..')
function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, [path.join(__dirname, 'build-jre.cjs'), ...(target ? ['--target', target] : ['--clean'])])
const vsce = path.resolve(root, `../node_modules/.bin/vsce${process.platform === 'win32' ? '.cmd' : ''}`)
const output = target ? `sccharts-lab-${target}.vsix` : 'sccharts-lab.vsix'
run(vsce, [
    'package',
    '--yarn',
    ...(target ? ['--target', target] : []),
    ...(preRelease ? ['--pre-release'] : []),
    '-o',
    output,
])
console.log(`${output}${preRelease ? ' (pre-release)' : ''}`)
