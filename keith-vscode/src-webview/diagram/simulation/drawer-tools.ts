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

/* global HTMLElement */

import { SimulationViewCommand, SimulationViewState } from '../../../src/simulation/protocol'
import { h, icon } from './dom'

type Send = (command: SimulationViewCommand) => void

function button(iconName: string, label: string, title: string, onclick: () => void, on?: boolean): HTMLElement {
    return h(
        `button.kv-btn.kv-btn-quiet${on ? '.kv-btn-active' : ''}`,
        {
            type: 'button',
            title: `${label}: ${title}`,
            'aria-label': label,
            'aria-pressed': on === undefined ? undefined : String(on),
            onclick,
        },
        icon(iconName),
        h('span.kv-btn-label', {}, label)
    )
}

/** The trace's own controls, at the right end of the drawer's summary line. */
export function renderDrawerTools(state: SimulationViewState, send: Send): HTMLElement {
    return h(
        'div.kv-drawer-tools',
        {},
        button(
            'symbol-misc',
            'Generated',
            'Show guards, tick counters and other symbols the compiler added',
            () => send({ kind: 'setShowInternal', enabled: !state.showInternal }),
            state.showInternal
        ),
        button('save', 'Save', 'Save the trace so far as a .ktrace file', () => send({ kind: 'saveTrace' })),
        button('folder-opened', 'Load', 'Load a .ktrace file to replay', () => send({ kind: 'loadTrace' }))
    )
}
