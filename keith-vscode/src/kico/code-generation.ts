/* eslint-disable no-await-in-loop -- KIELER has one active compilation; targets and their previews must be sequenced. */
import * as vscode from 'vscode'
import { CompilationDataProvider } from './compilation-data-provider'
import { CodeTarget, generateModel } from './generate-model'
import { GeneratedCodeDocuments } from './generated-code-documents'

export const GENERATE_CODE = 'keith-vscode.generate-code'

export function registerCodeGeneration(context: vscode.ExtensionContext, compiler: CompilationDataProvider): void {
    const documents = new GeneratedCodeDocuments()
    let running = false
    context.subscriptions.push(
        documents,
        vscode.commands.registerCommand(GENERATE_CODE, async (uri?: vscode.Uri) => {
            if (running || compiler.compiling) {
                vscode.window.showInformationMessage('A compilation is already in progress.')
                return
            }
            running = true
            try {
                const source = uri ?? vscode.window.activeTextEditor?.document.uri
                if (!source || source.scheme !== 'file' || !source.path.endsWith('.sctx')) {
                    throw new Error('Open an SCCharts (.sctx) model to generate code.')
                }
                const document = await vscode.workspace.openTextDocument(source)
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: 'C', targets: ['c'] as CodeTarget[], description: 'C source and headers' },
                        { label: 'Java', targets: ['java'] as CodeTarget[], description: 'Java source' },
                        {
                            label: 'C and Java',
                            targets: ['c', 'java'] as CodeTarget[],
                            description: 'Generate each target separately',
                        },
                    ],
                    { title: 'Generate Code', placeHolder: 'Choose a target language' }
                )
                if (!choice) return
                // KIELER compiles files from disk; saving must not trigger a competing auto-compilation.
                compiler.generatingCode = true
                if (document.isDirty && !(await document.save()))
                    throw new Error('Save the model before generating code.')
                const sourceVersion = document.version
                const failures: string[] = []
                let count = 0
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Generating code', cancellable: true },
                    async (progress, token) => {
                        for (const target of choice.targets) {
                            if (token.isCancellationRequested) break
                            if (document.version !== sourceVersion) {
                                failures.push('The model changed during generation. Generate code again.')
                                break
                            }
                            progress.report({ message: target === 'c' ? 'C' : 'Java' })
                            try {
                                const files = await generateModel(compiler, document, target, token)
                                if (token.isCancellationRequested || !files.length) break
                                await documents.open(source, target, files)
                                count += files.length
                            } catch (error) {
                                failures.push(
                                    `${target === 'c' ? 'C' : 'Java'}: ${
                                        error instanceof Error ? error.message : String(error)
                                    }`
                                )
                            }
                        }
                    }
                )
                if (failures.length) {
                    vscode.window
                        .showErrorMessage(
                            `${count ? `Opened ${count} generated files. ` : ''}${failures.join('\n')}`,
                            'Problems'
                        )
                        .then((action) => {
                            if (action === 'Problems') vscode.commands.executeCommand('workbench.actions.view.problems')
                        })
                } else if (count) {
                    vscode.window.showInformationMessage(
                        `Opened ${count} generated files. Use Save As or Save All Generated Files to keep them.`
                    )
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Could not generate code: ${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                compiler.generatingCode = false
                running = false
            }
        })
    )
}
