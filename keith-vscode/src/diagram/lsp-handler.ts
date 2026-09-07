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

import { window, TextEdit, workspace, Uri, WorkspaceEdit } from 'vscode'
import { Range as LspRange } from 'vscode-languageclient'
import { LanguageClient } from 'vscode-languageclient/node'

const RESTART_DIAGRAM = 'Restart diagram'

/** Handles KLighD specific LSP notifications: user messages and server-driven file edits. */
export class LspHandler {
    private lastEditSuccessful = true

    static instance: LspHandler

    /** Notification handlers survive client restarts, so they are registered exactly once. */
    private constructor(
        private lsClient: LanguageClient,
        private restartDiagram: () => Promise<void>
    ) {
        lsClient.onNotification('general/sendMessage', this.handleGeneralMessage.bind(this))
        lsClient.onNotification('general/replaceContentInFile', this.handleReplaceContentInFile.bind(this))
    }

    static init(lsClient: LanguageClient, restartDiagram: () => Promise<void>): void {
        if (!LspHandler.instance) {
            LspHandler.instance = new LspHandler(lsClient, restartDiagram)
        }
    }

    private async handleGeneralMessage(message: string, type: 'info' | 'warn' | 'error'): Promise<void> {
        switch (type) {
            case 'warn':
                window.showWarningMessage(message)
                break
            case 'error': {
                // Diagram synthesis failures leave the diagram stuck; a restart clears the server state.
                if (/diagram synthesis|ViewContext|KNodeImpl/.test(message)) {
                    const choice = await window.showErrorMessage(
                        'The diagram could not be rendered. Restarting the diagram usually fixes this.',
                        RESTART_DIAGRAM,
                        'Show details'
                    )
                    if (choice === RESTART_DIAGRAM) {
                        await this.restartDiagram()
                    } else if (choice === 'Show details') {
                        window.showErrorMessage(message)
                    }
                } else {
                    window.showErrorMessage(message)
                }
                break
            }
            default:
                window.showInformationMessage(message)
                break
        }
    }

    /** Handle a edit notification from the server that should replace the content of a specified file. */
    private async handleReplaceContentInFile(uri: string, code: string, lspRange: LspRange): Promise<void> {
        const textDocument = workspace.textDocuments.find((doc) => doc.uri.toString() === Uri.parse(uri).toString())
        if (!textDocument) {
            // Warn once per stream of failed edits rather than on every edit.
            if (this.lastEditSuccessful) {
                this.lastEditSuccessful = false
                window.showWarningMessage(
                    'Changes can not be saved because the affected document is unknown. Make sure that the document is open so your changes can be saved.'
                )
            }
            return
        }

        const range = this.lsClient.protocol2CodeConverter.asRange(lspRange)
        const workSpaceEdit = new WorkspaceEdit()
        workSpaceEdit.set(textDocument.uri, [TextEdit.replace(range, code)])

        const edited = await workspace.applyEdit(workSpaceEdit)
        if (!edited) {
            window.showErrorMessage('The diagram edit could not be applied to the file.')
            return
        }
        const saved = await textDocument.save()
        if (!saved) {
            window.showErrorMessage(`${textDocument.fileName} could not be saved after the diagram edit.`)
            return
        }
        this.lastEditSuccessful = true
    }
}
