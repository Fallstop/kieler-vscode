// Publishes one or more vsix files with vsce's own gallery client, but with a long socket timeout.
// vsce hard-codes typed-rest-client's three-minute default, which the Marketplace exceeds while
// processing this extension's packages (up to 60 MB each with a bundled Java runtime).
//
// Usage: VSCE_PAT=... node publish-marketplace.cjs file.vsix [more.vsix ...]
//
// A platform-specific package is recognised by its file name, `<name>-<target>.vsix`
// (the names `yarn package:platform` produces), and is skipped when that version already exists
// for that target. The universal package has no target. Uploads run one after another because the
// Marketplace rejects concurrent updates to the same extension.
const fs = require('node:fs')
const path = require('node:path')
const { GalleryApi } = require('azure-devops-node-api/GalleryApi')
const { getBasicHandler } = require('azure-devops-node-api/WebApi')

const TARGETS = ['linux-x64', 'linux-arm64', 'linux-armhf', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']

const files = process.argv.slice(2).map((file) => path.resolve(file))
const pat = process.env.VSCE_PAT?.trim()
if (files.length === 0 || !files.every((file) => fs.existsSync(file)) || !pat) {
    console.error('Usage: VSCE_PAT=<token> node publish-marketplace.cjs <file.vsix> [more.vsix ...]')
    process.exit(2)
}
const { publisher, name, version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
const id = `${publisher}.${name}`
const api = new GalleryApi('https://marketplace.visualstudio.com', [getBasicHandler('OAuth', pat)], { socketTimeout: 30 * 60 * 1000 })

/** The VS Code target platform encoded in the file name, or undefined for a universal package. */
function targetOf(file) {
    const base = path.basename(file, '.vsix')
    return TARGETS.find((target) => base.endsWith(`-${target}`))
}

async function lookup() {
    try {
        return await api.getExtension(null, publisher, name, undefined, 1 /* IncludeVersions */)
    } catch (error) {
        if (error.statusCode !== 404) throw error
        return null
    }
}

function isPublished(extension, target) {
    return Boolean(extension?.versions?.some((entry) => entry.version === version && (entry.targetPlatform ?? undefined) === target))
}

async function publish(vsix, existing) {
    const target = targetOf(vsix)
    const label = `${id} v${version}${target ? ` (${target})` : ''}`
    if (isPublished(existing, target)) {
        console.log(`${label} is already published.`)
        return existing
    }
    const started = Date.now()
    console.log(`${existing ? 'Updating' : 'Creating'} ${label} from ${path.basename(vsix)}...`)
    try {
        if (existing) await api.updateExtension(undefined, fs.createReadStream(vsix), publisher, name)
        else await api.createExtension(undefined, fs.createReadStream(vsix))
    } catch (error) {
        if (error.statusCode === 409 && isPublished(await lookup(), target)) {
            console.log(`${label} already exists.`)
            return existing ?? {}
        }
        throw error
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    console.log(`Published ${label} in ${seconds}s: https://marketplace.visualstudio.com/items?itemName=${id}`)
    // The extension exists from now on, so later packages of this run are updates.
    return existing ?? {}
}

async function main() {
    let existing = await lookup()
    for (const vsix of files) {
        // eslint-disable-next-line no-await-in-loop
        existing = await publish(vsix, existing)
    }
}

main().catch((error) => {
    if (error.statusCode === 401 || error.statusCode === 403) {
        console.error(`Marketplace authentication failed (HTTP ${error.statusCode}) for publisher ${publisher}. ` +
            'Update the repository VSCE_PAT secret with an Azure DevOps PAT for All accessible organizations, ' +
            'with Marketplace > Manage scope, from an account allowed to publish for this publisher. ' +
            'Then rerun the failed release job; the GitHub VSIX is already available if its release step succeeded.')
    } else {
        console.error(error.message || error)
    }
    process.exit(1)
})
