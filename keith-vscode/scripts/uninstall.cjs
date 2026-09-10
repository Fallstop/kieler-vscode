// Runs when SCCharts Lab has been uninstalled (VS Code invokes "vscode:uninstall" on its next start
// after the uninstall, with plain Node and no extension API). The extension folder, and with it the
// bundled Java runtime, is removed by VS Code. What VS Code does not reliably remove is the global
// storage folder in which the extension keeps the downloaded w64devkit toolchain, so it is deleted here.
//
// The extension records its global storage path in uninstall.json next to this script on every
// activation, because the hook has no way to ask VS Code for it.
const fs = require('node:fs')
const path = require('node:path')

const record = path.join(__dirname, '..', 'uninstall.json')
let storage
try {
    storage = JSON.parse(fs.readFileSync(record, 'utf8')).globalStorage
} catch {
    // Never activated: nothing was downloaded.
    process.exit(0)
}
if (typeof storage !== 'string' || !path.isAbsolute(storage)) process.exit(0)

const toolchain = path.join(storage, 'w64devkit')
if (fs.existsSync(toolchain)) {
    fs.rmSync(toolchain, { recursive: true, force: true })
    console.log(`SCCharts Lab: removed the downloaded C toolchain at ${toolchain}`)
}
try {
    // Leave nothing behind when that was the only content.
    if (fs.existsSync(storage) && fs.readdirSync(storage).length === 0) fs.rmdirSync(storage)
} catch {
    // Another VS Code instance may still hold it; harmless.
}
