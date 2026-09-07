interface SimulationValue {
    value: unknown
    type?: string
}

/** Null strings can be omitted from the values while remaining declared in #interface. */
export function readDataPool(dataPool: Record<string, unknown>): Map<string, SimulationValue> {
    const values = new Map<string, SimulationValue>(Object.entries(dataPool).map(([id, value]) => [id, { value }]))
    const declarations = dataPool['#interface']
    if (declarations && typeof declarations === 'object' && !Array.isArray(declarations)) {
        Object.entries(declarations).forEach(([id, declaration]) => {
            if (declaration && typeof declaration === 'object' && typeof declaration.type === 'string') {
                values.set(id, { value: values.get(id)?.value, type: declaration.type })
            }
        })
    }
    return values
}

/** Give unset strings an editable value without sending a default to the running model. */
export function inputValue(value: unknown, type?: string): unknown {
    if (type !== 'string') return value
    if (Array.isArray(value)) return value.map((entry) => inputValue(entry, type))
    return value ?? ''
}
