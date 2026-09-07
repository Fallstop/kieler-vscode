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
import { ChangeColorThemeAction, ColorThemeKind, DebugOptions, SetRenderOptionAction } from '@kieler/klighd-core'
import { Action, ActionMessage } from 'sprotty-protocol'
import { registerLspEditCommands } from 'sprotty-vscode'
import * as vscode from 'vscode'
import { LanguageClient, State } from 'vscode-languageclient/node'
import { registerCommands, registerTextEditorSync } from './commandContributions'
import { command, diagramClientId, diagramType } from './constants'
import { KlighdWebviewReopener } from './klighd-webview-reopener'
import { LspHandler } from './lsp-handler'
import { ReportChangeMessage } from './storage/messages'
import { StorageService } from './storage/storage-service'
import { ActionHandlerCallback, KLighDWebviewPanelManager } from './webview-panel-manager'

/**
 * Owns the KLighD diagram integration for the lifetime of the extension.
 *
 * The upstream klighd-vscode extension rebuilt its panel manager and re-registered its commands
 * every time the language client reached the Running state, which throws on the second time and
 * so broke every server restart. Here everything is created once; later Running states only
 * bring the open diagram back on the fresh server.
 */
export class DiagramController {
    private manager: KLighDWebviewPanelManager | undefined

    private readonly actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[] = []

    private readonly storageService: StorageService

    private readonly disposables: vscode.Disposable[] = []

    private hasRun = false

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: LanguageClient,
        private readonly fileEndings: string[]
    ) {
        // Persist diagram options per workspace, as klighd-vscode did.
        this.storageService = new StorageService(context.workspaceState, client)
        setColorTheme(client)
        LspHandler.init(client, () => this.restart())

        this.disposables.push(
            client.onDidChangeState((event) => {
                if (event.newState !== State.Running) {
                    return
                }
                if (!this.hasRun) {
                    this.hasRun = true
                    this.setup()
                } else {
                    // The server came back after a restart or crash. Its diagram state is gone, so the
                    // webview must be rebuilt against it rather than left showing a dead diagram.
                    this.manager?.restart()
                }
            })
        )

        this.disposables.push(
            vscode.commands.registerCommand(command.clearData, () => {
                StorageService.clearAll(context.workspaceState)
                this.manager?.messenger.sendNotification(
                    { method: 'klighd/persistence' },
                    { type: 'webview', webviewType: diagramType },
                    { type: 'persistence/reportChange', payload: { type: 'clear' } } as ReportChangeMessage
                )
                vscode.window.showInformationMessage('Stored diagram data has been deleted.')
            })
        )
        this.disposables.push(
            vscode.commands.registerCommand(command.debugOptions, () => {
                this.dispatchAction(SetRenderOptionAction.create(DebugOptions.ID, true))
            })
        )
        this.disposables.push(vscode.commands.registerCommand(command.diagramRestart, () => this.restart()))
        context.subscriptions.push(...this.disposables)
    }

    private setup(): void {
        try {
            this.manager = new KLighDWebviewPanelManager(
                {
                    extensionUri: this.context.extensionUri,
                    defaultDiagramType: diagramType,
                    languageClient: this.client,
                    supportedFileExtensions: this.fileEndings.map((ending) => `.${ending}`),
                    singleton: true,
                },
                this.storageService,
                this.actionHandlers
            )
            registerCommands(this.manager, this.context)
            registerLspEditCommands(this.manager, this.context, { extensionPrefix: 'keith-vscode.diagram' })
            registerTextEditorSync(this.manager, this.context)
            this.context.subscriptions.push(
                vscode.window.onDidChangeActiveColorTheme((theme) => {
                    this.manager?.endpoints.forEach((endpoint) =>
                        endpoint.sendAction(ChangeColorThemeAction.create(convertColorThemeKind(theme.kind)))
                    )
                })
            )
            this.storageService.setMessenger(this.manager.messenger)
            new KlighdWebviewReopener(this.storageService).reopenDiagram()
        } catch (error) {
            vscode.window.showErrorMessage(`The KIELER diagram view could not be set up: ${error}`)
            throw error
        }
    }

    /** Intercept diagram actions of the given kind before they reach the language server. */
    addActionHandler(kind: string, actionHandler: ActionHandlerCallback): void {
        this.actionHandlers.push({ kind, actionHandler })
    }

    /** Send an action to the open diagram, if any. */
    dispatchAction(action: Action): void {
        this.manager?.messenger.sendNotification(
            { method: 'ActionMessage' },
            { type: 'webview', webviewType: diagramType },
            { clientId: diagramClientId, action } as ActionMessage
        )
    }

    /**
     * Rebuild the diagram from scratch: close the panel, drop the server-side diagram state, and
     * open the same model again. Falls back to the active editor when no diagram was open.
     */
    async restart(): Promise<void> {
        if (!this.manager) {
            return
        }
        if (this.manager.isOpen) {
            await this.manager.restart()
            return
        }
        const editor = vscode.window.activeTextEditor
        if (editor) {
            await vscode.commands.executeCommand(command.diagramOpen, editor.document.uri)
        }
    }
}

/** Sends VS Code's current theme with the language client's initialisation options. */
function setColorTheme(client: LanguageClient): void {
    const kind = convertColorThemeKind(vscode.window.activeColorTheme.kind)
    // VS Code exposes no API for theme colours, so these mirror the default themes.
    let foreground = '#000000'
    let background = '#FFFFFF'
    let highlight = '#005FB8'
    if (kind === ColorThemeKind.DARK || kind === ColorThemeKind.HIGH_CONTRAST_DARK) {
        foreground = '#D4D4D4'
        background = '#1E1E1E'
        highlight = '#0078D4'
    }
    client.clientOptions.initializationOptions = {
        ...client.clientOptions.initializationOptions,
        clientColorPreferences: { kind, foreground, background, highlight },
    }
}

function convertColorThemeKind(kind: vscode.ColorThemeKind): ColorThemeKind {
    switch (kind) {
        case vscode.ColorThemeKind.Light:
            return ColorThemeKind.LIGHT
        case vscode.ColorThemeKind.Dark:
            return ColorThemeKind.DARK
        case vscode.ColorThemeKind.HighContrast:
            return ColorThemeKind.HIGH_CONTRAST_DARK
        case vscode.ColorThemeKind.HighContrastLight:
            return ColorThemeKind.HIGH_CONTRAST_LIGHT
        default:
            return ColorThemeKind.LIGHT
    }
}
