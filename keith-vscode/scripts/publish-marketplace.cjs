// Publishes a vsix with vsce's own gallery client, but with a long socket timeout. vsce hard-codes
// typed-rest-client's three-minute default, which the Marketplace exceeds while processing this
// extension's 86 MB package. Usage: VSCE_PAT=... node publish-marketplace.cjs file.vsix
const fs = require('node:fs')
const path = require('node:path')
const { GalleryApi } = require('azure-devops-node-api/GalleryApi')
const { getBasicHandler } = require('azure-devops-node-api/WebApi')

const vsix = path.resolve(process.argv[2] || '')
const pat = process.env.VSCE_PAT
if (!fs.existsSync(vsix) || !pat) {
    console.error('Usage: VSCE_PAT=<token> node publish-marketplace.cjs <file.vsix>')
    process.exit(2)
}
const { publisher, name, version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
const id = `${publisher}.${name}`
const api = new GalleryApi('https://marketplace.visualstudio.com', [getBasicHandler('OAuth', pat)], { socketTimeout: 30 * 60 * 1000 })

async function main() {
    let existing = null
    try {
        existing = await api.getExtension(null, publisher, name, undefined, 1 /* IncludeVersions */)
    } catch (error) {
        if (error.statusCode !== 404) throw error
    }
    if (existing?.versions?.some((entry) => entry.version === version)) {
        console.log(`${id} v${version} is already published.`)
        return
    }
    const started = Date.now()
    console.log(`${existing ? 'Updating' : 'Creating'} ${id} v${version} from ${path.basename(vsix)}...`)
    try {
        if (existing) await api.updateExtension(undefined, fs.createReadStream(vsix), publisher, name)
        else await api.createExtension(undefined, fs.createReadStream(vsix))
    } catch (error) {
        if (error.statusCode === 409) {
            console.log(`${id} v${version} already exists.`)
            return
        }
        throw error
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    console.log(`Published ${id} v${version} in ${seconds}s: https://marketplace.visualstudio.com/items?itemName=${id}`)
}

main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
})
