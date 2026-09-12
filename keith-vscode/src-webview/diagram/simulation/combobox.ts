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

/* global HTMLElement, HTMLInputElement, KeyboardEvent */

import { h, replaceChildren } from './dom'

/** One completion: what is shown, what is inserted, and a few words about it. */
export interface Suggestion {
    label: string
    detail?: string
    /** Text to insert instead of the label, e.g. `pre(` for the label `pre()`. */
    insert?: string
}

export interface ComboboxOptions {
    placeholder: string
    control: string
    title?: string
    suggestions: () => Suggestion[]
    submit: (text: string) => void
    /**
     * Pick mode: the whole value is one suggestion, Enter takes the highlighted match (the first by
     * default) and submits it. Otherwise the suggestions complete the word at the caret and Enter
     * submits the typed expression; a suggestion is only taken after it was highlighted with the arrows.
     */
    pick?: boolean
}

const WORD = /[A-Za-z_][A-Za-z0-9_.]*$/

/** An input with a filtered suggestion list underneath; keyboard driven, no dependencies. */
export function combobox(options: ComboboxOptions): HTMLElement {
    const input = h('input.kv-debug-entry', {
        type: 'text',
        placeholder: options.placeholder,
        title: options.title,
        spellcheck: 'false',
        autocomplete: 'off',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-label': options.placeholder,
        'data-control': options.control,
    }) as HTMLInputElement
    const list = h('ul.kv-combo-list', { role: 'listbox', hidden: true })
    const root = h('div.kv-combo', {}, input, list)
    let matches: Suggestion[] = []
    let active = -1

    const word = (): string => {
        const head = input.value.slice(0, input.selectionStart ?? input.value.length)
        return options.pick ? input.value : WORD.exec(head)?.[0] ?? ''
    }
    const close = () => {
        matches = []
        active = -1
        replaceChildren(list)
        list.hidden = true
        input.setAttribute('aria-expanded', 'false')
    }
    const render = () => {
        replaceChildren(
            list,
            ...matches.map((suggestion, index) =>
                h(
                    `li.kv-combo-item${index === active ? '.kv-combo-active' : ''}`,
                    {
                        role: 'option',
                        'aria-selected': String(index === active),
                        onmousedown: (event) => {
                            // Before blur, so the input keeps focus.
                            event.preventDefault()
                            take(suggestion)
                        },
                    },
                    h('span.kv-combo-label', {}, suggestion.label),
                    suggestion.detail && h('span.kv-combo-detail', {}, suggestion.detail)
                )
            )
        )
        list.hidden = matches.length === 0
        input.setAttribute('aria-expanded', String(matches.length > 0))
    }
    const refresh = () => {
        const typed = word().toLowerCase()
        const all = options.suggestions()
        // Prefix matches first, then anything containing the text; everything when nothing is typed.
        const starts = all.filter((suggestion) => suggestion.label.toLowerCase().startsWith(typed))
        const contains = all.filter(
            (suggestion) => !starts.includes(suggestion) && suggestion.label.toLowerCase().includes(typed)
        )
        matches = (typed || options.pick ? [...starts, ...contains] : all).slice(0, 8)
        active = options.pick && matches.length ? 0 : -1
        render()
    }
    const take = (suggestion: Suggestion) => {
        const text = suggestion.insert ?? suggestion.label
        if (options.pick) {
            input.value = ''
            close()
            options.submit(text)
            return
        }
        const caret = input.selectionStart ?? input.value.length
        const head = input.value.slice(0, caret).replace(WORD, '')
        input.value = head + text + input.value.slice(caret)
        const position = head.length + text.length
        input.setSelectionRange(position, position)
        close()
    }

    input.addEventListener('input', refresh)
    input.addEventListener('focus', refresh)
    input.addEventListener('blur', close)
    input.addEventListener('keydown', (event: KeyboardEvent) => {
        event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (matches.length === 0) refresh()
            if (matches.length === 0) return
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            active = (active + step + matches.length) % matches.length
            render()
        } else if (event.key === 'Enter') {
            if (active >= 0 && matches[active]) {
                take(matches[active])
                return
            }
            const text = input.value.trim()
            if (text) {
                input.value = ''
                close()
                options.submit(text)
            }
        } else if (event.key === 'Escape') {
            if (!list.hidden) close()
            else input.blur()
        } else if (event.key === 'Tab' && active >= 0 && matches[active] && !options.pick) {
            event.preventDefault()
            take(matches[active])
        }
    })
    return root
}

/** Suggestions for an SCCharts expression over the running simulation's variables. */
export function expressionSuggestions(
    variables: { label: string; role: string; internal: boolean }[],
    showInternal: boolean
): Suggestion[] {
    const roles: Record<string, string> = { input: 'input', output: 'output', local: 'variable' }
    return [
        ...variables
            .filter((variable) => !variable.internal || showInternal)
            .map((variable) => ({ label: variable.label, detail: roles[variable.role] ?? variable.role })),
        { label: 'pre()', insert: 'pre(', detail: "a variable's value in the previous tick" },
        { label: 'true' },
        { label: 'false' },
    ]
}
