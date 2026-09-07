/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2021 - 2024 by
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

import { TableWebview } from '@kieler/table-webview/lib/table-webview'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient, State } from 'vscode-languageclient/node'
import { Settings, SimulationType } from '../constants'
import {
    CompilationDataProvider,
    CompilationSystem,
    CompilationSystemsMessage,
} from '../kico/compilation-data-provider'
import { SettingsService } from '../settings'
import { Tuple } from '../util'
import {
    ADD_CO_SIMULATION,
    COMPILE_AND_SIMULATE,
    COMPILE_AND_SIMULATE_SNAPSHOT,
    LOAD_TRACE,
    NEW_VALUE_SIMULATION,
    OPEN_EXTERNAL_KVIZ_VIEW,
    PAUSE_SIMULATION,
    RUN_SIMULATION,
    SAVE_TRACE,
    SET_SIMULATION_STEP_DELAY,
    SET_SIMULATION_TYPE_TO,
    SHOW_INTERNAL_VARIABLES,
    RESTART_LANGUAGE_SERVER,
    SIMULATE,
    STEP_SIMULATION,
    STOP_SIMULATION,
} from './commands'
import {
    isInternal,
    isTimeDelta,
    isTimeRelated,
    LoadedTraceMessage,
    SavedTraceMessage,
    SimulationDataBlackList,
    SimulationStartedMessage,
    SimulationStepMessage,
    SimulationStoppedMessage,
    strMapToObj,
    Trace,
} from './helper'
import { SimulationPhase } from './protocol'
import { isCompatibleInput } from './input-value'
import { StepController } from './step-controller'
import { waitForVisualization } from './visualization'

export const externalStepMessageType = 'keith/simulation/didStep'
export const valuesForNextStepMessageType = 'keith/simulation/valuesForNextStep'
export const externalStopMessageType = 'keith/simulation/externalStop'
export const startedSimulationMessageType = 'keith/simulation/started'

export class SimulationTableDataProvider implements vscode.WebviewViewProvider {
    public readonly newSimulationDataEmitter = new vscode.EventEmitter<this>()

    public readonly newSimulationData: vscode.Event<this> = this.newSimulationDataEmitter.event

    protected readonly onRequestSimulationSystemsEmitter = new vscode.EventEmitter<this | undefined>()

    readonly onDidChangeOpenStateEmitter = new vscode.EventEmitter<boolean>()

    /** Fires whenever anything the simulation controls in the diagram preview show has changed. */
    private readonly onDidChangeViewStateEmitter = new vscode.EventEmitter<void>()

    public readonly onDidChangeViewState: vscode.Event<void> = this.onDidChangeViewStateEmitter.event

    /** Where the simulation is in its lifecycle, as shown in the diagram preview. */
    public phase: SimulationPhase = 'idle'

    /** Last start or step failure, cleared when the next simulation starts. */
    public lastError: string | undefined

    public modelUri: string | undefined

    private generation = 0

    private starting = false

    private startTimer: ReturnType<typeof setTimeout> | undefined

    private pickingSystem = false

    private stopRequest: Promise<boolean> | undefined

    private readonly stepper = new StepController(async () => {
        const values = strMapToObj(this.changedValuesForNextStep)
        // Edits made after dispatch belong to the following tick.
        this.changedValuesForNextStep.clear()
        await this.lsClient.sendNotification('keith/simulation/step', {
            valuesForNextStep: values,
            simulationType: 'Manual',
        })
    })

    output: vscode.OutputChannel

    /**
     * Trace for each symbol.
     */
    public simulationData: Map<string, SimulationData> = new Map()
    /**
     * Trace for each symbol.
     */
    // public simulationTreeData: SimulationTreeData[] = [new SimulationTreeData("test", "test", vscode.TreeItemCollapsibleState.None, [true, true, false], true, true, ["fun", "with", "flags"])]

    /**
     * Holds the value that is set in the next tick. Holds only the inputs of the simulation
     */
    public valuesForNextStep: Map<string, unknown> = new Map()

    /**
     * Indicates whether an input value should be sent to the server.
     */
    public changedValuesForNextStep: Map<string, unknown> = new Map()

