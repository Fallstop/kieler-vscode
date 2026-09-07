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

/* global document, HTMLElement, HTMLInputElement, KeyboardEvent */

import { SimulationVariableState, SimulationViewCommand, SimulationViewState } from '../../../src/simulation/protocol'
import { isCompatibleInput } from '../../../src/simulation/input-value'
import { formatValue, h, replaceChildren, sameValue } from './dom'
import { NumberFormat, describeFormat, parseNumber } from './format'

type GroupKey = 'time' | 'input' | 'output' | 'local' | 'internal'

const GROUPS: { key: GroupKey; title: string; hint: string }[] = [
    {
        key: 'time',
        title: 'Time',
        hint: 'Δt is how much time passes per tick; clocks in the model add it up. Not part of the chart’s interface.',
    },
    {
        key: 'input',
        title: 'Inputs',
        hint: 'Set by the environment. Change one here; the model reads it at the next tick.',
    },
    { key: 'output', title: 'Outputs', hint: 'Written by the model during a tick.' },
    { key: 'local', title: 'Variables', hint: 'Values the model keeps between ticks.' },
    { key: 'internal', title: 'Generated', hint: 'Guards, tick counters and other symbols the compiler added.' },
]

/** Per-variable number formats, owned by the view so they survive rebuilds. */
export interface FormatStore {
    get(id: string): NumberFormat
    cycle(id: string): void
}

interface Edit {
    id: string
    value: string
    start: number | null
    end: number | null
    error?: string
}

/**
 * The trace table: one row per variable, one column per tick, newest on the right. Inputs get an
 * editable "next tick" cell. It is rebuilt on every state update, so an edit in progress is carried
 * across the rebuild.
 */
export class Timeline {
    readonly el = h('div.kv-timeline')

    private edit: Edit | undefined

    private focusedControl: string | undefined

    constructor(
        private readonly send: (command: SimulationViewCommand) => void,
        private readonly formats: FormatStore
    ) {}

    render(state: SimulationViewState): void {
        const stickToEnd = this.el.scrollLeft + this.el.clientWidth >= this.el.scrollWidth - 40
        this.captureEdit()

        const ticks: number[] = []
        for (let tick = state.firstTick; tick <= state.tick; tick++) {
            ticks.push(tick)
        }
        const elided = state.firstTick > 1
        const head = h(
            'tr',
            {},
            h('th.kv-col-name', {}, 'Variable'),
            h('th.kv-col-next', { title: 'What the model will read at the next tick' }, 'Next'),
            elided && h('th.kv-col-more', { title: `Ticks 1 to ${state.firstTick - 1} are no longer shown` }, '…'),
            ...ticks.map((tick) =>
                h(
                    `th.kv-col-tick${tick === state.tick ? '.kv-latest' : ''}`,
                    { title: `After tick ${tick}` },
                    String(tick)
                )
            )
        )

        const bodies = GROUPS.map((group) => {
            const members = state.variables.filter((variable) => groupOf(variable) === group.key)
            if (members.length === 0 || (group.key === 'internal' && !state.showInternal)) {
                return null
            }
            return h(
                'tbody',
                {},
                h(
                    'tr.kv-group',
                    {},
                    h(
                        'th',
                        { colspan: ticks.length + (elided ? 3 : 2), title: group.hint },
                        h('span.kv-group-title', {}, group.title)
                    )
                ),
                ...members.map((variable) => this.row(variable, state, elided))
            )
        })

        replaceChildren(this.el, h('table.kv-table', {}, h('thead', {}, head), ...bodies))
        this.restoreEdit()
        if (stickToEnd) {
            this.el.scrollLeft = this.el.scrollWidth
        }
    }

    private row(variable: SimulationVariableState, state: SimulationViewState, elided: boolean): HTMLElement {
        const format = this.formats.get(variable.id)
        const cells = variable.history.map((value, index) => {
            const tick = state.firstTick + index
            const prev = index > 0 ? variable.history[index - 1] : undefined
            const changed = index > 0 && !sameValue(value, prev)
            const classes = ['kv-cell', tick === state.tick ? 'kv-latest' : '', changed ? 'kv-changed' : '']
                .filter(Boolean)
                .join('.')
            let title = `${variable.label} = ${formatValue(value, format)} after tick ${tick}`
            if (changed) {
                title += ` (was ${formatValue(prev, format)})`
            }
            return h(`td.${classes}`, { title }, valueNode(value, format))
        })
        const categories = variable.categories.length > 0 ? `\n${variable.categories.join(', ')}` : ''
        return h(
            'tr.kv-row',
            {},
            h(
                'td.kv-col-name',
                { title: `${variable.id}${categories}` },
                h('span.kv-name', {}, variable.timeDelta ? `Δt (${variable.label})` : variable.label),
                isNumeric(variable) && !variable.timeDelta && this.formatButton(variable, format)
            ),
            h(
                `td.kv-col-next${variable.pending ? '.kv-pending' : ''}`,
                { title: variable.pending ? 'Queued: the server reads this at the next tick' : undefined },
                variable.role === 'input' ? this.nextControl(variable, format) : null
            ),
            elided && h('td.kv-col-more'),
            ...cells
        )
    }

