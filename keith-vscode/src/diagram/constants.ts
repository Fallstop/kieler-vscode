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

import { diagramType as originalDiagramType } from '@kieler/klighd-core'

/**
 * Diagram type that KLighD uses to communicate Sprotty diagrams with the LS. It is also the
 * webview type, and `${diagramType}-focused` (keith-diagram-focused) is the context key that is
 * true while a diagram panel is active.
 */
export const diagramType = originalDiagramType

/**
 * The language server addresses the (single) diagram by this client id, and keith's simulation
 * highlighting hardcodes it too, so every diagram panel reuses it.
 */
export const diagramClientId = `${diagramType}_sprotty`

const withPrefix = (name: string) => `keith-vscode.${name}`

/** Diagram commands. They live in keith-vscode's namespace so an installed klighd-vscode cannot collide. */
export const command = {
    clearData: withPrefix('diagram.data.clear'),
    debugOptions: withPrefix('diagram.debugOptions'),
    diagramOpen: withPrefix('diagram.open'),
    diagramExport: withPrefix('diagram.export'),
    diagramCenter: withPrefix('diagram.center'),
    diagramFit: withPrefix('diagram.fit'),
    diagramLayout: withPrefix('diagram.layout'),
    diagramRefresh: withPrefix('diagram.refresh'),
    diagramRestart: withPrefix('diagram.restart'),
    diagramSync: withPrefix('diagram.sync'),
    diagramNoSync: withPrefix('diagram.noSync'),
}

export const contextKeys = {
    syncWithEditor: withPrefix('syncWithEditor'),
    diagramOpen: withPrefix('diagramOpen'),
}
