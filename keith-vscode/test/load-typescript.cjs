const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

module.exports = function createLoader(mocks = {}) {
    const cache = new Map()
    function load(filename) {
        const absolute = path.resolve(__dirname, '..', filename)
        if (cache.has(absolute)) return cache.get(absolute).exports
        const module = { exports: {} }
        cache.set(absolute, module)
        const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
            fileName: absolute,
        }).outputText
        const localRequire = (name) => {
            if (Object.hasOwn(mocks, name)) return mocks[name]
            if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), `${name}.ts`))
            return require(name)
        }
        new Function('require', 'module', 'exports', source)(localRequire, module, module.exports)
        return module.exports
    }
    return load
}
