// Builds the SCCharts Lab language server from the sccharts-lite fork and places the shaded JAR
// at server/sccharts-lite-server.jar, where the extension and the server tests expect it.
//
//   SCCHARTS_SERVER_SRC  checkout of the fork (default: ../../kieler-server-fork next to this repo)
//   SCCHARTS_SERVER_JAR  use this prebuilt JAR instead of building
//
// Building needs a JDK 21 and Maven; Maven downloads every other dependency from Maven Central.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const target = path.join(root, 'server/sccharts-lite-server.jar')

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}

let jar = process.env.SCCHARTS_SERVER_JAR
if (!jar) {
    const source = path.resolve(root, process.env.SCCHARTS_SERVER_SRC ?? '../../kieler-server-fork')
    if (!fs.existsSync(path.join(source, 'pom.xml'))) {
        if (fs.existsSync(target) && !process.argv.includes('--required')) {
            console.log(`Server sources absent at ${source}; keeping the existing ${path.relative(root, target)}.`)
            process.exit(0)
        }
        console.error(`No server checkout at ${source}. Set SCCHARTS_SERVER_SRC to the sccharts-lite fork or SCCHARTS_SERVER_JAR to a built JAR.`)
        process.exit(2)
    }
    console.log(`Building the language server in ${source}`)
    run(process.platform === 'win32' ? 'mvn.cmd' : 'mvn', ['-B', '-ntp', '-q', 'clean', 'install', '-DskipTests'], { cwd: source })
    jar = path.join(source, 'server/target/sccharts-lite-server.jar')
}
if (!fs.existsSync(jar)) {
    console.error(`Built server JAR not found at ${jar}`)
    process.exit(1)
}
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(jar, target)
console.log(`Installed ${path.relative(root, target)} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`)