    /** Small "dec / hex / bin / chr" button that cycles this variable's number format. */
    private formatButton(variable: SimulationVariableState, format: NumberFormat): HTMLElement {
        const { label, title } = describeFormat(format)
        return h(
            'button.kv-fmt',
            {
                type: 'button',
                title: `Shown as ${title}. Click to change the format for ${variable.label}.`,
                'aria-label': `Number format for ${variable.label}: ${title}`,
                'data-control': `fmt:${variable.id}`,
                onclick: () => this.formats.cycle(variable.id),
            },
            label
        )
    }

    private nextControl(variable: SimulationVariableState, format: NumberFormat): HTMLElement {
        if (typeof variable.next === 'boolean') {
            const on = variable.next
            return h(
                'button.kv-switch',
                {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': String(on),
                    'aria-label': `Next value for ${variable.label}`,
                    'data-control': `switch:${variable.id}`,
                    title: `Click to make ${variable.label} ${on ? 'absent' : 'present'} at the next tick`,
                    onclick: () => this.send({ kind: 'setInput', id: variable.id, value: !on }),
                },
                h('span.kv-switch-track', {}, h('span.kv-switch-knob')),
                h('span.kv-switch-label', {}, on ? 'true' : 'false')
            )
        }
        const input = h('input.kv-input', {
            type: 'text',
            value: editValue(variable.next, format),
            'data-id': variable.id,
            title: 'Type a value and press Enter; the model reads it at the next tick',
            'aria-label': `Next value for ${variable.label}`,
            spellcheck: 'false',
        })
        let committed = false
        const commit = (): boolean => {
            if (!input.isConnected) {
                // The row was rebuilt underneath the input; the fresh input carries the edit on.
                return false
            }
            const parsed = parseLike(input.value, variable.next, format)
            if (parsed === undefined) {
                input.classList.add('kv-invalid')
                input.setAttribute('aria-invalid', 'true')
                input.title = 'Invalid value. Use a number, text, or JSON matching this input’s type and array size.'
                return false
            }
            input.classList.remove('kv-invalid')
            input.removeAttribute('aria-invalid')
            committed = true
            if (!sameValue(parsed, variable.next)) {
                this.send({ kind: 'setInput', id: variable.id, value: parsed })
            }
            return true
        }
        input.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                if (commit()) input.blur()
            } else if (event.key === 'Escape') {
                input.value = editValue(variable.next, format)
                committed = true
                input.blur()
            }
            event.stopPropagation()
        })
        input.addEventListener('input', () => {
            committed = false
        })
        input.addEventListener('blur', () => {
            if (!committed) commit()
        })
        return input
    }

    private captureEdit(): void {
        const active = document.activeElement
        this.focusedControl =
            active instanceof HTMLElement && this.el.contains(active) ? active.dataset.control : undefined
        if (active instanceof HTMLInputElement && active.classList.contains('kv-input') && active.dataset.id) {
            this.edit = {
                id: active.dataset.id,
                value: active.value,
                start: active.selectionStart,
                end: active.selectionEnd,
                error: active.getAttribute('aria-invalid') === 'true' ? active.title : undefined,
            }
        } else {
            this.edit = undefined
        }
    }

    private restoreEdit(): void {
        if (!this.edit) {
            if (this.focusedControl) {
                this.el
                    .querySelector<HTMLElement>(`[data-control="${CSS.escape(this.focusedControl)}"]`)
                    ?.focus({ preventScroll: true })
                this.focusedControl = undefined
            }
            return
        }
        const input = this.el.querySelector<HTMLInputElement>(`input.kv-input[data-id="${CSS.escape(this.edit.id)}"]`)
        if (input) {
            input.value = this.edit.value
            input.focus({ preventScroll: true })
            input.setSelectionRange(this.edit.start, this.edit.end)
            if (this.edit.error) {
                input.classList.add('kv-invalid')
                input.setAttribute('aria-invalid', 'true')
                input.title = this.edit.error
            }
        }
        this.edit = undefined
    }
}

function groupOf(variable: SimulationVariableState): GroupKey {
    if (variable.timeDelta) {
        return 'time'
    }
    return variable.internal ? 'internal' : variable.role
}

function isNumeric(variable: SimulationVariableState): boolean {
    const sample = variable.history.length > 0 ? variable.history[variable.history.length - 1] : variable.next
    return typeof sample === 'number'
}

function valueNode(value: unknown, format: NumberFormat): HTMLElement {
    if (typeof value === 'boolean') {
        return h(`span.kv-bit.${value ? 'kv-bit-on' : 'kv-bit-off'}`, { role: 'img', 'aria-label': String(value) })
    }
    return h('span.kv-value', {}, formatValue(value, format))
}

/** Parse `text` as the same kind of value as `like`; undefined when it does not fit. */
export function parseLike(text: string, like: unknown, format: NumberFormat): unknown {
    const trimmed = text.trim()
    if (typeof like === 'number') {
        return parseNumber(trimmed, format)
    }
    if (typeof like === 'string') {
        return text
    }
    try {
        const value: unknown = JSON.parse(trimmed)
        return isCompatibleInput(value, like) ? value : undefined
    } catch {
        return undefined
    }
}

function editValue(value: unknown, format: NumberFormat): string {
    // Composite values remain JSON so changing the number format never corrupts an array edit.
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : formatValue(value, format)
}
