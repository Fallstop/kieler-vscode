// Trims the upstream KIELER language server fat JAR down to what the extension runs.
//
// The upstream JAR is a Tycho product export: every OSGi bundle the KIELER UI plugins
// transitively require is shaded into one archive, including the Eclipse workbench, JDT,
// ICU locale data, BouncyCastle, JNA natives for every platform and ELK's documentation
// images. None of that runs in a headless language server. This script deletes those
// packages by prefix and writes a smaller JAR.
//
// Safety net for the removals: the JVM verifier may load a class that a surviving class
// merely references in a type check, even when the code never runs. So any removed class
// that a kept class references directly is added back, together with its superclasses and
// interfaces. Everything else in a removed package is dropped. `npm run test:server` then
// exercises the real server against the result.
//
// Usage: node scripts/trim-server.cjs <input.jar> <output.jar> [--report]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

// Path prefixes (or exact files) that leave the JAR. Order does not matter.
const REMOVE = [
    'com/ibm/icu/', // ICU4J and its locale data: Eclipse text/resources dependency
    'org/bouncycastle/', // crypto provider pulled in by Equinox
    'META-INF/versions/', // multi-release overlays for BouncyCastle and Log4j 2
    'META-INF/BC1024KE.',
    'META-INF/BC2048KE.', // BouncyCastle jar signature
    'com/sun/jna/', // JNA with native libraries for every platform
    'org/eclipse/jdt/', // Java compiler and DOM behind KiCool's Java syntheses
    'org/eclipse/ui/', // Eclipse workbench
    'org/eclipse/e4/', // Eclipse 4 application platform
    'org/eclipse/help/',
    'org/eclipse/text/',
    'org/eclipse/jetty/', // Jetty 11 without websockets; server/jetty10 provides Jetty
    'org/eclipse/xtend/lib/macro/', // Xtend active-annotation API, compile time only
    'org/apache/logging/', // Log4j 2; the server logs through Log4j 1
    'org/apache/xmlgraphics/',
    'org/apache/batik/', // SVG/PNG export of Piccolo diagrams
    'org/apache/felix/', // OSGi framework implementation
    'org/tukaani/', // XZ compression
    'org/apache/commons/jxpath/',
    'org/apache/commons/cli/',
    // Eclipse workspace, file system, data binding and expressions: the server works on plain files
    'org/eclipse/core/resources/',
    'org/eclipse/core/internal/resources/',
    'org/eclipse/core/internal/localstore/',
    'org/eclipse/core/internal/events/',
    'org/eclipse/core/internal/watson/',
    'org/eclipse/core/internal/dtree/',
    'org/eclipse/core/internal/properties/',
    'org/eclipse/core/internal/refresh/',
    'org/eclipse/core/internal/propertytester/',
    'org/eclipse/core/filesystem/',
    'org/eclipse/core/internal/filesystem/',
    'org/eclipse/core/databinding/',
    'org/eclipse/core/internal/databinding/',
    'org/eclipse/core/expressions/',
    'org/eclipse/core/internal/expressions/',
    'org/eclipse/core/commands/',
    'org/eclipse/core/internal/commands/',
    'org/eclipse/core/filebuffers/',
    'org/eclipse/core/internal/filebuffers/',
    // Equinox framework internals: the server never boots OSGi
    'org/eclipse/osgi/internal/',
    'org/eclipse/osgi/container/',
    'org/eclipse/osgi/storage/',
    'org/eclipse/osgi/storagemanager/',
    'org/eclipse/osgi/launch/',
    'org/eclipse/osgi/signedcontent/',
    'org/eclipse/osgi/report/',
    'org/eclipse/emf/edit/', // EMF.Edit item providers for Eclipse editors
    // Xbase language infrastructure; only its runtime library (xbase/lib) backs the Xtend-compiled code
    ...[
        'typesystem',
        'annotations',
        'ide',
        'compiler',
        'parser',
        'scoping',
        'services',
        'formatting',
        'formatting2',
        'impl',
        'validation',
        'interpreter',
        'jvmmodel',
        'controlflow',
        'conversion',
        'documentation',
        'featurecalls',
        'file',
        'imports',
        'junit',
        'linking',
        'resource',
        'serializer',
        'testing',
        'typing',
        'util',
        'XbaseFactory',
        'XbasePackage',
        'XbaseRuntimeModule',
        'XbaseStandaloneSetup',
        'Xbase',
    ].map((name) => `org/eclipse/xtext/xbase/${name}`),
    'freemarker/ext/jsp/',
    'freemarker/ext/servlet/',
    'freemarker/ext/ant/',
    'picocli/',
    'io/github/classgraph/',
    'nonapi/io/github/classgraph/',
    'jakarta/faces/',
    'jakarta/mail/',
    'jakarta/servlet/',
    'jakarta/xml/',
    'jakarta/enterprise/',
    'jakarta/ws/',
    'jakarta/persistence/',
    'jakarta/security/',
    'jakarta/el/',
    'jakarta/validation/',
    'jakarta/activation/',
    'jakarta/json/',
    'jakarta/transaction/',
    'jakarta/websocket/',
    'jakarta/interceptor/',
    'jakarta/decorator/',
    'jakarta/authentication/',
    'jakarta/authorization/',
    'jakarta/annotation/',
    'jakarta/ejb/',
    'jakarta/jms/',
    'jakarta/batch/',
    'jakarta/resource/',
    'jakarta/xml/',
    'jakarta/jws/',
    'jakarta/mvc/',
    'jakarta/nosql/',
    'jakarta/data/',
    'javax/servlet/',
    'images/',
    'icons/',
    'fonts/',
    'resources/fonts/', // ELK documentation images and Piccolo fonts
    'krendering.png',
    'model/krendering.png',
    'model/kexpressions.png',
    'model/kgraph.png',
    'OSGI-OPT/', // source attachments
    'META-INF/maven/',
    'dtds/', // Eclipse help DTDs
]
// Anything with these extensions is reference material, never read at runtime.
const REMOVE_EXTENSIONS = ['.java', '.xtend', '.ecorediag', '.aird', '.md', '.html', '.htm']
// Files that get removed by extension but are needed anyway.
const KEEP_FILES = new Set(['about.html'])

