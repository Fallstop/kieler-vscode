/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
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

import * as path from 'path'
import * as vscode from 'vscode'
import { Settings, settingsKey } from '../constants'
import { DiagramController } from '../diagram/diagram-controller'
import { SettingsService } from '../settings'
import {
    COMPILE_AND_SIMULATE,
    LOAD_TRACE,
    OPEN_EXTERNAL_KVIZ_VIEW,
    PAUSE_SIMULATION,
    RUN_SIMULATION,
    SAVE_TRACE,
    STEP_SIMULATION,
    STOP_SIMULATION,
} from './commands'
import {
    HISTORY_WINDOW,
    SimulationVariableState,
    SimulationViewCommand,
    SimulationViewState,
    simulationCommandNotification,
    simulationStateNotification,
} from './protocol'
import { isTimeDelta } from './helper'
import { SimulationData, SimulationTableDataProvider } from './simulation-table-data-provider'

/**
 * Connects the simulation state owned by {@link SimulationTableDataProvider} to the controls
 * rendered inside the diagram preview webview. State flows out as one snapshot per change;
 * user actions flow back as commands and are routed to the existing VS Code commands.
 */
export class SimulationViewBridge implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = []

    constructor(
        private readonly simulation: SimulationTableDataProvider,
        private readonly diagrams: DiagramController,
        private readonly settings: SettingsService<Settings>
    ) {
        this.disposables.push(
            diagrams.onWebviewNotification(simulationCommandNotification, (command) => {
                this.handle(command).catch((error) => {
                    vscode.window.showErrorMessage(`The simulation command failed: ${error}`)
                    this.push()
                })
            })
        )
        this.disposables.push(simulation.onDidChangeViewState(() => this.push()))
        this.disposables.push(diagrams.onDidChangeDiagram(() => this.push()))
        // The settings cache refreshes in an earlier listener, so the values are current here.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`${settingsKey}.showInternalVariables.enabled`)) {
                    simulation.initializeTable()
                } else if (event.affectsConfiguration(settingsKey)) {
                    this.push()
                }
            })
        )
    }

    dispose(): void {
        this.disposables.forEach((disposable) => disposable.dispose())
    }

    push(): void {
        this.diagrams.sendToDiagram(simulationStateNotification, this.viewState())
    }

    private async handle(command: SimulationViewCommand): Promise<void> {
        if (!command || typeof command.kind !== 'string') return
        switch (command.kind) {
            case 'requestState':
                this.push()
                break
            case 'start':
                await vscode.commands.executeCommand(COMPILE_AND_SIMULATE.command, this.diagrams.currentUri)
                break
            case 'step':
                await vscode.commands.executeCommand(STEP_SIMULATION.command)
                break
            case 'play':
                if (!this.simulation.play) {
                    await vscode.commands.executeCommand(RUN_SIMULATION.command)
                }
                break
            case 'pause':
                if (this.simulation.play) {
                    await vscode.commands.executeCommand(PAUSE_SIMULATION.command)
                }
                break
            case 'stop':
                await vscode.commands.executeCommand(STOP_SIMULATION.command)
                break
            case 'restart':
                await this.simulation.restartSimulation()
                break
            case 'saveTrace':
                await vscode.commands.executeCommand(SAVE_TRACE.command)
                break
            case 'loadTrace':
                await vscode.commands.executeCommand(LOAD_TRACE.command)
                break
            case 'openExternal':
                await vscode.commands.executeCommand(OPEN_EXTERNAL_KVIZ_VIEW.command)
                break
            case 'setInput': {
                const data = this.simulation.simulationData.get(command.id)
                if (data && data.input) {
                    this.simulation.setInputValue(data, command.value)
                }
                break
            }
            case 'setStepDelay':
                if (Number.isSafeInteger(command.delay) && command.delay >= 0) {
                    await this.settings.set('simulationStepDelay', command.delay)
                }
                break
            case 'setShowInternal':
                if (typeof command.enabled === 'boolean') {
                    await this.settings.set('showInternalVariables.enabled', command.enabled)
                }
                break
            default:
                break
        }
    }

    viewState(): SimulationViewState {
        const sim = this.simulation
        const tick = sim.simulationStep < 0 ? 0 : sim.simulationStep
        const firstTick = Math.max(1, tick - HISTORY_WINDOW + 1)
        const variables: SimulationVariableState[] = []
        sim.simulationData.forEach((entry) => {
            if (!sim.isBlacklisted(entry)) {
                variables.push(this.variableState(entry, tick, firstTick))
            }
        })
        const uri =
            sim.phase === 'idle' && !sim.lastError ? this.diagrams.currentUri?.toString() ?? sim.modelUri : sim.modelUri
        const model = uri ? path.basename(vscode.Uri.parse(uri).path) : undefined
        return {
            phase: sim.phase,
            playing: sim.play,
            tick,
            firstTick,
            stepDelay: this.settings.get('simulationStepDelay'),
            showInternal: this.settings.get('showInternalVariables.enabled'),
            model,
            variables,
            error: sim.lastError,
        }
    }

    private variableState(entry: SimulationData, tick: number, firstTick: number): SimulationVariableState {
        // history[i] holds the value after tick i + 1.
        const history = entry.data.slice(Math.max(0, firstTick - 1), Math.max(0, tick))
        let role: SimulationVariableState['role'] = 'local'
        if (entry.input) {
            role = 'input'
        } else if (entry.output) {
            role = 'output'
        }
        return {
            id: entry.id,
            label: entry.label,
            role,
            categories: entry.categories,
            history,
            next: entry.input ? this.simulation.valuesForNextStep.get(entry.id) : undefined,
            pending: this.simulation.changedValuesForNextStep.has(entry.id),
            internal: this.simulation.isInternal(entry),
            timeDelta: isTimeDelta(entry) || undefined,
        }
    }
}
