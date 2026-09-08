import * as vscode from 'vscode'

/**
 * Upstream extensions this fork cannot run beside. Both register the same `keith-vscode.*`
 * commands, language ids and views, and each starts its own language server for the same files.
 */
export const CONFLICTING_EXTENSIONS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'kieler.keith-vscode', name: 'KIELER VS Code' },
]

export function findConflictingExtensions(
    extensions: Pick<typeof vscode.extensions, 'getExtension'> = vscode.extensions
): Array<{ id: string; name: string }> {
    return CONFLICTING_EXTENSIONS.filter((extension) => extensions.getExtension(extension.id) !== undefined)
}

/** Reports installed conflicts and returns true when activation must be abandoned. */
export async function reportConflictingExtensions(
    conflicts = findConflictingExtensions(),
    window: Pick<typeof vscode.window, 'showErrorMessage'> = vscode.window,
    commands: Pick<typeof vscode.commands, 'executeCommand'> = vscode.commands
): Promise<boolean> {
    if (conflicts.length === 0) {
        return false
    }
    const names = conflicts.map((extension) => extension.name).join(', ')
    const show = 'Show conflicting extension'
    const choice = await window.showErrorMessage(
        `SCCharts Lab is incompatible with ${names} and will not activate while it is enabled. Disable or uninstall it, then reload the window.`,
        show
    )
    if (choice === show) {
        await commands.executeCommand('workbench.extensions.search', `@installed ${conflicts[0].id}`)
    }
    return true
}
