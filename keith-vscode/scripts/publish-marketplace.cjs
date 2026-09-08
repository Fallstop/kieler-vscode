// Publishes a vsix to the VS Code Marketplace with the same REST calls as `vsce publish`,
// but without vsce's fixed three-minute socket timeout, which the Marketplace exceeds while
// it processes this extension's 86 MB package. Usage: VSCE_PAT=... node publish-marketplace.cjs file.vsix
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const vsix = path.resolve(process.argv[2] || '')
const pat = process.env.VSCE_PAT
if (!fs.existsSync(vsix) || !pat) {
    console.error('Usage: VSCE_PAT=<token> node publish-marketplace.cjs <file.vsix>')
    process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
const { publisher, name, version } = manifest
const host = 'marketplace.visualstudio.com'
const apiVersion = '7.2-preview.2'
const auth = `Basic ${Buffer.from(`OAuth:${pat}`).toString('base64')}`

function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const headers = { Authorization: auth, Accept: `application/json;api-version=${apiVersion}` }
        if (body) {
            headers['Content-Type'] = 'application/octet-stream'
            headers['Content-Length'] = fs.statSync(body).size
        }
        const req = https.request({ host, method, path: urlPath, headers }, (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { text += chunk })
            res.on('end', () => resolve({ status: res.statusCode, text }))
        })
        req.on('error', reject)
        if (body) fs.createReadStream(body).pipe(req)
        else req.end()
    })
}

async function main() {
    const id = `${publisher}.${name}`
    const extensionPath = `/_apis/gallery/publishers/${publisher}/extensions/${name}?api-version=${apiVersion}`
    const existing = await request('GET', `${extensionPath}&flags=1`)
    let published = []
    if (existing.status === 200) {
        published = (JSON.parse(existing.text).versions || []).map((entry) => entry.version)
    } else if (existing.status !== 404) {
        throw new Error(`Looking up ${id} failed: HTTP ${existing.status}\n${existing.text.slice(0, 500)}`)
    }
    if (published.includes(version)) {
        console.log(`${id} v${version} is already published.`)
        return
    }
    const started = Date.now()
    console.log(`${existing.status === 200 ? 'Updating' : 'Creating'} ${id} v${version} from ${path.basename(vsix)}...`)
    const result = existing.status === 200
        ? await request('PUT', extensionPath, vsix)
        : await request('POST', `/_apis/gallery/extensions?api-version=${apiVersion}`, vsix)
    const seconds = Math.round((Date.now() - started) / 1000)
    if (result.status === 409) {
        console.log(`${id} v${version} already exists (HTTP 409 after ${seconds}s).`)
        return
    }
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`Publishing failed: HTTP ${result.status} after ${seconds}s\n${result.text.slice(0, 2000)}`)
    }
    console.log(`Published ${id} v${version} in ${seconds}s: https://marketplace.visualstudio.com/items?itemName=${id}`)
}

main().catch((error) => {
    console.error(error.message)
    process.exit(1)
})
