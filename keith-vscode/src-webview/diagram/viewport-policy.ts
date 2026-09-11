/*
 * SCCharts Lab
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/** Action kinds after which klighd-core refits the diagram when "Resize To Fit on Refresh" is on. */
const modelActions = new Set(['setModel', 'updateModel'])

/**
 * Whether a server message should leave the viewport where the user put it instead of refitting the diagram.
 *
 * A running simulation relays the diagram out after every tick to move the highlighting, which is not a reason to
 * throw away the user's zoom and scroll; the model update itself keeps the viewport, only klighd-core's refit resets it.
 */
export function keepsViewport(actionKind: string | undefined, simulationRunning: boolean): boolean {
    return simulationRunning && actionKind !== undefined && modelActions.has(actionKind)
}
