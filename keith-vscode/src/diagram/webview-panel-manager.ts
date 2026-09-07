/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2021-2024 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import 'reflect-metadata'
import { Action } from 'sprotty-protocol'
import {
    SprottyDiagramIdentifier,
    WebviewEndpoint,
    createFileUri,
    createWebviewHtml,
    createWebviewTitle,
    isWebviewPanel,
    serializeUri,
} from 'sprotty-vscode'
import { LspWebviewEndpoint, LspWebviewPanelManager, LspWebviewPanelManagerOptions } from 'sprotty-vscode/lib/lsp'
import { addLspLabelEditActionHandler, addWorkspaceEditActionHandler } from 'sprotty-vscode/lib/lsp/editing'
import * as vscode from 'vscode'
import { contextKeys, diagramClientId } from './constants'
import { StorageService } from './storage/storage-service'
import { KlighDWebviewEndpoint } from './webview-endpoint'

/**
 * Callback provided for other parts of the extension to intercept diagram actions before they
 * reach the language server.
 */
export type ActionHandlerCallback = (action: Action) => unknown

/**
 * The webview panel manager for KLighD diagrams. Adds editor synchronisation, external action
 * handlers, and a restart that throws away both the webview and the server-side diagram state.
 */
export class KLighDWebviewPanelManager extends LspWebviewPanelManager {
    readonly storageService: StorageService

    private syncWithEditor: boolean

    private actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[]

    /** Uri of the model shown last, so a restart can bring the same diagram back. */
    private lastUri: vscode.Uri | undefined

    /** Column the diagram panel was in last, so a restart reopens it in the same place. */
    private lastViewColumn: vscode.ViewColumn | undefined

    private restarting = false

    constructor(
        options: LspWebviewPanelManagerOptions,
        storageService: StorageService,
        actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[]
    ) {
        super(options)
        this.storageService = storageService
        this.actionHandlers = actionHandlers
        this.syncWithEditor = true
        this.setSyncWithEditor(true)
        vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, false)
    }

    /** Changes the behavior of "sync with editor". If disabled, the diagram view will not update when the active editor changes. */
    setSyncWithEditor(sync: boolean): void {
        this.syncWithEditor = sync
        vscode.commands.executeCommand('setContext', contextKeys.syncWithEditor, sync)
    }

    getSyncWithEdior(): boolean {
        return this.syncWithEditor
    }

    get isOpen(): boolean {
        return this.endpoints.length > 0
    }

    get currentUri(): vscode.Uri | undefined {
        return this.lastUri
    }

    override async openDiagram(
        uri: vscode.Uri,
        options: { diagramType?: string; reveal?: boolean; preserveFocus?: boolean } = {}
    ): Promise<WebviewEndpoint | undefined> {
        this.pruneDisposedEndpoints()
        const endpoint = await super.openDiagram(uri, options)
        if (endpoint) {
            this.lastUri = uri
            vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, true)
        }
        return endpoint
    }

    /** Drops endpoints whose panel VS Code has disposed without telling us. */
    private pruneDisposedEndpoints(): void {
        for (const endpoint of [...this.endpoints]) {
            const panel = endpoint.webviewContainer
            let disposed = false
            try {
                // Any property access on a disposed WebviewPanel throws.
                disposed = isWebviewPanel(panel) && panel.visible === undefined
            } catch {
                disposed = true
            }
            if (disposed) {
                super.didCloseWebview(endpoint)
            }
        }
    }

    /**
     * Closes every diagram panel, which also makes the language server forget its diagram state
     * for this client, and reopens the last diagram. This is the cure for a diagram that keeps
     * failing to render, for example after the server switched the model behind it.
     */
    async restart(): Promise<void> {
        if (this.restarting) {
            return
        }
        this.restarting = true
        try {
            const uri = this.lastUri
            const column = this.lastViewColumn
            const panels = this.endpoints.map((endpoint) => endpoint.webviewContainer)
            panels.forEach((panel) => {
                if (isWebviewPanel(panel)) {
                    panel.dispose()
                }
            })
            // Disposal is reported asynchronously; wait until the manager has dropped the endpoints.
            await waitUntil(() => this.endpoints.length === 0, 2000)
            this.pruneDisposedEndpoints()
            this.endpoints.length = 0
            if (uri) {
                this.lastViewColumn = column
                await this.openDiagram(uri, { reveal: true, preserveFocus: true })
                this.storageService.setItem('diagramOpen', true)
            }
        } finally {
            this.restarting = false
        }
    }

    protected override async createDiagramIdentifier(
        uri: vscode.Uri,
        diagramType?: string
    ): Promise<SprottyDiagramIdentifier | undefined> {
        if (!diagramType) {
            diagramType = await this.getDiagramType(uri)
            if (!diagramType) {
                return undefined
            }
        }
        return {
            diagramType,
            uri: serializeUri(uri),
            clientId: diagramClientId,
        }
    }

    /**
     * Same as the sprotty-vscode default, but reopens in the column the diagram was in before a
     * restart instead of always beside the editor.
     */
    protected override createWebview(identifier: SprottyDiagramIdentifier): vscode.WebviewPanel {
        const extensionPath = this.options.extensionUri.fsPath
        const title = createWebviewTitle(identifier)
        const panel = vscode.window.createWebviewPanel(
            identifier.diagramType || 'diagram',
            title,
            this.lastViewColumn ?? vscode.ViewColumn.Beside,
            {
                localResourceRoots: this.options.localResourceRoots ?? [createFileUri(extensionPath, 'pack')],
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        )
        const scriptUri = createFileUri(extensionPath, 'pack', 'webview.js')
        panel.webview.html = createWebviewHtml(identifier, panel, { scriptUri })
        panel.onDidChangeViewState(() => {
            this.lastViewColumn = panel.viewColumn ?? this.lastViewColumn
        })
        return panel
    }

    protected override createEndpoint(identifier: SprottyDiagramIdentifier): LspWebviewEndpoint {
        const webviewContainer = this.createWebview(identifier)
        const participant = this.messenger.registerWebviewPanel(webviewContainer)
        const endpoint = new KlighDWebviewEndpoint({
            languageClient: this.languageClient,
            webviewContainer,
            messenger: this.messenger,
            messageParticipant: participant,
            identifier,
        })

        addWorkspaceEditActionHandler(endpoint as unknown as LspWebviewEndpoint)
        addLspLabelEditActionHandler(endpoint as unknown as LspWebviewEndpoint)

        for (const actionHandler of this.actionHandlers) {
            endpoint.addKlighdActionHandler(actionHandler.kind, actionHandler.actionHandler)
        }
        return endpoint as unknown as LspWebviewEndpoint
    }

    protected override didCloseWebview(endpoint: WebviewEndpoint): void {
        // The panel is already disposed here; reading its view column would throw and leave the
        // dead endpoint registered, which is why the diagram could never be reopened.
        super.didCloseWebview(endpoint)
        if (this.endpoints.length === 0) {
            vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, false)
            // A restart closes and reopens; only a user-initiated close should be remembered.
            if (!this.restarting) {
                this.storageService.setItem('diagramOpen', false)
            }
        }
    }
}

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const started = Date.now()
        const tick = () => {
            if (condition() || Date.now() - started > timeoutMs) {
                resolve()
            } else {
                setTimeout(tick, 20)
            }
        }
        tick()
    })
}
