/**
 * Formatting of the per-processor progress and timings the server reports while and after compiling.
 * Pure functions, so they are unit-tested without a VS Code host.
 */

export interface ProcessorInfo {
    id: string
    name: string
    /** Index of the processor in the system's execution order, starting at 0. */
    index: number
}

export interface CompileProgress {
    uri: string
    processor: ProcessorInfo
    /** Number of processors that finished before this one. */
    index: number
    /** Number of processors the system runs. */
    maxIndex: number
    elapsedMs: number
}

export interface ProcessorTiming {
    id: string
    name: string
    status: 'ok' | 'warning' | 'error' | 'skipped' | 'cancelled'
    durationMs?: number
    startedAtMs?: number
    /** Flat index of the snapshot showing this processor's result, or -1. */
    snapshotIndex: number
}

export function formatDuration(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
    if (ms < 1000) return `${Math.round(ms)} ms`
    if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`
    return `${Math.round(ms / 1000)} s`
}

/** Status bar text while a processor runs: the spinner, its name and its place in the pipeline. */
export function progressText(progress: Pick<CompileProgress, 'processor' | 'index' | 'maxIndex'>): string {
    const position =
        progress.maxIndex > 0 ? ` (${Math.min(progress.index + 1, progress.maxIndex)}/${progress.maxIndex})` : ''
    return `$(spinner) ${progress.processor.name}${position}`
}

export function progressTooltip(progress: CompileProgress): string {
    const elapsed = formatDuration(progress.elapsedMs)
    return `Compiling: ${progress.processor.name}${elapsed ? ` · ${elapsed} elapsed` : ''}`
}

/** The processor that took longest; ties go to the earlier one. */
export function slowestProcessor(processors: ProcessorTiming[] | undefined): ProcessorTiming | undefined {
    let slowest: ProcessorTiming | undefined
    processors?.forEach((processor) => {
        if (processor.durationMs === undefined) return
        if (!slowest || processor.durationMs > (slowest.durationMs ?? -1)) slowest = processor
    })
    return slowest
}

export interface FinishedSummary {
    text: string
    tooltip: string
}

/**
 * Status bar text and tooltip once a compilation ended. `totalMs` is the server's wall time when it
 * reported one, else the client's own measurement.
 */
export function finishedSummary(options: {
    success: boolean
    cancelled: boolean
    totalMs: number
    processors?: ProcessorTiming[]
    processorCount?: number
}): FinishedSummary {
    const total = formatDuration(options.totalMs)
    const slowest = slowestProcessor(options.processors)
    const ran = options.processors?.filter((p) => p.durationMs !== undefined).length
    const detail = [
        ran !== undefined && options.processorCount ? `${ran}/${options.processorCount} processors` : undefined,
        slowest ? `slowest: ${slowest.name} ${formatDuration(slowest.durationMs)}` : undefined,
    ]
        .filter(Boolean)
        .join(', ')
    if (options.cancelled) {
        return {
            text: `$(times) ${total}`.trim(),
            tooltip: `Compilation stopped after ${total}${detail ? ` (${detail})` : ''}`,
        }
    }
    const verb = options.success ? 'Compiled' : 'Compilation failed'
    return {
        text: `${options.success ? '$(check)' : '$(times)'} ${total}`.trim(),
        tooltip: `${verb} in ${total}${detail ? ` (${detail})` : ''}`,
    }
}

/** Duration column for the stage picker; the slowest processor is marked. */
export function stageTiming(
    stage: { processorId?: string; durationMs?: number },
    slowest: ProcessorTiming | undefined
): string {
    if (stage.durationMs === undefined) return ''
    const marker =
        slowest && stage.processorId === slowest.id && stage.durationMs === slowest.durationMs ? ' $(flame)' : ''
    return `${formatDuration(stage.durationMs)}${marker}`
}
