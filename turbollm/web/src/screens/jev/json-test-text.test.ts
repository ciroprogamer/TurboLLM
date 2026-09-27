// The nesting fixture the boundary tests of the playground stand on: a fixture one level off would
// leave every "past the limit" test testing a value that is not.
import { describe, expect, it } from 'vitest'
import { jsonDepth, MAX_NESTING_DEPTH } from '../../lib/systemone-types'
import { arraysNestedDeep, pretty } from './json-test-text'

describe('arraysNestedDeep', () => {
  it('is text that parses to arrays nested exactly the depth asked for', () => {
    expect(arraysNestedDeep(3)).toBe('[[[]]]')
    const limit = MAX_NESTING_DEPTH + 1
    expect(jsonDepth(JSON.parse(arraysNestedDeep(limit)), limit)).toBe(limit)
  })
})

describe('pretty', () => {
  it('prints JSON with a two-space indent', () => {
    expect(pretty({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
  })
})