    /**
     * Map which holds wether a event listener is registered for a symbol
     */
    public eventListenerRegistered: Map<string, boolean> = new Map()

    /**
     * Wether next simulation step should be requested after a time specified by simulation delay
     */
    public play = false

    /**
     * Set by SimulationContribution after a simulation is started or stopped.
     * If false disables step, stop and play.
     */
    public controlsEnabled = false

    /**
     * Indicates whether a simulation is currently running.
     * TODO this might not be needed since simulationRunning already expresses this
     */
    simulationRunning = false

    /**
     * Categories of variables with their respective members.
     */
    public categories: string[] = []

    /**
     * The trace that is loaded for the current model.
     */
    public currentTrace: Trace

    public simulationStep = -1

    public compilingSimulation = false

    simulationCommands: vscode.Command[] = []

    startTime = 0

    endTime = 0

    public static readonly viewType = 'kieler-simulation-table'

    public kico: CompilationDataProvider

    private lsClient: LanguageClient

    private systems: CompilationSystem[] = []

    private snapshotSystems: CompilationSystem[] = []

    private simulationStatus: vscode.StatusBarItem

    protected table: TableWebview

    protected view: vscode.WebviewView | undefined

    protected disposables: vscode.Disposable[] = []

    constructor(
        lsClient: LanguageClient,
        kico: CompilationDataProvider,
        readonly context: vscode.ExtensionContext,
        private readonly settings: SettingsService<Settings>
    ) {
        // Output channel
        this.output = vscode.window.createOutputChannel('KIELER Simulation')
        this.output.appendLine(`[INFO]\t${'Simulation view is created'}`)

        this.lsClient = lsClient
        this.kico = kico
        this.simulationStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
        this.context.subscriptions.push(this.simulationStatus)

        // Push context variables for conditional menu items
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)

        // Bind to events
        this.disposables.push(
            kico.newSimulationCommands((systems) => {
                if (typeof systems !== 'undefined') {
                    this.registerSimulationCommands(systems)
                }
                // Else case is not important enough to alert the user
            })
        )
        this.disposables.push(
            kico.compilationStarted(() => {
                this.compilationStarted()
            })
        )
        this.disposables.push(
            kico.compilationFinished((success) => {
                if (typeof success !== 'undefined') {
                    this.compilationFinished(success)
                }
                // Else case is not important enough to alert the user
            })
        )
        // Bind to LSP messages
        this.disposables.push(
            lsClient.onDidChangeState((event) => {
                if (event.newState === State.Stopped) this.resetForRestart()
            }),
            lsClient.onNotification(externalStepMessageType, (message: SimulationStepMessage) => {
                this.handleStepMessage(message)
            }),
            lsClient.onNotification(valuesForNextStepMessageType, (message: SimulationStepMessage) => {
                this.handleExternalNewUserValue(message)
            }),
            lsClient.onNotification(externalStopMessageType, (message: string) => {
                this.handleExternalStop(message)
            }),
            lsClient.onNotification(startedSimulationMessageType, (message: SimulationStartedMessage) => {
                this.handleSimulationStarted(message)
            })
        )
        this.context.subscriptions.push(this)

