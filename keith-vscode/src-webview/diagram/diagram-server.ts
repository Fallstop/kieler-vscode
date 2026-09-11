/*
 * SCCharts Lab
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { Connection, ServiceTypes } from '@kieler/klighd-core'
import { KlighdDiagramServer } from '@kieler/klighd-core/lib/diagram-server'
import { inject, injectable } from 'inversify'
import { DiagramServerProxy } from 'sprotty'
import { ActionMessage } from 'sprotty-protocol'
import { keepsViewport } from './viewport-policy'

/** Sprotty declares the proxy's `messageReceived` protected; klighd-core's subclass opens it up. */
const plainMessageReceived = (DiagramServerProxy.prototype as unknown as KlighdDiagramServer).messageReceived

/** Tells the diagram server whether a simulation is running in this webview. */
export const SimulationRunning = Symbol('SimulationRunning')

export type SimulationRunningQuery = () => boolean

/**
 * klighd-core's diagram server refits the diagram after every model update while "Resize To Fit on Refresh" is on,
 * which is the default and, without the sidebar, cannot be changed. A running simulation sends a model update per
 * tick, so this server applies those updates the plain sprotty way, keeping the viewport.
 */
@injectable()
export class KeithDiagramServer extends KlighdDiagramServer {
    constructor(
        @inject(ServiceTypes.Connection) connection: Connection,
        @inject(SimulationRunning) private readonly simulationRunning: SimulationRunningQuery
    ) {
        super(connection)
    }

    override messageReceived(message: ActionMessage): void {
        if (keepsViewport(message.action?.kind, this.simulationRunning())) {
            // Sprotty's proxy applies the model and keeps the viewport; klighd-core's override would refit.
            plainMessageReceived.call(this, message)
            return
        }
        super.messageReceived(message)
    }
}
