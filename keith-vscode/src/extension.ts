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

import { connect, NetConnectOpts, Socket } from 'net'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, ServerOptions, State, StreamInfo } from 'vscode-languageclient/node'
import { Settings, settingsKey } from './constants'
import { KeithErrorHandler } from './error-handler'
import { reportConflictingExtensions } from './conflicts'
import { DiagramController } from './diagram/diagram-controller'
import { REQUEST_CS } from './kico/commands'
import { CompilationDataProvider } from './kico/compilation-data-provider'
import { DiagnosticBridge } from './kico/diagnostic-bridge'
import { registerCodeGeneration } from './kico/code-generation'
import { handlePerformAction, PerformActionAction, performActionKind } from './perform-action-handler'
import { SettingsService } from './settings'
import { RESTART_LANGUAGE_SERVER } from './simulation/commands'
import { SimulationTableDataProvider } from './simulation/simulation-table-data-provider'
import { SimulationViewBridge } from './simulation/simulation-view-bridge'
// import 'simulation/index.css'

/**
 * All file endings of the languages that are supported by keith-vscode.
 * The file ending should also be the language id, since it is also used to
 * register document selectors in the language client.
 */
const supportedFileEndings = ['sctx', 'scl', 'elkt', 'elkj', 'kgt', 'kgx', 'kviz', 'strl', 'lus']

let lsClient: LanguageClient
let socket: Socket
let settingsService: SettingsService<Settings>

// this method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
    if (socket) {
        // Don't call lsClient.stop when we are connected via socket for development.
        // That call will end the LS server, leading to a bad dev experience.
        socket.end()
        return
    }
    await lsClient?.stop()
}

/**
 * Depending on the launch configuration, returns {@link ServerOptions} that either
 * connect to a socket or start the LS as a process. It uses a socket if the
 * environment variable `KEITH_LS_PORT` is present. Otherwise it runs the jar located
 * at `server/kieler-language-server.jar`.
 */
function createServerOptions(context: vscode.ExtensionContext): ServerOptions {
    // Connect to language server via socket if a port is specified as an env variable
    if (typeof process.env.KEITH_LS_PORT !== 'undefined') {
        const connectionInfo: NetConnectOpts = {
            port: parseInt(process.env.KEITH_LS_PORT, 10),
        }
        // eslint-disable-next-line no-console
        console.log('Connecting to language server on port: ', connectionInfo.port)

        return async () => {
            socket = connect(connectionInfo)
            const result: StreamInfo = {
                writer: socket,
                reader: socket,
            }
            return result
        }
    }
    // eslint-disable-next-line no-console
    console.log('Spawning the language server as a process.')
    const lsPath = context.asAbsolutePath(`server/kieler-language-server.jar`)
    // The bundled language server ships Jetty 11 without a websocket module, but its simulation
    // visualization server was compiled against Jetty 10. Putting Jetty 10 first on the classpath
    // shadows the bundled classes so the server on port 5010 can start.
    const jettyPath = context.asAbsolutePath(`server/jetty10/*`)
    const diagnosticsPath = context.asAbsolutePath('server/diagnostics.jar')
    const args = [
        '-Djava.awt.headless=true',
        '-cp',
        `${diagnosticsPath}${path.delimiter}${jettyPath}${path.delimiter}${lsPath}`,
        'de.cau.cs.kieler.language.server.LanguageServer',
    ]

    return {
        run: { command: 'java', args },
        debug: { command: 'java', args },
    }
}

/**
 * Restarts the language server in place, without reloading the window, and forgets any running simulation.
 * This clears stuck server state such as a diagram view that keeps failing to render.
 */
async function restartLanguageServer(simulation: SimulationTableDataProvider): Promise<void> {
    simulation.resetForRestart()
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting KIELER language server...' },
        async () => {
            try {
                await lsClient.restart()
                vscode.window.setStatusBarMessage('$(check) KIELER language server restarted', 5000)
            } catch (error) {
                vscode.window.showErrorMessage(`KIELER language server failed to restart: ${error}`)
            }
        }
    )
}

