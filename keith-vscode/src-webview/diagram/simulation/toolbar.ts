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

import { SimulationViewCommand, SimulationViewState } from '../../../src/simulation/protocol'
import { h, icon, replaceChildren } from './dom'

const SLOWEST_MS = 2000
const FASTEST_MS = 50

/** Slider position 0..100 to step delay, log scaled so the slow end is not all the travel. */
function sliderToDelay(position: number): number {
    return Math.round(SLOWEST_MS * (FASTEST_MS / SLOWEST_MS) ** (position / 100))
}

function delayToSlider(delay: number): number {
    const clamped = Math.min(SLOWEST_MS, Math.max(FASTEST_MS, delay))
    return Math.round((100 * Math.log(clamped / SLOWEST_MS)) / Math.log(FASTEST_MS / SLOWEST_MS))
}

export interface ToolbarHost {
    send(command: SimulationViewCommand): void
    toggleDrawer(): void
    drawerOpen(): boolean
}

/**
 * The transport controls along the top of the preview. One row that never wraps: on narrow panels
 * the button labels and then the slider drop away (see the media queries in simulation.css).
 */
export class Toolbar {
    readonly el = h('header.kv-toolbar')

    private renderKey = ''

    constructor(private readonly host: ToolbarHost) {}

    render(state: SimulationViewState): void {
        const key = JSON.stringify([
            state.phase,
            state.canStart,
            state.playing,
            state.model,
            state.error,
            state.stepDelay,
            state.showInternal,
            this.host.drawerOpen(),
        ])
        if (key === this.renderKey) {
            // Only the tick moved; patching it in place keeps focus and avoids any layout shift.
            const tick = this.el.querySelector('.kv-tick-value')
            if (tick) tick.textContent = String(state.tick)
            return
        }
        this.renderKey = key
        const active = document.activeElement
        const focusKey = active instanceof HTMLElement && this.el.contains(active) ? active.dataset.control : undefined
        const model = h(
            'div.kv-model',
            { title: state.model ? `Model: ${state.model}` : 'No model compiled for simulation yet' },
            icon('circuit-board'),
            h('span.kv-model-name', {}, state.model ?? 'KIELER Preview')
        )
        const right = h(
            'div.kv-toolbar-right',
            {},
            state.phase === 'running' && this.traceButtons(),
            state.phase === 'running' &&
                this.toggle(
                    'symbol-misc',
                    'Generated',
                    state.showInternal,
                    'Show guards, tick counters and other symbols the compiler added',
                    () => this.host.send({ kind: 'setShowInternal', enabled: !state.showInternal })
                ),
            state.phase === 'running' &&
                this.toggle('layout-panel', 'Trace', this.host.drawerOpen(), 'Show the tick-by-tick trace', () =>
                    this.host.toggleDrawer()
                )
        )
        replaceChildren(this.el, model, this.middle(state), right)
        if (focusKey) {
            this.el.querySelector<HTMLElement>(`[data-control="${focusKey}"]`)?.focus({ preventScroll: true })
        }
    }

    private middle(state: SimulationViewState): HTMLElement {
        if (state.phase === 'starting' || state.phase === 'stopping') {
            return h(
                'div.kv-toolbar-middle',
                {},
                icon('loading', 'kv-spin'),
                h('span.kv-status', { role: 'status' }, state.phase === 'starting' ? 'Starting…' : 'Stopping…')
            )
        }
        if (state.phase === 'idle') {
            return h(
                'div.kv-toolbar-middle',
                {},
                this.button(
                    'play',
                    'Simulate…',
                    'Compile the model with a simulation system and step through it tick by tick',
                    () => this.host.send({ kind: 'start' }),
                    '.kv-btn-primary',
                    !state.canStart
                ),
                state.error && h('span.kv-error', { title: state.error, role: 'alert' }, icon('warning'), state.error)
            )
        }
        const runOrPause = state.playing
            ? this.button(
                  'debug-pause',
                  'Pause',
                  'Stop running ticks automatically (R)',
                  () => this.host.send({ kind: 'pause' }),
                  '.kv-btn-active.kv-btn-playback'
              )
            : this.button(
                  'debug-start',
                  'Run',
                  'Run ticks automatically, one every delay (R)',
                  () => this.host.send({ kind: 'play' }),
                  '.kv-btn-playback'
              )
        return h(
            'div.kv-toolbar-middle',
            {},
            h(
                'div.kv-btn-group',
                {},
                this.button('debug-restart', 'Restart', 'Start over from tick 0 with the same compiled model', () =>
                    this.host.send({ kind: 'restart' })
                ),
                this.button(
                    'debug-step-over',
                    'Step',
                    'Execute exactly one tick (Space)',
                    () => this.host.send({ kind: 'step' }),
                    '',
                    state.playing
                ),
                runOrPause,
                this.button('debug-stop', 'Stop', 'End the simulation and clear the trace', () =>
                    this.host.send({ kind: 'stop' })
                )
            ),
            h(
                'div.kv-tick',
                { title: 'One tick is one reaction of the model: read inputs, take transitions, write outputs' },
                h('span.kv-tick-label', {}, 'Tick'),
                h('span.kv-tick-value', {}, String(state.tick)),
                h(`span.kv-live${state.playing ? '.kv-live-on' : ''}`, { title: 'Ticks are running automatically' })
            ),
            this.delay(state)
        )
    }