        // Create commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SIMULATE.command, async () => {
                await this.restartSimulation()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(STOP_SIMULATION.command, async () => {
                await this.stopSimulation()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(STEP_SIMULATION.command, async () => {
                await this.executeSimulationStep()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(PAUSE_SIMULATION.command, async () => {
                await this.setPlaying(false)
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(RUN_SIMULATION.command, async () => {
                await this.setPlaying(true)
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SAVE_TRACE.command, async () => {
                await this.saveTrace()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(LOAD_TRACE.command, async () => {
                await this.loadTrace()
            })
        )

        // Simulation quickpick commands

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_AND_SIMULATE.command, (uri?: vscode.Uri) =>
                this.compileAndSimulate(false, uri)
            )
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_AND_SIMULATE_SNAPSHOT.command, () => this.compileAndSimulate(true))
        )

        // Kviz commands

        this.context.subscriptions.push(
            vscode.commands.registerCommand(OPEN_EXTERNAL_KVIZ_VIEW.command, this.openExternalKVizView, this)
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(ADD_CO_SIMULATION.command, this.handleAddCoSimulation, this)
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(NEW_VALUE_SIMULATION.command, this.newInputValue, this)
        )

        // settings commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SET_SIMULATION_STEP_DELAY.command, async () => {
                const input = await vscode.window.showInputBox({
                    validateInput: (val) =>
                        /^\d+$/.test(val.trim()) && Number.isSafeInteger(Number(val))
                            ? null
                            : 'Enter a non-negative whole number of milliseconds.',
                })
                if (input !== undefined) {
                    await this.settings.set('simulationStepDelay', Number(input))
                }
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SET_SIMULATION_TYPE_TO.command, () => {
                const simulationTypes: Tuple<SimulationType> = ['Manual', 'Periodic', 'Dynamic']
                const options: vscode.QuickPickItem[] = simulationTypes.map((type) => ({
                    label: type,
                    picked: this.settings.get('simulationType') === type,
                }))
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('simulationType', selection[0].label as SimulationType)
                    }
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_INTERNAL_VARIABLES.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('showInternalVariables.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('showInternalVariables.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('showInternalVariables.enabled', selection[0]?.label === 'true')
                        this.initializeTable()
                    }
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        // Initialize webview
        const tWebview = new TableWebview(
            'KIELER Simulation',
            [this.getExtensionFileUri('dist')],
            this.getExtensionFileUri('dist', 'simulation-webview.js')
        )
        tWebview.webview = webviewView.webview
        tWebview.webview.options = {
            enableScripts: true,
        }
        const title = tWebview.getTitle()
        webviewView.title = title
        tWebview.initializeWebview(webviewView.webview, title, ['Name', 'Input', 'Value', 'History'])
        this.table = tWebview
        this.view = webviewView

        // Subscriptions
        this.context.subscriptions.push(
            this.table.cellClicked((cell: { rowId: string; columnId: string } | undefined) => {
                if (cell && cell.rowId && cell.columnId === 'Input') {
                    this.clickedRow(cell.rowId)
                }
            })
        )
        this.table.initialized(() => {
            this.initializeTable()
        })
    }

    clickedRow(rowId: string): void {
        const data = this.simulationData.get(rowId)
        if (!data || !data.input) {
            return
        }
        const current = this.valuesForNextStep.get(rowId)
        if (typeof current === 'boolean') {
            this.setInputValue(data, !current)
        } else {
            this.newInputValue(data)
        }
    }

    /**
     * Queues a new input value for the next tick and reflects it in the table.
     */
    setInputValue(simulationData: SimulationData, value: unknown): void {
        if (
            !this.simulationRunning ||
            this.phase !== 'running' ||
            !simulationData.input ||
            this.simulationData.get(simulationData.id) !== simulationData ||
            !isCompatibleInput(value, this.valuesForNextStep.get(simulationData.id))
        )
            return
        this.valuesForNextStep.set(simulationData.id, value)
        this.changedValuesForNextStep.set(simulationData.id, value)
        this.table?.updateCell(simulationData.id, 'Input', this.inputCell(simulationData))
        this.onDidChangeViewStateEmitter.fire()
    }

    /** Stops the running simulation, if any, and starts it again from tick 0 with the same compiled model. */
    async restartSimulation(): Promise<void> {
        if (this.phase === 'starting' || this.phase === 'stopping') return
        const uri = this.modelUri ?? this.kico.lastCompiledUri
        if (this.simulationRunning) {
            if (!(await this.stopSimulation())) return
        }
        await this.simulate(uri)
    }

    private setPhase(phase: SimulationPhase): void {
        this.phase = phase
        this.onDidChangeViewStateEmitter.fire()
    }

    async waitForRunning(): Promise<boolean> {
        if (this.phase !== 'starting') return this.phase === 'running'
        return new Promise<boolean>((resolve) => {
            const subscription = this.onDidChangeViewState(() => {
                if (this.phase !== 'starting') {
                    subscription.dispose()
                    resolve(this.phase === 'running')
                }
            })
        })
    }

    /**
     * Forgets the running simulation without contacting the server, e.g. before restarting the server.
     */
    resetForRestart(): void {
        this.setValuesToStopSimulation()
        this.compilingSimulation = false
        this.stopRequest = undefined
        this.modelUri = undefined
        this.lastError = undefined
        this.simulationStep = -1
        this.table?.reset()
        this.updateTickIndicators()
        this.simulationStatus.hide()
        this.setPhase('idle')
    }

    dispose() {
        this.stepper.reset()
        clearTimeout(this.startTimer)
        this.disposables.forEach((d) => d.dispose())
        this.table?.dispose()
        this.output.dispose()
        this.onDidChangeViewStateEmitter.dispose()
        this.newSimulationDataEmitter.dispose()
        this.onRequestSimulationSystemsEmitter.dispose()
        this.onDidChangeOpenStateEmitter.dispose()
    }

    async compileAndSimulate(snapshot: boolean, uri?: vscode.Uri): Promise<boolean> {
        if (this.pickingSystem || this.phase === 'starting' || this.phase === 'stopping' || this.kico.compiling)
            return false
        this.pickingSystem = true
        const { generation } = this
        try {
            if (uri && uri.toString() !== this.kico.editor?.document.uri.toString()) {
                const editor = await vscode.window.showTextDocument(uri, { preserveFocus: true })
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        subscription.dispose()
                        reject(new Error('The simulation systems did not load.'))
                    }, 10000)
                    const subscription = this.kico.newSimulationCommands(() => {
                        clearTimeout(timer)
                        subscription.dispose()
                        resolve()
                    })
                    this.kico.onDidChangeActiveTextEditor(editor).catch((error) => {
                        clearTimeout(timer)
                        subscription.dispose()
                        reject(error)
                    })
                })
            }
            const { editor } = this.kico
            const systems = snapshot ? this.snapshotSystems : this.systems
            if (!editor || systems.length === 0) {
                await vscode.window.showInformationMessage(
                    'Open a supported model and wait for its simulation systems to load.'
                )
                return false
            }
            const selected = await vscode.window.showQuickPick(
                systems.map((system) => ({ label: system.label, description: system.id, system })),
                { title: snapshot ? 'Simulate diagram snapshot' : 'Simulate model' }
            )
            if (!selected || generation !== this.generation) return false
            if (this.simulationRunning && !(await this.stopSimulation())) return false
            const preparedGeneration = this.generation
            if (editor.document.isDirty && !(await editor.document.save()))
                throw new Error('The model could not be saved.')
            if (preparedGeneration !== this.generation) return false
            this.lastError = undefined
            this.modelUri = editor.document.uri.toString()
            this.compilingSimulation = true
            this.setPhase('starting')
            await this.kico.compile(selected.system.id, true, false, snapshot, this.modelUri)
            return true
        } catch (error) {
            this.fail(`The simulation could not be prepared: ${error}`)
            return false
        } finally {
            this.pickingSystem = false
        }
    }