// this method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (await reportConflictingExtensions()) {
        return
    }

    // Create context key of supported languages
    vscode.commands.executeCommand('setContext', 'keith-vscode.languages', supportedFileEndings)

    const serverOptions: ServerOptions = createServerOptions(context)

    const clientOptions: LanguageClientOptions = {
        documentSelector: supportedFileEndings.map((ending) => ({
            scheme: 'file',
            language: ending,
        })),
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.*'),
        },
    }

    lsClient = new LanguageClient('KIELER Language Server', serverOptions, clientOptions, true)

    // Setup basic connection error reporting
    const defaultErrorHandler = lsClient.createDefaultErrorHandler()
    lsClient.clientOptions.errorHandler = new KeithErrorHandler(defaultErrorHandler)

    // Diagrams are part of this extension now (merged from klighd-vscode), so no other
    // extension has to be handed the language client.
    const diagrams = new DiagramController(context, lsClient, supportedFileEndings)

    // create SettingsService with list of setting-keys to manage
    settingsService = new SettingsService<Settings>(settingsKey, [
        'autocompile.enabled',
        'compileInplace.enabled',
        'showResultingModel.enabled',
        'showPrivateSystems.enabled',
        'simulationStepDelay',
        'simulationType',
        'showInternalVariables.enabled',
    ])
    context.subscriptions.push(settingsService)

    const compilationDataProvider = new CompilationDataProvider(lsClient, context, settingsService)
    registerCodeGeneration(context, compilationDataProvider)
    compilationDataProvider.awaitDiagram = () => diagrams.nextModel()
    context.subscriptions.push(
        new DiagnosticBridge(compilationDataProvider.diagnostics, diagrams, (uri, index) =>
            compilationDataProvider.show(uri, index)
        )
    )
    // Clicking the code view's text asks for an Eclipse editor; the generated code opens as tabs instead.
    diagrams.addActionHandler(performActionKind, (action) => {
        const uri = diagrams.currentUri
        const stage = compilationDataProvider.currentStage(uri?.toString())
        const target = stage && /java/i.test(stage.name) ? 'java' : 'c'
        return handlePerformAction(action as PerformActionAction, uri, target)
    })
    // Reopening or restarting the diagram synthesizes the source model again, so no stage is shown any more.
    context.subscriptions.push(
        diagrams.onDidChangeDiagram(() => compilationDataProvider.diagramReset(diagrams.currentUri?.toString()))
    )

    // The simulation lives in the diagram preview tab: controls above the diagram, the tick-by-tick trace below.
    const simulationDataProvider: SimulationTableDataProvider = new SimulationTableDataProvider(
        lsClient,
        compilationDataProvider,
        context,
        settingsService
    )
    context.subscriptions.push(new SimulationViewBridge(simulationDataProvider, diagrams, settingsService))

    context.subscriptions.push(
        vscode.commands.registerCommand(RESTART_LANGUAGE_SERVER.command, () =>
            restartLanguageServer(simulationDataProvider)
        )
    )

    // After a restart (manual or automatic) the compiler panel must learn the fresh server's systems.
    let serverStarts = 0
    context.subscriptions.push(
        lsClient.onDidChangeState((event) => {
            if (event.newState === State.Stopped) {
                compilationDataProvider.diagnostics.reset()
                compilationDataProvider.compiling = false
                compilationDataProvider.lastCompiledUri = ''
                compilationDataProvider.compilationFinishedEmitter.fire(false)
                vscode.commands.executeCommand('setContext', 'keith.vscode:compilationReady', false)
            }
            if (event.newState !== State.Running) {
                return
            }
            serverStarts++
            if (serverStarts > 1) {
                vscode.commands.executeCommand(REQUEST_CS.command)
            }
        })
    )

    // eslint-disable-next-line no-console
    console.debug('Starting Language Server...')
    await lsClient.start()

    // TODO save stuff in context e.g. commands.executeCommand("setContext", "var", value);
}
