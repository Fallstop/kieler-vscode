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

import { commands, window } from 'vscode'
import {
    CloseAction,
    CloseHandlerResult,
    ErrorAction,
    ErrorHandler,
    ErrorHandlerResult,
    Message,
} from 'vscode-languageclient'

const RESTART = 'Restart KIELER language server'
const RESTART_COMMAND = 'keith-vscode.restart-language-server'

/**
 * Reports language server connection problems. The default handler restarts a crashed server by
 * itself, so the user is only bothered when it gives up, and then gets a button to restart.
 */
export class KeithErrorHandler implements ErrorHandler {
    constructor(private defaultHandler: ErrorHandler) {}

    async error(error: Error, message: Message | undefined, count: number | undefined): Promise<ErrorHandlerResult> {
        // eslint-disable-next-line no-console
        console.error('KIELER language server connection error', error)
        const result = await this.defaultHandler.error(error, message, count)
        if (result.action === ErrorAction.Shutdown) {
            this.offerRestart('The KIELER language server connection failed.')
        }
        return result
    }

    async closed(): Promise<CloseHandlerResult> {
        const result = await this.defaultHandler.closed()
        if (result.action === CloseAction.DoNotRestart) {
            this.offerRestart('The KIELER language server stopped.')
        } else {
            window.setStatusBarMessage('$(sync~spin) KIELER language server restarting...', 5000)
        }
        return { ...result, handled: true }
    }

    private offerRestart(text: string): void {
        window.showErrorMessage(text, RESTART).then((choice) => {
            if (choice === RESTART) {
                commands.executeCommand(RESTART_COMMAND)
            }
        })
    }
}
