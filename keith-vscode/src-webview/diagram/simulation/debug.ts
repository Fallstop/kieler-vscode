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

/* global document, HTMLElement, HTMLInputElement, KeyboardEvent, MouseEvent */

import {
    BreakpointState,
    SimulationDebugState,
    SimulationViewCommand,
    WatchState,
} from '../../../src/simulation/protocol'
import { formatValue, h, icon, replaceChildren } from './dom'

type Send = (command: SimulationViewCommand) => void

function describe(breakpoint: BreakpointState): string {
    return breakpoint.kind === 'state' ? `enter ${breakpoint.state}` : `when ${breakpoint.expression}`
}

/** An input that sends its text on Enter and swallows the workbench shortcuts. */
function entry(placeholder: string, control: string, submit: (text: string) => void): HTMLInputElement {
    const input = h('input.kv-debug-entry', {
        type: 'text',
        placeholder,
        spellcheck: 'false',
        'aria-label': placeholder,
        'data-control': control,
    })
    input.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && input.value.trim()) {
            submit(input.value.trim())
            input.value = ''
        } else if (event.key === 'Escape') {
            input.blur()
        }
        event.stopPropagation()
    })
    return input
}

/**
 * The breakpoint list: a popover under the toolbar's Breakpoints button. A breakpoint is either a
 * state to pause on when it is entered, or a condition to pause on when it holds after a tick.
 */
export class BreakpointPanel {
    readonly el = h('div.kv-popover.kv-breakpoints', { hidden: true, role: 'dialog', 'aria-label': 'Breakpoints' })

    private open = false

    constructor(private readonly send: Send) {
        document.addEventListener('mousedown', (event) => {
            const target = (event as MouseEvent).target as HTMLElement | null
            if (this.open && target && !this.el.contains(target) && !target.closest('[data-control="Breakpoints"]')) {
                this.toggle(false)
            }
        })
    }

    isOpen(): boolean {
        return this.open
    }

    toggle(open = !this.open): void {
        this.open = open
        this.el.hidden = !open
        if (open) {
            this.el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
        }
    }

    render(debug: SimulationDebugState | undefined): void {
        if (!debug) {
            this.toggle(false)
            replaceChildren(this.el)
            return
        }
        const focused = document.activeElement
        const keep = focused instanceof HTMLInputElement && this.el.contains(focused) ? focused.value : undefined
        const rows = debug.breakpoints.map((breakpoint) => this.row(breakpoint, debug))
        const stateEntry = entry('State name, e.g. Counting.Full', 'bp-state', (state) =>
            this.send({ kind: 'addBreakpoint', state })
        )
        const conditionEntry = entry('Condition, e.g. count >= 3 && !done', 'bp-condition', (expression) =>
            this.send({ kind: 'addBreakpoint', expression })
        )
        replaceChildren(
            this.el,
            h('div.kv-popover-title', {}, 'Breakpoints'),
            rows.length
                ? h('ul.kv-debug-list', {}, ...rows)
                : h('p.kv-debug-empty', {}, 'Pause the simulation when a state is entered or a condition holds.'),
            h(
                'div.kv-debug-add',
                {},
                h('label.kv-debug-add-label', {}, icon('circle-filled'), 'Enter state'),
                stateEntry,
                h('label.kv-debug-add-label', {}, icon('debug-breakpoint-conditional'), 'When'),
                conditionEntry
            ),
            h(
                'p.kv-debug-hint',
                {},
                'Names may be qualified (Root.Region.State). Conditions use SCCharts syntax; pre(x) reads the previous tick.'
            )
        )
        if (keep !== undefined) {
            const input = this.el.querySelector<HTMLInputElement>('input')
            if (input) {
                input.value = keep
                input.focus({ preventScroll: true })
            }
        }
    }