    /** "Delay [200] ms" plus a slider; both set the pause between ticks while running. */
    private delay(state: SimulationViewState): HTMLElement {
        const title = 'Pause between ticks while running'
        const number = h('input.kv-delay-ms', {
            type: 'number',
            min: 0,
            step: 10,
            value: state.stepDelay,
            title,
            'aria-label': 'Delay between ticks in milliseconds',
            'data-control': 'delay-ms',
            onchange: (event) => {
                const delay = Number((event.target as HTMLInputElement).value)
                if (Number.isFinite(delay)) {
                    this.host.send({ kind: 'setStepDelay', delay })
                }
            },
            onkeydown: (event) => {
                if ((event as KeyboardEvent).key === 'Enter') (event.target as HTMLInputElement).blur()
                event.stopPropagation()
            },
        })
        const slider = h('input.kv-delay-slider', {
            type: 'range',
            min: 0,
            max: 100,
            value: delayToSlider(state.stepDelay),
            title,
            'aria-label': 'Delay between ticks',
            'data-control': 'delay',
            oninput: (event) => {
                number.value = String(sliderToDelay(Number((event.target as HTMLInputElement).value)))
            },
            onchange: (event) => {
                this.host.send({
                    kind: 'setStepDelay',
                    delay: sliderToDelay(Number((event.target as HTMLInputElement).value)),
                })
            },
        })
        return h(
            'div.kv-delay',
            { title },
            h('span.kv-delay-label', {}, 'Delay'),
            number,
            h('span.kv-delay-unit', {}, 'ms'),
            slider
        )
    }

    private traceButtons(): HTMLElement {
        return h(
            'div.kv-btn-group.kv-btn-group-quiet',
            {},
            this.iconButton('save', 'Save the trace so far as a .ktrace file', () =>
                this.host.send({ kind: 'saveTrace' })
            ),
            this.iconButton('folder-opened', 'Load a .ktrace file to replay', () =>
                this.host.send({ kind: 'loadTrace' })
            ),
            this.iconButton('link-external', 'Open the KIELER visualization in the browser', () =>
                this.host.send({ kind: 'openExternal' })
            )
        )
    }

    private button(
        iconName: string,
        label: string,
        title: string,
        onclick: () => void,
        extra = '',
        disabled = false
    ): HTMLElement {
        return h(
            `button.kv-btn${extra}`,
            {
                type: 'button',
                title: `${label}: ${title}`,
                onclick,
                disabled,
                'aria-label': label,
                'data-control': label === 'Run' || label === 'Pause' ? 'playback' : label,
            },
            icon(iconName),
            h('span.kv-btn-label', {}, label)
        )
    }

    private iconButton(iconName: string, title: string, onclick: () => void): HTMLElement {
        return h('button.kv-btn.kv-btn-icon', { type: 'button', title, 'aria-label': title, onclick }, icon(iconName))
    }

    private toggle(iconName: string, label: string, on: boolean, title: string, onclick: () => void): HTMLElement {
        return h(
            `button.kv-btn.kv-btn-toggle${on ? '.kv-btn-active' : ''}`,
            {
                type: 'button',
                title: `${label}: ${title}`,
                'aria-label': label,
                'aria-pressed': String(on),
                'data-control': label,
                onclick,
            },
            icon(iconName),
            h('span.kv-btn-label', {}, label)
        )
    }
}
