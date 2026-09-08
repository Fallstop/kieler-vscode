const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const server = path.join(root, 'server/kieler-language-server.jar')
if (!fs.existsSync(server)) {
    if (process.argv.includes('--required')) throw new Error('Place the KIELER server JAR in server/ before building the diagnostic patch.')
    console.log('Server JAR absent; building the client without the optional diagnostic patch.')
    process.exit(0)
}
const output = path.join(root, 'out/server-patch')
fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })
function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(dir, entry.name)
        return entry.isDirectory() ? sources(file) : file.endsWith('.java') ? [file] : []
    })
}
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}
run('javac', ['--release', '11', '-cp', server, '-d', output, ...sources(path.join(root, 'server-src'))])
run('java', ['-cp', `${output}${path.delimiter}${server}`, 'org.kieler.vscode.diagnostics.BuildPatch', server, output])
const helper = 'org/kieler/vscode/diagnostics/simulation-strings.c'
fs.copyFileSync(path.join(root, 'server-src', helper), path.join(output, helper))
run('jar', ['cf', path.join(root, 'server/diagnostics.jar'), '-C', output, '.'])
console.log('Built server/diagnostics.jar')