    private fail(message: string): void {
        this.lastError = message
        this.compilingSimulation = false
        this.setValuesToStopSimulation()
        this.simulationStatus.text = '$(error) Simulation failed'
        this.simulationStatus.tooltip = message
        this.simulationStatus.show()
        this.output.appendLine(`[ERROR]\t${message}`)
    }

    createQuickPick(systems: CompilationSystem[]): vscode.QuickPickItem[] {
        const quickPicks: vscode.QuickPickItem[] = []
        systems.forEach((system) => {
            quickPicks.push({
                label: system.label,
            })
        })
        return quickPicks
    }

    // SIMULATION

    /**
     * Registers send systems as simulation systems in the command palette
     * @param systems systems that are assumed to be simulation systems
     */
    registerSimulationCommands(systemsMessage: CompilationSystemsMessage): void {
        this.systems = []
        this.snapshotSystems = []
        systemsMessage.systems.forEach((system) => {
            this.systems.push(system)
        })
        systemsMessage.snapshotSystems.forEach((system) => {
            this.snapshotSystems.push(system)
        })
        this.simulationStatus.hide()
    }

    /**
     * Called after a compilation process was started
     */
    compilationStarted(): void {
        // this.update()
    }

    /**
     * Called after compilation finished.
     */
    compilationFinished(successful: boolean): void {
        if (this.compilingSimulation) {
            // If a simulation systems is currently compiling one has to simulate it afterwards
            this.compilingSimulation = false
            if (successful) {
                this.simulate(this.modelUri)
            } else {
                this.lastError = 'The model could not be compiled for simulation. See the KIELER Compiler panel.'
                this.setPhase('idle')
            }
        } else {
            // this.update()
        }
    }