function removedByRule(entry) {
    if (KEEP_FILES.has(entry)) return false
    if (REMOVE.some((prefix) => entry.startsWith(prefix))) return true
    return REMOVE_EXTENSIONS.some((extension) => entry.endsWith(extension))
}

// --- Minimal class-file reader: referenced class names, superclass and interfaces. ---
function readClass(buffer) {
    let offset = 8
    const count = buffer.readUInt16BE(offset)
    offset += 2
    const utf8 = new Map()
    const classRefs = []
    const pool = new Array(count)
    for (let index = 1; index < count; index++) {
        const tag = buffer[offset]
        offset += 1
        switch (tag) {
            case 1: {
                const length = buffer.readUInt16BE(offset)
                utf8.set(index, buffer.toString('utf8', offset + 2, offset + 2 + length))
                offset += 2 + length
                break
            }
            case 7:
                classRefs.push(buffer.readUInt16BE(offset))
                pool[index] = buffer.readUInt16BE(offset)
                offset += 2
                break
            case 8:
            case 16:
            case 19:
            case 20:
                offset += 2
                break
            case 15:
                offset += 3
                break
            case 3:
            case 4:
            case 9:
            case 10:
            case 11:
            case 12:
            case 17:
            case 18:
                offset += 4
                break
            case 5:
            case 6:
                offset += 8
                index += 1
                break
            default:
                throw new Error(`unknown constant pool tag ${tag}`)
        }
    }
    offset += 2 // access flags
    offset += 2 // this class
    const superIndex = buffer.readUInt16BE(offset)
    offset += 2
    const interfaceCount = buffer.readUInt16BE(offset)
    offset += 2
    const supertypes = []
    if (superIndex !== 0) supertypes.push(utf8.get(pool[superIndex]))
    for (let index = 0; index < interfaceCount; index++) {
        supertypes.push(utf8.get(pool[buffer.readUInt16BE(offset)]))
        offset += 2
    }
    const references = new Set()
    for (const classIndex of classRefs) {
        const name = utf8.get(classIndex)
        // Array class constants look like "[Lorg/foo/Bar;".
        for (const match of name.matchAll(/L([^;]+);/g)) references.add(match[1])
        if (!name.startsWith('[')) references.add(name)
    }
    // Descriptors and signatures name types that the verifier can check assignability against.
    for (const text of utf8.values()) {
        if (!text.includes('L') || !text.includes(';')) continue
        for (const match of text.matchAll(/L([A-Za-z0-9_$/]+)[;<]/g)) references.add(match[1])
    }
    return { supertypes, references }
}

