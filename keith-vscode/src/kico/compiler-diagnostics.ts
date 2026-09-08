import * as vscode from 'vscode'
import { BuildIssue, BuildReport, CompilerIssue, SourceLocation } from './diagnostic-protocol'
import { arrayCopyFix, mapNativeLocation } from './source-mapping'

interface Stage {
    name: string
    index: number
    errors?: string[]
    warnings?: string[]
    diagnostics?: CompilerIssue[]
}

/** A scheduler cycle error already explains the loop the analyzer warned about earlier in the pipeline. */
function withoutExplainedLoops(issues: BuildIssue[]): BuildIssue[] {
    const explained = new Set(
        issues
            .filter((issue) => issue.code === 'scheduling-cycle')
            .flatMap((issue) => issue.locations.map((l) => `${l.uri}:${l.offset}`))
    )
    if (!explained.size) return issues
    return issues.filter(
        (issue) =>
            issue.code !== 'instantaneous-loop' ||
            (issue.locations.length > 0 && !issue.locations.some((l) => explained.has(`${l.uri}:${l.offset}`)))
    )
}

export class CompilerDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('kieler-compiler')

    private readonly changed = new vscode.EventEmitter<void>()

    readonly onDidChange = this.changed.event

    private readonly reports = new Map<string, BuildReport>()

    private readonly sources = new Map<number, string>()

    private readonly published = new Map<string, Set<string>>()

    private nextId = 0

    private readonly subscriptions: vscode.Disposable[]

    constructor() {
        this.subscriptions = [
            vscode.workspace.onDidChangeTextDocument(({ document }) => {
                const report = this.get(document.uri.toString())
                if (report && report.version !== document.version) {
                    report.status = 'stale'
                    this.clearPublished(report.uri)
                    this.changed.fire()
                }
            }),
            vscode.workspace.onDidDeleteFiles(({ files }) => files.forEach((uri) => this.remove(uri.toString()))),
            vscode.languages.registerCodeActionsProvider(
                'sctx',
                { provideCodeActions: (document, range) => this.codeActions(document, range) },
                { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
            ),
        ]
    }

    dispose(): void {
        this.collection.dispose()
        this.changed.dispose()
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }

    get(uri: string): BuildReport | undefined {
        return this.reports.get(vscode.Uri.parse(uri).toString())
    }

    async begin(uri: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
        this.remove(uri)
        const report: BuildReport = {
            id: ++this.nextId,
            uri: document.uri.toString(),
            version: document.version,
            status: 'compiling',
            issues: [],
            rawCount: 0,
        }
        this.sources.set(report.id, document.getText())
        this.reports.set(report.uri, report)
        this.changed.fire()
    }

    finish(uri: string, files: Stage[][], cancelled: boolean): BuildReport | undefined {
        const report = this.get(uri)
        if (!report || report.status === 'stale' || report.status === 'cancelled') return report
        const source = this.sources.get(report.id) ?? ''
        let flatIndex = 0
        const issues: BuildIssue[] = []
        report.rawCount = 0
        files.forEach((stages) =>
            stages.forEach((stage) => {
                report.rawCount += (stage.errors?.length ?? 0) + (stage.warnings?.length ?? 0)
                const diagnostics = stage.diagnostics ?? [
                    ...(stage.errors ?? []).map(
                        (message): CompilerIssue => ({
                            code: 'compiler',
                            message: message.split('\n')[0],
                            severity: 'error',
                            details: message,
                            locations: [],
                            cycle: [],
                        })
                    ),
                    ...(stage.warnings ?? []).map(
                        (message): CompilerIssue => ({
                            code: 'compiler',
                            message,
                            severity: 'warning',
                            locations: [],
                            cycle: [],
                        })
                    ),
                ]
                diagnostics.forEach((diagnostic) => {
                    const normalized = diagnostic.locations.map((location) =>
                        this.normalizeLocation(location, report.uri)
                    )
                    const hasSource = normalized.some((location) => location.uri === report.uri)
                    const locations = normalized
                        .flatMap((location) => {
                            const mapped =
                                diagnostic.code === 'c-compiler' && !hasSource
                                    ? mapNativeLocation(report.uri, source, location)
                                    : undefined
                            return mapped ? [mapped, location] : [location]
                        })
                        .map((location) => this.normalizeLocation(location, report.uri))
                    const issue: BuildIssue = {
                        ...diagnostic,
                        locations,
                        cycle: diagnostic.cycle.map((edge) => ({
                            ...edge,
                            locations: edge.locations.map((l) => this.normalizeLocation(l, report.uri)),
                        })),
                        id: `${report.id}:${issues.length}`,
                        stage: stage.name,
                        snapshotIndex: flatIndex,
                    }
                    const symbols = new Set(
                        issue.locations.flatMap((l) => l.label.match(/\b[A-Za-z_]\w*(?=\s*=(?!=))/g) ?? [])
                    )
                    if (issue.code === 'scheduling-cycle' && symbols.size)
                        issue.message = `Circular dependency involving ${[...symbols].join(
                            ', '
                        )} prevents scheduling this tick.`
                    if (issue.code === 'instantaneous-loop')
                        issue.message = symbols.size
                            ? `Potential instantaneous loop through ${[...symbols].join(', ')}.`
                            : 'Potential instantaneous loop.'
                    if (
                        !issues.some(
                            (other) =>
                                other.message === issue.message &&
                                JSON.stringify(other.locations) === JSON.stringify(issue.locations)
                        )
                    )
                        issues.push(issue)
                })
                flatIndex++
            })
        )
        report.issues = withoutExplainedLoops(issues)
        report.status = cancelled
            ? 'cancelled'
            : issues.some((issue) => issue.severity === 'error')
              ? 'failed'
              : 'succeeded'
        if (!cancelled) this.publish(report)
        this.changed.fire()
        return report
    }

    reset(): void {
        this.collection.clear()
        this.reports.clear()
        this.sources.clear()
        this.published.clear()
        this.changed.fire()
    }

    cancel(uri: string): void {
        const report = this.get(uri)
        if (!report || report.status !== 'compiling') return
        report.status = 'cancelled'
        this.clearPublished(report.uri)
        this.changed.fire()
    }

    private remove(uri: string): void {
        const key = vscode.Uri.parse(uri).toString()
        const old = this.reports.get(key)
        if (old) this.sources.delete(old.id)
        this.reports.delete(key)
        this.clearPublished(key)
    }

    private clearPublished(uri: string): void {
        this.published.get(uri)?.forEach((file) => this.collection.delete(vscode.Uri.parse(file)))
        this.published.delete(uri)
    }

    private normalizeLocation(location: SourceLocation, modelUri: string): SourceLocation {
        const uri = vscode.Uri.parse(location.uri).toString()
        // The JVM canonicalises /tmp to /private/tmp on macOS.
        const sameFile =
            uri.replace('file:///private/', 'file:///') === modelUri.replace('file:///private/', 'file:///')
        return { ...location, uri: sameFile ? modelUri : uri }
    }

    range(location: SourceLocation, document: vscode.TextDocument): vscode.Range {
        if ((location.line ?? -1) >= 0) {
            const line = Math.min(location.line!, document.lineCount - 1)
            const { text } = document.lineAt(line)
            const column = Buffer.from(text, 'utf8')
                .subarray(0, Math.max(0, location.column ?? 0))
                .toString('utf8').length
            return document.validateRange(new vscode.Range(line, column, line, column + 1))
        }
        return new vscode.Range(
            document.positionAt(location.offset),
            document.positionAt(location.offset + Math.max(1, location.length))
        )
    }

    private publish(report: BuildReport): void {
        const source = this.sources.get(report.id) ?? ''
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === report.uri)
        if (!document || document.version !== report.version) return
        const byFile = new Map<string, vscode.Diagnostic[]>()
        report.issues.forEach((issue) => {
            const known = issue.locations.filter((location) => vscode.Uri.parse(location.uri).scheme === 'file')
            const locations = known.length
                ? known
                : [
                      {
                          uri: report.uri,
                          offset: 0,
                          length: Math.min(1, source.length),
                          label:
                              issue.severity === 'error'
                                  ? 'Build failed in this stage'
                                  : 'Reported by this compiler stage',
                      },
                  ]
            // Prefer source locations; generated C remains a related link when it maps back to SCTX.
            const primary = locations.filter((l) => l.uri === report.uri)
            const targets = primary.length ? primary : locations.slice(0, 1)
            targets.forEach((location) => {
                const range =
                    location.uri === report.uri
                        ? this.range(location, document)
                        : new vscode.Range(
                              Math.max(0, location.line ?? 0),
                              Math.max(0, location.column ?? 0),
                              Math.max(0, location.line ?? 0),
                              Math.max(0, location.column ?? 0) + 1
                          )
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `${issue.message}${issue.hint ? `\n${issue.hint}` : ''}`,
                    issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
                )
                diagnostic.source = `KIELER · ${issue.stage}`
                diagnostic.code = issue.code
                diagnostic.relatedInformation = locations
                    .filter((l) => l !== location)
                    .map(
                        (related) =>
                            new vscode.DiagnosticRelatedInformation(
                                new vscode.Location(
                                    vscode.Uri.parse(related.uri),
                                    related.uri === report.uri
                                        ? this.range(related, document)
                                        : new vscode.Range(
                                              Math.max(0, related.line ?? 0),
                                              Math.max(0, related.column ?? 0),
                                              Math.max(0, related.line ?? 0),
                                              Math.max(0, related.column ?? 0) + 1
                                          )
                                ),
                                related.label
                            )
                    )
                const list = byFile.get(location.uri) ?? []
                list.push(diagnostic)
                byFile.set(location.uri, list)
            })
        })
        this.clearPublished(report.uri)
        byFile.forEach((diagnostics, uri) => this.collection.set(vscode.Uri.parse(uri), diagnostics))
        this.published.set(report.uri, new Set(byFile.keys()))
    }

    private codeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const report = this.get(document.uri.toString())
        if (!report || report.status !== 'failed' || report.version !== document.version) return []
        return report.issues.flatMap((issue) => {
            if (
                issue.code !== 'c-compiler' ||
                !/array type.*not assignable|assignment to expression with array type/.test(issue.message)
            )
                return []
            const location = issue.locations.find(
                (l) => l.uri === report.uri && !!this.range(l, document).intersection(range)
            )
            if (!location) return []
            const replacement = arrayCopyFix(document.getText(), location)
            if (!replacement) return []
            const action = new vscode.CodeAction('Copy array elements individually', vscode.CodeActionKind.QuickFix)
            action.edit = new vscode.WorkspaceEdit()
            action.edit.replace(document.uri, this.range(location, document), replacement)
            return [action]
        })
    }
}
