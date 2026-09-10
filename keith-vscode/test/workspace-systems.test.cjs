const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` })
const vscode = {
    QuickPickItemKind: { Separator: -1, Default: 0 },
    Uri: { parse: (value) => uri(decodeURIComponent(value.replace(/^file:\/\/\//, '/'))) },
    workspace: { workspaceFolders: [{ uri: uri('/home/me/project') }], getConfiguration: () => ({ get: () => [] }) },
    window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        setStatusBarMessage() {},
        showWarningMessage: async () => undefined,
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
}
const load = createLoader({ vscode, 'vscode-languageclient/node': {} })
const {
    groupSystemsForQuickPick,
    pickedSystem,
    describeSource,
    systemFoldersParam,
    changeMessages,
    SYSTEM_TEMPLATE,
    WorkspaceSystems,
} = load('src/kico/workspace-systems.ts')

const systems = [
    { id: 'de.cau.cs.kieler.sccharts.netlist', label: 'Netlist-based Compilation (C)' },
    { id: 'my.custom', label: 'My Custom C', source: 'file:///home/me/project/kico/my.kico' },
    { id: 'team.shared', label: 'Team system', source: 'file:///srv/shared/team.kico' },
]

test('workspace systems are grouped first with their file, built-in systems follow under a separator', () => {
    const items = groupSystemsForQuickPick(systems)
    assert.deepEqual(
        items.map((item) => item.label),
        ['Workspace', 'My Custom C', 'Team system', 'Built-in', 'Netlist-based Compilation (C)']
    )
    assert.equal(items[0].kind, vscode.QuickPickItemKind.Separator)
    assert.equal(items[1].description, '$(folder) kico/my.kico')
    assert.equal(items[1].detail, 'my.custom')
    assert.equal(
        items[2].description,
        `$(folder) ${path.sep === '/' ? '/srv/shared/team.kico' : '/srv/shared/team.kico'}`
    )
    assert.equal(items[4].systemId, 'de.cau.cs.kieler.sccharts.netlist')
    assert.equal(items[4].description, undefined)
})

test('without workspace systems the menu is the plain list, no headings', () => {
    const items = groupSystemsForQuickPick(systems.filter((system) => !system.source))
    assert.deepEqual(
        items.map((item) => item.label),
        ['Netlist-based Compilation (C)']
    )
    assert.ok(items.every((item) => item.kind === undefined))
})

test('a picked item resolves by id, and legacy items without an id still resolve by label', () => {
    const items = groupSystemsForQuickPick(systems)
    assert.equal(pickedSystem(systems, items[1]).id, 'my.custom')
    assert.equal(pickedSystem(systems, { label: 'Team system' }).id, 'team.shared')
    assert.equal(pickedSystem(systems, undefined), undefined)
    assert.equal(pickedSystem(systems, items[0]), undefined, 'A separator selects nothing')
})

test('the folders parameter carries the setting entries and the workspace folders as paths', () => {
    assert.deepEqual(systemFoldersParam(['kico', '', '  ', '/srv/shared']), {
        folders: ['kico', '/srv/shared'],
        workspaceFolders: ['/home/me/project'],
    })
    assert.deepEqual(systemFoldersParam([], []), { folders: [], workspaceFolders: [] })
})

test('change messages name loaded, replaced and broken files relative to the workspace', () => {
    const { info, errors } = changeMessages({
        added: [{ file: 'file:///home/me/project/kico/my.kico', id: 'my.custom.v2', label: 'V2', loaded: true }],
        removed: [
            { file: 'file:///home/me/project/kico/my.kico', id: 'my.custom', label: 'V1', loaded: true },
            { file: 'file:///home/me/project/old.kico', id: 'my.old', label: 'Old', loaded: true },
        ],
        errors: [
            {
                file: 'file:///home/me/project/kico/bad.kico',
                loaded: false,
                error: "no viable alternative at input '{'",
            },
        ],
    })
    assert.deepEqual(info, [
        'Loaded compilation system "V2" (my.custom.v2) from kico/my.kico',
        'Removed compilation system "Old" (my.old): old.kico is gone',
    ])
    assert.deepEqual(errors, ["kico/bad.kico: no viable alternative at input '{'"])
    assert.equal(describeSource('file:///elsewhere/x.kico'), '/elsewhere/x.kico')
})

test('the template is a valid public system that includes the netlist chain', () => {
    const text = SYSTEM_TEMPLATE('my.system')
    assert.match(text, /^public system my\.system$/m)
    assert.match(text, /label "my\.system \(workspace\)"/)
    assert.match(text, /system de\.cau\.cs\.kieler\.sccharts\.netlist/)
})

test('a systemsChanged notification re-requests the systems only when something was added or removed', async () => {
    const handlers = new Map()
    const requests = []
    const lsClient = {
        onNotification: (method, handler) => {
            handlers.set(method, handler)
            return { dispose() {} }
        },
        onDidChangeState: () => ({ dispose() {} }),
        sendNotification: async (method, params) => requests.push([method, params]),
    }
    let refreshes = 0
    vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} })
    vscode.workspace.onDidChangeWorkspaceFolders = () => ({ dispose() {} })
    const workspaceSystems = new WorkspaceSystems(lsClient, async () => {
        refreshes++
    })
    handlers.get('keith/kicool/systemsChanged')({
        added: [],
        removed: [],
        errors: [{ file: 'file:///home/me/project/kico/bad.kico', loaded: false, error: 'broken' }],
    })
    assert.equal(refreshes, 0)
    handlers.get('keith/kicool/systemsChanged')({
        added: [{ file: 'file:///home/me/project/kico/my.kico', id: 'my.custom', label: 'X', loaded: true }],
        removed: [],
        errors: [],
    })
    assert.equal(refreshes, 1)
    await workspaceSystems.sendFolders()
    assert.deepEqual(requests, [
        ['keith/kicool/systemFolders', { folders: [], workspaceFolders: ['/home/me/project'] }],
    ])
    workspaceSystems.dispose()
})
