import * as vscode from 'vscode'
import type { LanguageClient } from 'vscode-languageclient/node'
import { CompilerDiagnostics, renderIssues, withoutExplainedLoops } from './compiler-diagnostics'
import { CompilerIssue } from './diagnostic-protocol'

/** `keith/diagnostics/live`: what the server's live analysis found in one version of an open document. */
export interface LiveDiagnosticsParam {
    uri: string
    version?: number | null
    issues: CompilerIssue[]
    durationMs: number
    reason?: 'clean' | 'syntax' | 'disabled' | 'closed' | 'cancelled' | null
}

export interface LiveDiagnosticsConfig {
    enabled: boolean
    debounceMs: number
}

export const liveDiagnosticsMethod = 'keith/diagnostics/live'
export const configureLiveDiagnosticsMethod = 'keith/diagnostics/configure'

/**
 * Shows the server's live analysis (scheduling cycles, instantaneous loops and other located analyzer findings)
 * as squiggles while the user types, in its own collection next to the compile results. A current compile report
 * for the same document wins: live results are hidden while it is current and only return once an edit makes it
 * stale. Results for a document version the editor has moved past are dropped.
 */
export class LiveDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('kieler-live')

    /** Files that currently carry diagnostics, per model document. */
    private readonly published = new Map<string, Set<string>>()

    /** The last accepted result per document, kept so it can return once a compile report goes stale. */
    private readonly latest = new Map<string, LiveDiagnosticsParam>()

    private readonly subscriptions: vscode.Disposable[]

    private config: LiveDiagnosticsConfig = { enabled: true, debounceMs: 400 }

    constructor(
        private readonly client: Pick<LanguageClient, 'sendNotification'>,
        private readonly compiler: CompilerDiagnostics
    ) {
        this.subscriptions = [
            // A compile that starts or finishes takes over; one that goes stale hands back to the live result.
            compiler.onDidChange(() => this.reconcile()),
            vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri.toString())),
        ]
    }

    dispose(): void {
        this.collection.dispose()
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }

    get configuration(): LiveDiagnosticsConfig {
        return this.config
    }

    /** Sends the configuration to the server; called on start and whenever the settings change. */
    async configure(config: LiveDiagnosticsConfig): Promise<void> {
        this.config = { enabled: config.enabled, debounceMs: Math.max(0, Math.round(config.debounceMs)) }
        if (!this.config.enabled) {
            ;[...this.latest.keys()].forEach((uri) => this.forget(uri))
        }
        try {
            await this.client.sendNotification(configureLiveDiagnosticsMethod, this.config)
        } catch {
            // The server is not running; it gets the configuration when it starts.
        }
    }

    /** Handles one `keith/diagnostics/live` notification. Returns whether it was shown. */
    accept(params: LiveDiagnosticsParam): boolean {
        if (!this.config.enabled) return false
        const uri = vscode.Uri.parse(params.uri).toString()
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri)
        if (!document) {
            this.forget(uri)
            return false
        }
        if (params.version != null && params.version !== document.version) return false
        const issues = withoutExplainedLoops(params.issues ?? [])
        this.latest.set(uri, { ...params, uri, issues, version: params.version ?? document.version })
        return this.show(uri)
    }

    /** The live issues currently held for a document, whether shown or hidden behind a compile report. */
    get(uri: string): LiveDiagnosticsParam | undefined {
        return this.latest.get(vscode.Uri.parse(uri).toString())
    }

    private show(uri: string): boolean {
        const params = this.latest.get(uri)
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri)
        if (!params || !document || document.version !== params.version) {
            this.clear(uri)
            return false
        }
        if (this.compileIsCurrent(uri, document)) {
            this.clear(uri)
            return false
        }
        const byFile = renderIssues(params.issues, uri, document, document.getText(), () => 'KIELER · live')
        this.clear(uri)
        byFile.forEach((diagnostics, file) => this.collection.set(vscode.Uri.parse(file), diagnostics))
        this.published.set(uri, new Set(byFile.keys()))
        return true
    }

    /** A compile report that is in progress or describes exactly this document version shows instead. */
    private compileIsCurrent(uri: string, document: vscode.TextDocument): boolean {
        const report = this.compiler.get(uri)
        if (!report) return false
        if (report.status === 'stale' || report.status === 'cancelled') return false
        return report.version === document.version
    }

    private reconcile(): void {
        this.latest.forEach((_, uri) => this.show(uri))
    }

    private clear(uri: string): void {
        this.published.get(uri)?.forEach((file) => this.collection.delete(vscode.Uri.parse(file)))
        this.published.delete(uri)
    }

    private forget(uri: string): void {
        this.clear(uri)
        this.latest.delete(uri)
    }
}
