/* global document, HTMLElement, window */
import { HOST_EXTENSION } from 'vscode-messenger-common'
import { Messenger } from 'vscode-messenger-webview'
import {
    BuildIssue,
    BuildReport,
    DiagnosticCommand,
    diagnosticCommand,
    diagnosticState,
} from '../../../src/kico/diagnostic-protocol'
import { h, replaceChildren } from '../simulation/dom'

export class DiagnosticView {
    readonly el = h('section.kd-panel', { hidden: true, 'aria-label': 'Compiler diagnostics' })

    private key = ''

    private readonly highlightStatus = h('p.kd-muted', { role: 'status', hidden: true })

    showHighlightStatus(message: string): void {
        this.highlightStatus.textContent = message
        this.highlightStatus.hidden = !message
    }

    constructor(private readonly messenger: Messenger) {
        const toolbar = document.querySelector('.kv-toolbar')
        toolbar?.after(this.el)
        messenger.onNotification(diagnosticState, ({ report }) => this.render(report))
    }

    connect(): void {
        this.send({ kind: 'request' })
    }

    private send(command: DiagnosticCommand): void {
        this.messenger.sendNotification(diagnosticCommand, HOST_EXTENSION, command)
    }

    render(report?: BuildReport): void {
        const key = JSON.stringify(report)
        if (key === this.key) return
        this.key = key
        this.showHighlightStatus('')
        this.el.hidden = !report || (report.status === 'succeeded' && report.issues.length === 0)
        if (!report || this.el.hidden) {
            replaceChildren(this.el)
            return
        }
        const errors = report.issues.filter((issue) => issue.severity === 'error')
        const warnings = report.issues.filter((issue) => issue.severity === 'warning')
        const stale = report.status === 'stale'
        const heading = stale
            ? 'Source changed. Compile again to refresh diagnostics.'
            : report.status === 'compiling'
              ? 'Compiling model…'
              : report.status === 'cancelled'
                ? 'Compilation cancelled'
                : errors.length
                  ? `${errors.length === 1 ? 'Compilation failed' : `${errors.length} compilation issues`} · ${
                        errors[0].stage
                    }`
                  : `Compiled with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
        this.el.classList.toggle('kd-stale', stale)
        const title = h(
            'div.kd-heading',
            {},
            h('strong', { role: errors.length && !stale ? 'alert' : 'status' }, heading),
            this.button('Problems', () => this.send({ kind: 'problems', build: report.id }))
        )
        const warningList =
            warnings.length > 0 &&
            h(
                'details.kd-warnings',
                {},
                h('summary', {}, `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`),
                ...warnings.map((issue) => this.issue(report, issue))
            )
        replaceChildren(
            this.el,
            title,
            ...errors.map((issue) => this.issue(report, issue)),
            this.highlightStatus,
            warningList
        )
        window.dispatchEvent(new Event('resize'))
    }

    private issue(report: BuildReport, issue: BuildIssue): HTMLElement {
        const usable = report.status !== 'stale' && report.status !== 'compiling'
        const send = (kind: 'details' | 'stage' | 'highlight') => this.send({ kind, build: report.id, issue: issue.id })
        const locations = issue.locations.filter((location) => location.uri === report.uri)
        const trace =
            issue.cycle.length > 0 &&
            h(
                'details.kd-explanation',
                {},
                h('summary', {}, 'Explain this conflict'),
                h('p.kd-muted', {}, 'These operations require a circular order within one tick:'),
                h(
                    'ol.kd-cycle',
                    {},
                    ...issue.cycle.map((edge) =>
                        h(
                            'li',
                            {},
                            h(
                                'div.kd-order',
                                {},
                                h('code', {}, edge.fromLabel ?? edge.from),
                                h('span.kd-before', {}, 'must run before'),
                                h('code', {}, edge.toLabel ?? edge.to)
                            ),
                            h('p.kd-muted', {}, edge.reason)
                        )
                    )
                ),
                h('p.kd-loop', {}, '↳ The last dependency returns to the first operation.'),
                issue.hint && h('p.kd-hint', {}, issue.hint)
            )
        const sources = h(
            'div.kd-sources',
            {},
            ...issue.locations.map((location, index) =>
                this.button(
                    location.uri === report.uri ? location.label : `Generated C: ${location.label}`,
                    () => this.send({ kind: 'source', build: report.id, issue: issue.id, location: index }),
                    !usable
                )
            )
        )
        return h(
            'article.kd-issue',
            {},
            h('p.kd-message', {}, issue.message),
            sources,
            trace,
            !trace && issue.hint && h('p.kd-hint', {}, issue.hint),
            h(
                'div.kd-actions',
                {},
                locations.some((location) => location.traceUris?.length) &&
                    this.button('Highlight in diagram', () => send('highlight'), !usable),
                this.button(
                    issue.code === 'scheduling-cycle' ? 'View scheduler graph' : 'View compiler stage',
                    () => send('stage'),
                    !usable
                ),
                this.button('Technical details', () => send('details'))
            )
        )
    }

    private button(label: string, onclick: () => void, disabled = false): HTMLElement {
        return h('button.kd-button', { type: 'button', onclick, disabled }, label)
    }
}
