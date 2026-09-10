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
import { LanguageClient, State } from 'vscode-languageclient/node'
import { settingsKey } from '../constants'
import { diagramClientId } from './constants'
import {
    CursorParams,
    CursorResult,
    CursorSync,
    FollowCursorMode,
    cursorRequest,
    preferencesNotification,
} from './cursor-sync'
import { DiagramController } from './diagram-controller'

export const revealCursorCommand = 'keith-vscode.diagram.revealCursor'

const followCursorSetting = 'diagram.followCursor'

const selectTextSetting = 'diagram.selectText'

function configuration() {
    return vscode.workspace.getConfiguration(settingsKey)
}

/** Wires editor-to-diagram cursor sync, the reveal command, and the diagram-to-editor preference. */
export function registerCursorSync(
    context: vscode.ExtensionContext,
    client: LanguageClient,
    diagrams: DiagramController
): CursorSync {
    const sync = new CursorSync({
        send: (params: CursorParams) => client.sendRequest<CursorResult>(cursorRequest, params),
        mode: () => configuration().get<FollowCursorMode>(followCursorSetting, 'focus'),
        diagramUri: () => diagrams.currentUri,
        clientId: diagramClientId,
        lastDiagramInteraction: () => diagrams.lastDiagramInteraction,
    })
    context.subscriptions.push(sync)
    // A new diagram (reopened, restarted, or another file) starts without a remembered cursor.
    context.subscriptions.push(diagrams.onDidChangeDiagram(() => sync.reset()))
    context.subscriptions.push(
        vscode.commands.registerCommand(revealCursorCommand, async () => {
            sync.reset()
            const result = await sync.reveal()
            if (result && !result.ok && result.message) {
                vscode.window.setStatusBarMessage(`$(warning) ${result.message}`, 4000)
            } else if (!result) {
                vscode.window.setStatusBarMessage('$(info) Open the diagram of this SCChart first', 4000)
            }
        })
    )

    // Diagram → editor: the server reveals the selected element's source once told the client wants it.
    const sendPreferences = () => {
        if (!client.isRunning()) return
        client
            .sendNotification(preferencesNotification, {
                'diagram.shouldSelectText': configuration().get<boolean>(selectTextSetting, true),
            })
            .catch(() => undefined)
    }
    context.subscriptions.push(
        client.onDidChangeState((event) => {
            if (event.newState === State.Running) sendPreferences()
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${settingsKey}.${selectTextSetting}`)) sendPreferences()
        })
    )
    sendPreferences()
    return sync
}
