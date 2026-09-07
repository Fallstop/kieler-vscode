/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2022 by
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

import './style/index.css'
import { AddRowAction, UpdateCellAction } from '@kieler/table-webview/lib/actions'
import { Table } from '@kieler/table-webview/lib/table'

/** How many of the most recent ticks are drawn as chips before the rest is folded away. */
const HISTORY_CHIPS = 24

/**
 * Short, scannable rendering of a simulation value. Booleans become filled/empty dots so
 * present signals stand out in a long history.
 */
function short(value: unknown): string {
    if (typeof value === 'boolean') {
        return value ? '●' : '○'
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return String(value)
    }
    return JSON.stringify(value)
}

function full(value: unknown): string {
    return JSON.stringify(value)
}

function clear(cell: HTMLElement): void {
    while (cell.firstChild) {
        cell.removeChild(cell.firstChild)
    }
}

function renderName(cell: HTMLElement): void {
    let payload: { name: string; kind: string; categories: string[] }
    try {
        payload = JSON.parse(cell.textContent ?? '')
    } catch {
        return
    }
    clear(cell)
    const name = document.createElement('span')
    name.className = 'sim-name'
    name.textContent = payload.name
    cell.appendChild(name)
    if (payload.kind) {
        const badge = document.createElement('span')
        badge.className = `sim-badge sim-badge-${payload.kind}`
        badge.textContent = payload.kind
        cell.appendChild(badge)
    }
    cell.title = payload.categories.join(', ')
}

function renderInput(cell: HTMLElement): void {
    const text = cell.textContent ?? ''
    // Keep the raw JSON as the only text node so the click handler still reports it.
    if (text === 'true' || text === 'false') {
        cell.title = 'Click to toggle for the next tick'
    } else if (text !== '') {
        cell.title = 'Click to enter a value for the next tick'
    }
}

function renderValue(cell: HTMLElement): void {
    const text = cell.textContent ?? ''
    if (text === '') {
        return
    }
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return
    }
    clear(cell)
    const span = document.createElement('span')
    span.className = typeof value === 'boolean' ? `sim-bool sim-bool-${value}` : 'sim-value'
    span.textContent = typeof value === 'boolean' ? `${short(value)} ${value}` : full(value)
    cell.appendChild(span)
}

function renderHistory(cell: HTMLElement): void {
    let values: unknown[]
    try {
        values = JSON.parse(cell.textContent ?? '[]')
    } catch {
        return
    }
    if (!Array.isArray(values)) {
        return
    }
    clear(cell)
    const strip = document.createElement('div')
    strip.className = 'sim-history'
    const newestFirst = values.map((_, i) => values[values.length - 1 - i])
    newestFirst.slice(0, HISTORY_CHIPS).forEach((value, i) => {
        const tick = values.length - i
        const previous = tick >= 2 ? values[tick - 2] : undefined
        const chip = document.createElement('span')
        chip.className = 'sim-chip'
        if (i === 0) {
            chip.classList.add('sim-chip-latest')
        }
        if (previous !== undefined && full(previous) !== full(value)) {
            chip.classList.add('sim-chip-changed')
        }
        if (typeof value === 'boolean') {
            chip.classList.add(value ? 'sim-chip-on' : 'sim-chip-off')
        }
        chip.textContent = short(value)
        chip.title = `tick ${tick}: ${full(value)}`
        strip.appendChild(chip)
    })
    if (values.length > HISTORY_CHIPS) {
        const more = document.createElement('span')
        more.className = 'sim-chip-more'
        more.textContent = `+${values.length - HISTORY_CHIPS}`
        more.title = 'Older ticks'
        strip.appendChild(more)
    }
    cell.appendChild(strip)
}

const renderers: Record<string, (cell: HTMLElement) => void> = {
    'simulation-table-label': renderName,
    'simulation-table-input': renderInput,
    'simulation-table-input-pending': renderInput,
    'simulation-table-value': renderValue,
    'simulation-table-history': renderHistory,
}

/**
 * Simulation table that turns the JSON payloads sent by the extension into readable cells.
 * The base table only knows plain text, so rows are post-processed after every change.
 */
class SimulationTable extends Table {
    lastSelected: HTMLElement

    constructor() {
        super()
        document.addEventListener('click', (event) => {
            const owner = (event.target as HTMLElement).closest('tr')
            if (owner && owner.id !== 'headers') {
                if (this.lastSelected) {
                    this.lastSelected.classList.remove('focused')
                }
                this.lastSelected = owner
                owner.classList.add('focused')
            }
        })
    }

    protected handleAddRow(action: AddRowAction): void {
        super.handleAddRow(action)
        this.enrichRow(action.rowId)
    }

    protected handleUpdateCell(action: UpdateCellAction): void {
        super.handleUpdateCell(action)
        this.enrichRow(action.rowId)
    }

    enrichRow(rowId: string): void {
        const row = document.getElementById(rowId)
        if (!row) {
            return
        }
        Array.from(row.children).forEach((cell) => {
            const element = cell as HTMLElement
            // A freshly patched cell holds only its text payload; rendered cells hold elements.
            if (element.childElementCount > 0) {
                return
            }
            const renderer = Array.from(element.classList)
                .map((cls) => renderers[cls])
                .find((r) => r !== undefined)
            if (renderer) {
                renderer(element)
            }
        })
    }
}

// eslint-disable-next-line no-new
new SimulationTable()