    private row(breakpoint: BreakpointState, debug: SimulationDebugState): HTMLElement {
        const hit = debug.paused?.id === breakpoint.id
        const classes = ['kv-debug-item', breakpoint.error ? 'kv-debug-error' : '', hit ? 'kv-debug-hit' : '']
            .filter(Boolean)
            .join('.')
        return h(
            `li.${classes}`,
            { title: breakpoint.error ?? breakpoint.note ?? (hit ? `Paused here at tick ${debug.paused?.step}` : '') },
            h('input', {
                type: 'checkbox',
                checked: breakpoint.enabled,
                'aria-label': `Enable breakpoint ${describe(breakpoint)}`,
                onchange: (event) =>
                    this.send({
                        kind: 'toggleBreakpoint',
                        id: breakpoint.id,
                        enabled: (event.target as HTMLInputElement).checked,
                    }),
            }),
            icon(breakpoint.kind === 'state' ? 'circle-filled' : 'debug-breakpoint-conditional', 'kv-debug-kind'),
            h('span.kv-debug-text', {}, describe(breakpoint)),
            breakpoint.error && h('span.kv-debug-problem', {}, icon('warning'), breakpoint.error),
            !breakpoint.error && breakpoint.note && h('span.kv-debug-note', {}, breakpoint.note),
            h(
                'button.kv-btn.kv-btn-icon.kv-debug-remove',
                {
                    type: 'button',
                    title: 'Remove breakpoint',
                    'aria-label': `Remove breakpoint ${describe(breakpoint)}`,
                    onclick: () => this.send({ kind: 'removeBreakpoint', id: breakpoint.id }),
                },
                icon('close')
            )
        )
    }
}

/**
 * Watch expressions with their value after the latest tick, shown above the trace table. Errors
 * (an unknown variable, a division by zero) show in red next to the expression.
 */
export class WatchPanel {
    readonly el = h('div.kv-watches')

    constructor(private readonly send: Send) {}

    render(debug: SimulationDebugState | undefined): void {
        if (!debug) {
            replaceChildren(this.el)
            this.el.hidden = true
            return
        }
        this.el.hidden = false
        const focused = document.activeElement
        const keep = focused instanceof HTMLInputElement && this.el.contains(focused) ? focused.value : undefined
        const add = entry('Watch an expression, e.g. count * 10', 'watch-add', (expression) =>
            this.send({ kind: 'addWatch', expression })
        )
        replaceChildren(
            this.el,
            h('span.kv-watches-label', { title: 'Expressions evaluated after every tick' }, icon('eye'), 'Watch'),
            ...debug.watches.map((watch) => this.chip(watch)),
            add
        )
        if (keep !== undefined) {
            add.value = keep
            add.focus({ preventScroll: true })
        }
    }

    private chip(watch: WatchState): HTMLElement {
        return h(
            `span.kv-watch${watch.error ? '.kv-watch-error' : ''}`,
            { title: watch.error ?? `${watch.expression} = ${formatValue(watch.value)}` },
            h('span.kv-watch-expr', {}, watch.expression),
            h('span.kv-watch-eq', {}, '='),
            h('span.kv-watch-value', {}, watch.error ? 'error' : formatValue(watch.value)),
            h(
                'button.kv-watch-remove',
                {
                    type: 'button',
                    title: 'Remove watch',
                    'aria-label': `Remove watch ${watch.expression}`,
                    onclick: () => this.send({ kind: 'removeWatch', id: watch.id }),
                },
                icon('close')
            )
        )
    }
}

/** The "paused at breakpoint" strip shown above the trace while the simulation waits. */
export function renderPauseNotice(debug: SimulationDebugState | undefined): HTMLElement | null {
    if (!debug?.paused) return null
    return h(
        'div.kv-pause-notice',
        { role: 'status' },
        icon(debug.paused.kind === 'state' ? 'circle-filled' : 'debug-breakpoint-conditional'),
        h('span.kv-pause-text', {}, `Paused at tick ${debug.paused.step}: ${debug.paused.label}`)
    )
}
