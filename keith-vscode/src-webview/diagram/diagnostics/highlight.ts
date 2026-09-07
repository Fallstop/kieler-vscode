import { IActionDispatcher } from 'sprotty'
import { Action, FitToScreenAction, SelectAction, SModelElement } from 'sprotty-protocol'
import { Messenger } from 'vscode-messenger-webview'
import { diagnosticHighlight } from '../../../src/kico/diagnostic-protocol'

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

    constructor(messenger: Messenger) {
        messenger.onNotification(diagnosticHighlight, ({ traceUris }) => {
            const selected = findDiagramElements(this.model, traceUris)
            const dispatcher = this.dispatcher?.()
            if (!dispatcher) return
            const deselected = this.selected.filter((id) => !selected.includes(id))
            this.selected = selected
            dispatcher
                .dispatch(SelectAction.create({ selectedElementsIDs: selected, deselectedElementsIDs: deselected }))
                .then(() => {
                    if (selected.length)
                        return dispatcher.dispatch(
                            FitToScreenAction.create(selected, { padding: 35, maxZoom: 1.5, animate: false })
                        )
                    return undefined
                })
                .catch(() => {
                    /* Model replacement may invalidate a queued selection. */
                })
        })
    }

    connect(dispatcher: () => IActionDispatcher): void {
        this.dispatcher = dispatcher
        this.model = undefined
        this.selected = []
    }

    accept(action: Action): void {
        if (action.kind === 'setModel' || action.kind === 'updateModel') {
            this.model = (action as Action & { newRoot: SModelElement }).newRoot
            this.selected = []
        }
    }
}