function walk(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(file, base) : [path.relative(base, file)]
    })
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })
    if (result.error) throw new Error(`${command}: ${result.error.message} (is ${command} installed?)`)
    if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed (${result.status})`)
    return result
}

function trim(input, output, { report = false } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-lab-trim-'))
    try {
        run('unzip', ['-q', '-o', input, '-d', work])
        const entries = walk(work)
        const kept = new Set()
        const removed = new Set()
        for (const entry of entries) (removedByRule(entry) ? removed : kept).add(entry)

        // Classes are identified by their entry name without ".class".
        const classOf = (entry) => entry.slice(0, -'.class'.length)
        const parsed = new Map()
        const info = (name) => {
            if (!parsed.has(name)) {
                const file = path.join(work, `${name}.class`)
                parsed.set(name, fs.existsSync(file) ? readClass(fs.readFileSync(file)) : null)
            }
            return parsed.get(name)
        }

        // Add back removed classes that kept classes reference, and their supertypes.
        const rescued = new Map() // class name -> first referrer
        const rescue = (name, referrer) => {
            const entry = `${name}.class`
            if (!removed.has(entry) || rescued.has(name)) return
            rescued.set(name, referrer)
            removed.delete(entry)
            kept.add(entry)
            for (const supertype of info(name)?.supertypes ?? []) rescue(supertype, name)
        }
        for (const entry of [...kept]) {
            if (!entry.endsWith('.class')) continue
            const name = classOf(entry)
            for (const reference of info(name).references) rescue(reference, name)
        }

        for (const entry of removed) fs.rmSync(path.join(work, entry))
        // Drop directories that ended up empty so the archive carries no dead folders.
        run('find', [work, '-type', 'd', '-empty', '-delete'])
        // Service files that now list vanished implementations would break ServiceLoader.
        const services = path.join(work, 'META-INF/services')
        for (const service of fs.readdirSync(services)) {
            const file = path.join(services, service)
            if (!kept.has(`META-INF/services/${service}`)) continue
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
            const alive = lines.filter((line) => {
                const name = line.replace(/#.*/, '').trim()
                return name === '' || kept.has(`${name.replace(/\./g, '/')}.class`)
            })
            if (alive.every((line) => line.replace(/#.*/, '').trim() === '')) fs.rmSync(file)
            else fs.writeFileSync(file, `${alive.join('\n')}\n`)
        }

        fs.rmSync(output, { force: true })
        // Manifest first, then a sorted listing, so the archive is reproducible. Directory entries
        // stay in: KiCool resolves resource folders such as resources/c through the class loader,
        // which only works when the JAR lists the folder itself.
        const manifest = 'META-INF/MANIFEST.MF'
        const directories = new Set()
        for (const entry of kept) {
            for (let slash = entry.indexOf('/'); slash !== -1; slash = entry.indexOf('/', slash + 1)) {
                directories.add(`${entry.slice(0, slash)}/`)
            }
        }
        const listing = [manifest, ...[...kept, ...directories].filter((entry) => entry !== manifest).sort()].join('\n')
        run('zip', ['-q', '-9', '-X', '-@', path.resolve(output)], {
            cwd: work,
            input: listing,
            stdio: ['pipe', 'pipe', 'inherit'],
        })

        const before = fs.statSync(input).size
        const after = fs.statSync(output).size
        console.log(
            `trimmed ${path.basename(input)}: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB, ${
                entries.length
            } -> ${kept.size} entries`
        )
        if (report) {
            console.log(`rescued ${rescued.size} classes referenced from kept code:`)
            const byPackage = new Map()
            for (const [name, referrer] of rescued) {
                const key = name.split('/').slice(0, 3).join('/')
                if (!byPackage.has(key)) byPackage.set(key, [])
                byPackage.get(key).push(`${name} <- ${referrer}`)
            }
            for (const [key, names] of [...byPackage].sort((a, b) => b[1].length - a[1].length)) {
                console.log(`  ${names.length.toString().padStart(5)} ${key}`)
                for (const line of names.slice(0, 5)) console.log(`          ${line}`)
            }
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true })
    }
}

if (require.main === module) {
    const [input, output] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
    if (!input || !output) {
        console.error('usage: node scripts/trim-server.cjs <input.jar> <output.jar> [--report]')
        process.exit(2)
    }
    trim(input, output, { report: process.argv.includes('--report') })
}

module.exports = { trim, REMOVE }