    async handleAddCoSimulation(): Promise<void> {
        // TODO Uri of simulation file
        const executableUri = await vscode.window.showOpenDialog({
            title: 'Select CoSimulation executable',
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
        })
        if (executableUri) {
            const lClient = await this.lsClient
            lClient.sendNotification('keith/simulation/addCoSimulation', {
                clientId: 'keith-diagram_sprotty',
                fileUri: executableUri[0].path.toString(),
            })
        }
    }

    async newInputValue(simulationData: SimulationData): Promise<void> {
        const result = await vscode.window.showInputBox({
            value: JSON.stringify(this.valuesForNextStep.get(simulationData.id)),
            placeHolder: `Input value for ${simulationData.id}`,
            title: `New value for ${simulationData.id}`,
            validateInput: (text) => {
                try {
                    if (isCompatibleInput(JSON.parse(text), this.valuesForNextStep.get(simulationData.id))) return ''
                } catch {
                    return 'Enter a valid JSON value.'
                }
                return 'The value must match the input’s type and array dimensions.'
            },
        })
        if (result) {
            this.setInputValue(simulationData, JSON.parse(result))
        }
    }

    /**
     * Invoke simulation.
     * To be successful a compilation with a simulation compilation system has to be invoked before this function call.
     */
    async simulate(uri = this.kico.lastCompiledUri): Promise<void> {
        if (this.starting || this.simulationRunning || this.phase === 'stopping') return
        if (!uri) {
            this.fail('Compile a model with a simulation system first.')
            return
        }
        const { generation } = this
        this.starting = true
        this.modelUri = uri
        this.lastError = undefined
        this.startTime = Date.now()
        this.setPhase('starting')
        this.simulationStatus.text = '$(loading~spin) Starting simulation...'
        this.simulationStatus.show()
        this.startTimer = setTimeout(
            () => this.fail('Starting the simulation timed out. Restart the KIELER language server and try again.'),
            30000
        )
        try {
            await this.lsClient.start()
            if (generation !== this.generation) return
            await this.lsClient.sendNotification('keith/simulation/start', {
                uri,
                simulationType: this.settings.get('simulationType'),
            })
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation could not be started: ${error}`)
        }
    }

    /**
     * Start simulation after server successfully started it.
     */
    async handleSimulationStarted(startMessage: SimulationStartedMessage): Promise<void> {
        if (!this.starting || this.phase !== 'starting') return
        this.starting = false
        clearTimeout(this.startTimer)
        this.endTime = Date.now()
        if (!startMessage.successful) {
            this.fail(`The simulation could not be started: ${startMessage.error}`)
            return
        }
        if (!startMessage.dataPool || !startMessage.propertySet) {
            this.fail('The language server returned an invalid simulation configuration.')
            return
        }
        this.simulationData.clear()
        this.valuesForNextStep.clear()
        this.changedValuesForNextStep.clear()
        this.simulationStatus.show()

        // Get the start configuration for the simulation
        const pool: Map<string, unknown> = new Map(Object.entries(startMessage.dataPool))
        const propertySet: Map<string, string[]> = new Map(Object.entries(startMessage.propertySet))
        // Inputs and outputs are handled separately
        let inputs: string[] | undefined = propertySet.get('input')
        inputs = inputs === undefined ? [] : inputs
        let outputs: string[] | undefined = propertySet.get('output')
        outputs = outputs === undefined ? [] : outputs
        // Construct list of all categories
        this.categories = Array.from(propertySet.keys())
        pool.forEach((value, key) => {
            // Add list of properties to SimulationData
            const categoriesList: string[] = []
            propertySet.forEach((list, propertyKey) => {
                if (list.includes(key)) {
                    categoriesList.push(propertyKey)
                }
            })
            const newData: SimulationData = {
                id: key,
                label: key,
                data: [],
                input: inputs?.includes(key) ?? false,
                output: outputs?.includes(key) ?? false,
                categories: categoriesList,
            }
            this.simulationData.set(key, newData)
            // Set the value for which will be set for the next step for inputs
            if (inputs?.includes(key)) {
                this.valuesForNextStep.set(key, value)
                // Timed models never advance with Δt at 0, so start with one time unit per tick.
                if (isTimeDelta(newData) && typeof value === 'number' && value === 0) {
                    this.valuesForNextStep.set(key, 1)
                    this.changedValuesForNextStep.set(key, 1)
                }
            }
        })
        this.controlsEnabled = true
        this.simulationRunning = true
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        this.simulationStep = 0
        this.phase = 'running'
        this.initializeTable()
        // The diagram preview carries the simulation controls, so bring it up next to the model being simulated.
        if (this.modelUri) {
            vscode.commands.executeCommand('keith-vscode.diagram.open', vscode.Uri.parse(this.modelUri), {
                preserveFocus: true,
            })
        }
    }

    /**
     * Shows the current tick in the view description and the status bar.
     */
    updateTickIndicators(): void {
        if (this.view) {
            this.view.description = this.phase === 'running' ? `tick ${this.simulationStep}` : undefined
        }
        if (this.phase === 'running') {
            this.simulationStatus.text = `$(debug-step-over) Tick ${this.simulationStep}`
            this.simulationStatus.tooltip = 'Execute simulation step'
            this.simulationStatus.command = STEP_SIMULATION.command
        } else {
            this.simulationStatus.command = undefined
        }
    }

    /**
     * Executes a simulation step on the LS.
     */
    async executeSimulationStep(): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play) return
        const { generation } = this
        try {
            await this.stepper.step()
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation tick failed: ${error}`)
        }
    }

    /**
     * Request a simulation stop from the LS.
     */
    public async stopSimulation(): Promise<boolean> {
        if (this.stopRequest) return this.stopRequest
        if (!this.simulationRunning && !this.starting && !this.compilingSimulation) return false
        this.stepper.reset()
        this.play = false
        this.controlsEnabled = false
        this.starting = false
        this.compilingSimulation = false
        clearTimeout(this.startTimer)
        const generation = ++this.generation
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', false)
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', false)
        this.setPhase('stopping')
        this.simulationStatus.text = '$(loading~spin) Stopping simulation...'
        this.simulationStatus.show()
        const request = (async () => {
            try {
                const message = await this.lsClient.sendRequest<SimulationStoppedMessage>('keith/simulation/stop')
                if (generation !== this.generation) return false
                if (!message.successful) throw new Error(message.message)
                this.setValuesToStopSimulation()
                this.simulationStatus.text = 'Stopped simulation'
                this.simulationStatus.tooltip = ''
                this.table?.reset()
                return true
            } catch (error) {
                if (generation === this.generation) this.fail(`The simulation could not be stopped: ${error}`)
                throw error
            }
        })()
        this.stopRequest = request
        try {
            return await request
        } finally {
            if (this.stopRequest === request) this.stopRequest = undefined
        }
    }

    private setValuesToStopSimulation(): void {
        this.generation++
        this.stepper.reset()
        clearTimeout(this.startTimer)
        this.starting = false
        // Stop all simulation, i.e. empty maps and kill simulation process on LS
        this.valuesForNextStep.clear()
        this.changedValuesForNextStep.clear()
        this.simulationData.clear()
        this.simulationStep = -1
        this.table?.reset()
        // this.simulationTreeData = []
        this.play = false
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)
        this.controlsEnabled = false
        this.simulationRunning = false
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        this.updateTickIndicators()
        this.setPhase('idle')
    }

    /**
     * Toggles play.
     * Begins to execute steps while waiting simulationWidget.simulationDelay between each step.
     */
    async startOrPauseSimulation(): Promise<void> {
        await this.setPlaying(!this.play)
    }

    async setPlaying(playing: boolean): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play === playing) return
        this.play = playing
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)
        this.onDidChangeViewStateEmitter.fire()
        if (this.play) {
            await this.waitForNextStep()
        } else {
            this.stepper.pause()
        }
    }

    /**
     * Asks the user for a file to store the simulation trace from the current simulation in a file.
     */
    async saveTrace(): Promise<void> {
        // Ask the user where to save this trace
        const currentFolder = vscode.workspace.workspaceFolders
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined
        const uri = await vscode.window.showSaveDialog({
            filters: { KTrace: ['ktrace'] },
            title: 'Save current KTrace to...',
            defaultUri: currentFolder ? vscode.Uri.file(`${currentFolder}/trace.ktrace`) : undefined,
        })
        if (uri === undefined) {
            // The user did not pick any file to save to.
            return
        }

        // Request the LS to save the current trace into the file picked by the user.
        const lsClient = await this.lsClient
        const message = (await lsClient.sendRequest('keith/simulation/saveTrace', uri.path)) as SavedTraceMessage
        if (!message.successful) {
            const errorMessage = `could not save trace: ${message.reason}`
            this.output.appendLine(`[ERROR]\t${errorMessage}`)
            vscode.window.showErrorMessage(errorMessage)
        }
    }

    /**
     * Asks the user for a file to load simulation trace from and loads that onto the client and server.
     */
    async loadTrace(): Promise<void> {
        // Loading the trace file.
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { KTrace: ['ktrace'] },
        })
        if (uris === undefined) {
            // The user did not pick any file to load.
            return
        }
        await this.loadTraceFromUri(uris[0])
    }

    async loadTraceFromUri(uri: vscode.Uri): Promise<void> {
        // Send the trace file uri to the server to convert it into a Trace model and to load it.
        const lClient = await this.lsClient
        const message = (await lClient.sendRequest('keith/simulation/loadTrace', uri.path)) as LoadedTraceMessage

        if (!message.successful) {
            const errorMessage = `could not load trace: ${message.reason}`
            this.output.appendLine(`[ERROR]\t${errorMessage}`)
            vscode.window.showErrorMessage(errorMessage)
            return
        }
        // Store the trace model here as well.
        this.currentTrace = message.trace
    }

    /**
     * Execute a simulation step with a delay.
     */
    async waitForNextStep(): Promise<void> {
        const { generation } = this
        try {
            await this.stepper.run(() => this.settings.get('simulationStepDelay'))
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation tick failed: ${error}`)
        }
    }

    /**
     * Is executed after the server finishes a step.
     * @param message data of step, includes new values.
     */
    handleStepMessage(message: SimulationStepMessage): boolean {
        if (!this.simulationRunning || this.phase !== 'running') return false
        if (message?.successful === false) {
            this.fail(`The simulation tick failed: ${message.error ?? 'Unknown server error'}`)
            return false
        }
        if (!message?.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
            this.fail('The language server returned invalid tick data.')
            return false
        }
        const unknown = Object.keys(message.values).find((key) => !this.simulationData.has(key))
        if (unknown) {
            this.fail(`Unexpected value for ${unknown} in simulation data. Restart the simulation.`)
            return false
        }
        this.simulationData.forEach((history, key) => {
            const present = Object.prototype.hasOwnProperty.call(message.values, key)
            const value = present ? message.values[key] : history.data[history.data.length - 1]
            history.data.push(value)
            if (present && history.input && !this.changedValuesForNextStep.has(key)) {
                this.valuesForNextStep.set(key, value)
            }
        })
        this.simulationStep++
        this.stepper.acknowledge()
        this.update()
        return true
    }

    handleExternalNewUserValue(values: unknown): void {
        if (!this.simulationRunning || !values || typeof values !== 'object' || Array.isArray(values)) return
        Object.entries(values).forEach(([id, value]) => {
            if (
                this.simulationData.get(id)?.input &&
                !this.changedValuesForNextStep.has(id) &&
                isCompatibleInput(value, this.valuesForNextStep.get(id))
            ) {
                this.valuesForNextStep.set(id, value)
            }
        })
        this.update()
    }

    handleExternalStop(message: string): void {
        if (this.phase === 'idle' || this.phase === 'stopping') return
        this.output.appendLine(`[ERROR]\tStopped simulation because of an exception on the language server: ${message}`)
        this.fail('The simulation crashed on the language server.')
        vscode.window
            .showErrorMessage('The simulation crashed on the KIELER language server.', RESTART_LANGUAGE_SERVER.title)
            .then((choice) => {
                if (choice === RESTART_LANGUAGE_SERVER.title) {
                    vscode.commands.executeCommand(RESTART_LANGUAGE_SERVER.command)
                }
            })
    }

    /**
     * Start the simulation visualization socket server and opens a browser window.
     */
    async openExternalKVizView(): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running') return
        await this.lsClient.start()
        await this.lsClient.sendNotification('keith/simulation/startVisualizationServer')
        const url = 'http://localhost:5010/visualization'
        await waitForVisualization(url)
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
            throw new Error('The visualization could not be opened in the browser.')
        }
    }

    getExtensionFileUri(...segments: string[]): vscode.Uri {
        return vscode.Uri.file(path.join(this.context.extensionPath, ...segments))
    }

    /**
     * Whether a data pool entry is shown in the table.
     */
    isVisible(entry: SimulationData): boolean {
        if (this.isBlacklisted(entry)) {
            return false
        }
        return !this.isInternal(entry) || this.settings.get('showInternalVariables.enabled')
    }

    isBlacklisted(entry: SimulationData): boolean {
        return SimulationDataBlackList.includes(entry.id)
    }

    /** Symbols the compiler generated rather than the model author. */
    isInternal(entry: SimulationData): boolean {
        if (isTimeRelated(entry)) {
            return false
        }
        return (
            isInternal(entry) ||
            entry.id.includes('_tickCounter') ||
            entry.id.startsWith('_') ||
            entry.id.startsWith('#')
        )
    }

    nameCell(entry: SimulationData): { cssClass: string; value: string } {
        let kind = ''
        if (entry.input) {
            kind = 'in'
        } else if (entry.output) {
            kind = 'out'
        }
        return {
            cssClass: 'simulation-table-label',
            value: JSON.stringify({ name: entry.label, kind, categories: entry.categories }),
        }
    }

    inputCell(entry: SimulationData): { cssClass: string; value: string } {
        if (!entry.input) {
            return { cssClass: 'simulation-table-cell', value: '' }
        }
        const pending = this.changedValuesForNextStep.has(entry.id)
        return {
            cssClass: pending ? 'simulation-table-input-pending' : 'simulation-table-input',
            value: JSON.stringify(this.valuesForNextStep.get(entry.id)),
        }
    }

    valueCell(entry: SimulationData): { cssClass: string; value: string } {
        const latest = entry.data.length > 0 ? entry.data[entry.data.length - 1] : undefined
        return {
            cssClass: 'simulation-table-value',
            value: latest === undefined ? '' : JSON.stringify(latest),
        }
    }

    historyCell(entry: SimulationData): { cssClass: string; value: string } {
        return { cssClass: 'simulation-table-history', value: JSON.stringify(entry.data) }
    }

    initializeTable() {
        // The sidebar table only exists once that view has been opened.
        this.table?.reset()
        this.simulationData.forEach((entry) => {
            if (this.isVisible(entry) && this.table) {
                this.table.addRow(
                    entry.id,
                    this.nameCell(entry),
                    this.inputCell(entry),
                    this.valueCell(entry),
                    this.historyCell(entry)
                )
            }
        })
        this.update()
    }

    update(): void {
        this.updateTickIndicators()
        if (this.simulationRunning && this.table) {
            this.simulationData.forEach((entry) => {
                if (this.isVisible(entry)) {
                    this.table.updateCell(entry.id, 'Input', this.inputCell(entry))
                    this.table.updateCell(entry.id, 'Value', this.valueCell(entry))
                    this.table.updateCell(entry.id, 'History', this.historyCell(entry))
                }
            })
        }
        this.onDidChangeViewStateEmitter.fire()
    }
}

export class SimulationData {
    constructor(
        public label: string,
        public id: string,
        public data: unknown[],
        public input: boolean,
        public output: boolean,
        public categories: string[]
    ) {}
}
