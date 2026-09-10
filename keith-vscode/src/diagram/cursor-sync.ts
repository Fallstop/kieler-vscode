/*
 * SCCharts Lab
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import * as vscode from 'vscode'

export type FollowCursorMode = 'off' | 'focus' | 'expand'

export const cursorRequest = 'keith/diagram/cursor'

export const preferencesNotification = 'keith/preferences/setPreferences'

export interface CursorParams {
    uri: string
    offset: number
    clientId: string
    mode: Exclude<FollowCursorMode, 'off'>
}

export interface CursorResult {
    ok: boolean
    message?: string
    element?: { kind: string; name?: string; id: string }
    expanded: number
    collapsed: number
}

/** How long after the user last acted on the diagram the editor cursor is left alone. */
export const INTERACTION_GRACE_MS = 500

export interface CursorSyncOptions {
    /** Sends the request to the server; rejects while the server is down. */
    send: (params: CursorParams) => Promise<CursorResult>
    /** The setting `keith-vscode.diagram.followCursor`. */
    mode: () => FollowCursorMode
    /** The model the open diagram shows, or undefined without a diagram. */
    diagramUri: () => vscode.Uri | undefined
    clientId: string
    /** When the user last acted on the diagram (a diagram action reached the server), as `Date.now()`. */
    lastDiagramInteraction: () => number
    debounceMs?: number
    now?: () => number
}

interface SelectionLike {
    document: Pick<vscode.TextDocument, 'uri' | 'languageId' | 'offsetAt'>
    selection: Pick<vscode.Selection, 'active' | 'isSingleLine' | 'isEmpty'>
}

/**
 * Mirrors the editor cursor in the diagram: the state or region under the cursor is expanded and selected
 * (the LSP replacement for the Eclipse editor's SmartCollapseHook). Only user-driven cursor moves count,
 * so the diagram's own "reveal in editor" selection cannot bounce back into the diagram.
 */
export class CursorSync implements vscode.Disposable {
    private timer: ReturnType<typeof setTimeout> | undefined

    private lastSent: { uri: string; offset: number; mode: string } | undefined

    private readonly subscriptions: vscode.Disposable[] = []

    constructor(private readonly options: CursorSyncOptions) {
        this.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)))
    }

    dispose(): void {
        clearTimeout(this.timer)
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }

    /** Why a selection change is not mirrored, or undefined when it is. */
    skipReason(event: {
        textEditor: SelectionLike
        selections: readonly Pick<vscode.Selection, 'active' | 'isSingleLine' | 'isEmpty'>[]
        kind?: vscode.TextEditorSelectionChangeKind
    }): string | undefined {
        const mode = this.options.mode()
        if (mode === 'off') return 'disabled'
        // Programmatic selections (kind undefined) include the diagram revealing a source range.
        if (
            event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard &&
            event.kind !== vscode.TextEditorSelectionChangeKind.Mouse
        )
            return 'not a user selection'
        if (event.selections.length !== 1) return 'multiple cursors'
        if (!event.selections[0].isSingleLine) return 'multi-line selection'
        const { document } = event.textEditor
        if (document.languageId !== 'sctx') return 'not an SCChart'
        const diagram = this.options.diagramUri()
        if (!diagram || diagram.toString() !== document.uri.toString()) return 'diagram shows another model'
        const now = this.options.now?.() ?? Date.now()
        if (now - this.options.lastDiagramInteraction() < INTERACTION_GRACE_MS) return 'user is working in the diagram'
        return undefined
    }

    private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
        if (this.skipReason(event)) return
        clearTimeout(this.timer)
        const editor = event.textEditor
        const mode = this.options.mode() as Exclude<FollowCursorMode, 'off'>
        this.timer = setTimeout(() => {
            this.timer = undefined
            this.reveal(editor, mode).catch(() => undefined)
        }, this.options.debounceMs ?? 150)
    }

    /**
     * Sends the cursor of the given editor to the diagram now. Used by the debounced listener and the
     * one-off command, which works even when following is off.
     */
    async reveal(
        editor: SelectionLike | undefined = vscode.window.activeTextEditor,
        mode: Exclude<FollowCursorMode, 'off'> = this.options.mode() === 'expand' ? 'expand' : 'focus'
    ): Promise<CursorResult | undefined> {
        if (!editor || editor.document.languageId !== 'sctx') return undefined
        const diagram = this.options.diagramUri()
        if (!diagram || diagram.toString() !== editor.document.uri.toString()) return undefined
        const params: CursorParams = {
            uri: editor.document.uri.toString(),
            offset: editor.document.offsetAt(editor.selection.active),
            clientId: this.options.clientId,
            mode,
        }
        const key = { uri: params.uri, offset: params.offset, mode }
        if (
            this.lastSent &&
            this.lastSent.uri === key.uri &&
            this.lastSent.offset === key.offset &&
            this.lastSent.mode === key.mode
        )
            return undefined
        this.lastSent = key
        try {
            return await this.options.send(params)
        } catch {
            // The server is restarting or the diagram closed meanwhile; the next cursor move tries again.
            this.lastSent = undefined
            return undefined
        }
    }

    /** Forget the last cursor sent, e.g. after the diagram changed and needs the cursor again. */
    reset(): void {
        this.lastSent = undefined
    }
}
