/* eslint-disable no-await-in-loop -- Preserve tab order and stop exports at the first failed write. */
import * as vscode from 'vscode'
import { Utils } from 'vscode-uri'

export const GENERATED_SCHEME = 'sccharts-generated'
export const SAVE_GENERATED = 'keith-vscode.save-generated-code'
export const SAVE_ALL_GENERATED = 'keith-vscode.save-all-generated-code'

export interface GeneratedFile {
    fileName: string
    code: string
}

interface GeneratedGroup {
    source: vscode.Uri
    files: GeneratedFile[]
}

/** Generated names also become export paths; reject ambiguous or escaping names before opening anything. */
export function validateGeneratedFiles(files: GeneratedFile[]): void {
    const names = new Set<string>()
    for (const file of files) {
        if (
            typeof file.fileName !== 'string' ||
            typeof file.code !== 'string' ||
            /[\\:]/.test(file.fileName) ||
            file.fileName.includes('\0') ||
            file.fileName.split('/').some((part) => !part || part === '.' || part === '..')
        ) {
            throw new Error('The compiler returned an invalid generated filename.')
        }
        const name = file.fileName.toLowerCase()
        if (names.has(name)) throw new Error(`The compiler returned duplicate output: ${file.fileName}`)
        names.add(name)
    }
}

export class GeneratedCodeDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly documents = new Map<string, { group: GeneratedGroup; file: GeneratedFile }>()

    private sequence = 0

    private readonly opening = new Set<string>()

    private readonly subscriptions: vscode.Disposable[]

    constructor() {
        this.subscriptions = [
            vscode.workspace.registerTextDocumentContentProvider(GENERATED_SCHEME, this),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (document.uri.scheme !== GENERATED_SCHEME) return
                // Changing syntax highlighting closes and reopens the same URI.
                setTimeout(() => {
                    const uri = document.uri.toString()
                    const reopened = vscode.workspace.textDocuments.some(
                        (open) => !open.isClosed && open.uri.toString() === uri
                    )
                    if (!this.opening.has(uri) && !reopened) this.documents.delete(uri)
                }, 0)
            }),
            vscode.commands.registerCommand(SAVE_GENERATED, (uri?: vscode.Uri) => this.saveAs(uri)),
            vscode.commands.registerCommand(SAVE_ALL_GENERATED, (uri?: vscode.Uri) => this.saveAll(uri)),
        ]
    }

    dispose(): void {
        this.subscriptions.forEach((subscription) => subscription.dispose())
        this.documents.clear()
        this.opening.clear()
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const entry = this.documents.get(uri.toString())
        if (!entry) throw new Error('This generated preview has expired. Generate code again to reopen it.')
        return entry.file.code
    }

    async open(source: vscode.Uri, target: 'c' | 'java', files: GeneratedFile[]): Promise<void> {
        validateGeneratedFiles(files)
        const group = { source, files }
        const generation = `${Date.now()}-${++this.sequence}`
        const uris = files.map((file) =>
            vscode.Uri.from({
                scheme: GENERATED_SCHEME,
                path: `/${Utils.basename(source)}/${generation}/${target}/${file.fileName}`,
            })
        )
        uris.forEach((uri, index) => this.documents.set(uri.toString(), { group, file: files[index] }))
        uris.forEach((uri) => this.opening.add(uri.toString()))
        try {
            for (const uri of uris) {
                const document = await vscode.workspace.openTextDocument(uri)
                const generated = await vscode.languages.setTextDocumentLanguage(document, target)
                await vscode.window.showTextDocument(generated, { preview: false, preserveFocus: true })
            }
            if (uris[0]) await vscode.window.showTextDocument(uris[0], { preview: false })
        } finally {
            uris.forEach((uri) => this.opening.delete(uri.toString()))
            const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()))
            uris.filter((uri) => !open.has(uri.toString())).forEach((uri) => this.documents.delete(uri.toString()))
        }
    }

    private async saveAs(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
        if (!uri || !this.documents.has(uri.toString())) return
        try {
            await vscode.window.showTextDocument(uri, { preview: false })
            await vscode.commands.executeCommand('workbench.action.files.saveAs')
        } catch (error) {
            vscode.window.showErrorMessage(`Could not save generated code: ${String(error)}`)
        }
    }

    private async saveAll(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
        const entry = uri && this.documents.get(uri.toString())
        if (!entry) return
        let saved = 0
        try {
            const folders = await vscode.window.showOpenDialog({
                title: 'Save All Generated Files',
                openLabel: 'Save Here',
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: Utils.dirname(entry.group.source),
            })
            if (!folders?.[0]) return
            const destinations = entry.group.files.map((file) => ({
                file,
                uri: vscode.Uri.joinPath(folders[0], ...file.fileName.split('/')),
            }))
            const existing: string[] = []
            for (const destination of destinations) {
                if (
                    vscode.workspace.textDocuments.some(
                        (document) => document.uri.toString() === destination.uri.toString() && document.isDirty
                    )
                ) {
                    throw new Error(`Save or close your edits to ${destination.file.fileName} before replacing it.`)
                }
                if (destination.uri.toString() === entry.group.source.toString()) {
                    throw new Error('Generated code cannot replace its source model.')
                }
                try {
                    const stat = await vscode.workspace.fs.stat(destination.uri)
                    // eslint-disable-next-line no-bitwise -- FileType combines directory and symlink flags.
                    if (stat.type & vscode.FileType.Directory) {
                        throw new Error(`${destination.file.fileName} is an existing directory.`)
                    }
                    existing.push(destination.file.fileName)
                } catch (error) {
                    if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error
                }
            }
            if (existing.length) {
                const choice = await vscode.window.showWarningMessage(
                    `Replace ${existing.length} existing file(s)?\n${existing.join('\n')}`,
                    { modal: true },
                    'Replace'
                )
                if (choice !== 'Replace') return
            }
            for (const destination of destinations) {
                await vscode.workspace.fs.createDirectory(Utils.dirname(destination.uri))
                await vscode.workspace.fs.writeFile(destination.uri, new TextEncoder().encode(destination.file.code))
                saved++
            }
            vscode.window.showInformationMessage(`Saved ${saved} generated files to ${folders[0].fsPath}.`)
        } catch (error) {
            vscode.window.showErrorMessage(
                `Could not save generated files${saved ? ` (${saved} already saved)` : ''}: ${String(error)}`
            )
        }
    }
}
