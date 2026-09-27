// Test-only: the JSON text the System One playground tests (ADR-439) type into their editors. Nothing
// outside a test imports it.

export const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

/** Text a JSON.parse accepts at any depth, and a recursive printer may not. */
export const arraysNestedDeep = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth)
