import { IActionDispatcher } from 'sprotty'
import { Action, FitToScreenAction, SelectAction, SModelElement } from 'sprotty-protocol'
import { Messenger } from 'vscode-messenger-webview'
import { diagnosticHighlight } from '../../../src/kico/diagnostic-protocol'

/** A preview-only selection: the server may already have replaced these element IDs. */
export const DIAGNOSTIC_SELECT = 'diagnosticSelect'

function traceUri(trace: string): string {
    return trace
        .replace(/\?[^#]*/, '')
        .replace(/^file:\/*/, 'file:///')
        .replace('file:///private/', 'file:///')
}

export function findDiagramElements(model: SModelElement | undefined, groups: string[][]): string[] {
    const elements = new Map<string, string[]>()
    const visit = (element: SModelElement) => {
        const { trace } = element as SModelElement & { trace?: string }
        if (trace) {
            const key = traceUri(trace)
            elements.set(key, [...(elements.get(key) ?? []), element.id])
        }
        element.children?.forEach(visit)
    }
    if (model) visit(model)
    return [
        ...new Set(
            groups.flatMap((group) => {
                for (const uri of group) {
                    const ids = elements.get(traceUri(uri))
                    if (ids) return ids
                }
                return []
            })
        ),
    ]
}

export class DiagnosticHighlighter {
    private model?: SModelElement

    private selected: string[] = []

    private dispatcher?: () => IActionDispatcher

    private groups: string[][] = []

    private revision = 0

    private timeout?: ReturnType<typeof setTimeout>

    constructor(
        messenger: Messenger,
        private readonly status: (message: string) => void = () => undefined
    ) {
        messenger.onNotification(diagnosticHighlight, ({ traceUris }) => {
            this.groups = traceUris
            this.revision++
            clearTimeout(this.timeout)
            this.status(traceUris.length ? 'Locating operations in the SCCharts diagram…' : '')
            if (traceUris.length)
                this.timeout = setTimeout(
                    () => this.status('No source-linked operations are available in this diagram.'),
                    8000
                )
            this.apply()
        })
    }

    private apply(): void {
        const dispatcher = this.dispatcher?.()
        if (!dispatcher) return
        if (!this.groups.length && !this.selected.length) return
        const selected = findDiagramElements(this.model, this.groups)
        if (this.groups.length && !selected.length) return // Keep the request until the source diagram arrives.
        const { revision } = this
        const deselected = this.selected.filter((id) => !selected.includes(id))
        this.selected = selected
        dispatcher
            .dispatch({
                ...SelectAction.create({ selectedElementsIDs: selected, deselectedElementsIDs: deselected }),
                kind: DIAGNOSTIC_SELECT,
            })
            .then(async () => {
                if (revision !== this.revision || !selected.length) return
                await dispatcher.dispatch(
                    FitToScreenAction.create(selected, { padding: 35, maxZoom: 1.5, animate: false })
                )
                if (revision !== this.revision) return
                clearTimeout(this.timeout)
                this.status('Highlighted the involved operations in the SCCharts diagram.')
            })
            .catch(() => {
                if (revision !== this.revision) return
                clearTimeout(this.timeout)
                this.status('The diagram changed before highlighting finished. Try highlighting again.')
            })
    }

    connect(dispatcher: () => IActionDispatcher): void {
        this.dispatcher = dispatcher
        this.model = undefined
        this.selected = []
        this.groups = []
        this.revision++
        clearTimeout(this.timeout)
    }

    accept(action: Action): void {
        if (action.kind === 'setModel' || action.kind === 'updateModel') {
            this.model = (action as Action & { newRoot: SModelElement }).newRoot
            this.selected = []
            this.revision++
            // Queue selection after the diagram server has dispatched this model update.
            // A source switch can replace a matching old model again after selection.
            // Reapply locally to the final model without sending stale IDs to the server.
            if (this.groups.length) {
                Promise.resolve().then(() => this.apply())
            }
        }
    }
}
