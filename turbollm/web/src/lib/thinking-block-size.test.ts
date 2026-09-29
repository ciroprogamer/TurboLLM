// GitHub #52 (b15hop): the thinking block can be dragged to a size, and the size is remembered.
// One size for every block (a reading preference, like the Code transcript's display toggles), kept
// in localStorage and shared live, so dragging one open block resizes the others too.
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_THINKING_BLOCK_HEIGHT, saveThinkingBlockHeight, useThinkingBlockHeight } from './thinking-block-size'

const STORAGE_KEY = 'tllm.thinkingBlock.height'

let store: Map<string, string>

function stubLocalStorage(overrides: Partial<Storage> = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    ...overrides,
  })
}

beforeEach(() => {
  store = new Map()
  stubLocalStorage()
})

describe('thinking block size', () => {
  it('has no size until the user sets one, so the block grows with its text', () => {
    const { result } = renderHook(() => useThinkingBlockHeight())

    expect(result.current).toBeNull()
  })

  it('remembers a saved height', () => {
    act(() => saveThinkingBlockHeight(320))

    expect(store.get(STORAGE_KEY)).toBe('320')
    expect(renderHook(() => useThinkingBlockHeight()).result.current).toBe(320)
  })

  it('reads a height saved in an earlier session', () => {
    store.set(STORAGE_KEY, '412')

    expect(renderHook(() => useThinkingBlockHeight()).result.current).toBe(412)
  })

  it('updates every block that is already showing when the size is changed', () => {
    const first = renderHook(() => useThinkingBlockHeight())
    const second = renderHook(() => useThinkingBlockHeight())

    act(() => saveThinkingBlockHeight(250))

    expect(first.result.current).toBe(250)
    expect(second.result.current).toBe(250)
  })

  it('ignores a stored value that is not a usable height', () => {
    for (const junk of ['abc', '', 'NaN', '-40', '0', String(MIN_THINKING_BLOCK_HEIGHT - 1)]) {
      store.set(STORAGE_KEY, junk)
      expect(renderHook(() => useThinkingBlockHeight()).result.current).toBeNull()
    }
  })

  it('does not save a height that is not usable', () => {
    act(() => saveThinkingBlockHeight(Number.NaN))
    act(() => saveThinkingBlockHeight(MIN_THINKING_BLOCK_HEIGHT - 1))

    expect(store.has(STORAGE_KEY)).toBe(false)
  })

  it('still works, with no remembered size, when the browser refuses storage', () => {
    stubLocalStorage({
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    })

    const { result } = renderHook(() => useThinkingBlockHeight())

    expect(result.current).toBeNull()
    expect(() => act(() => saveThinkingBlockHeight(300))).not.toThrow()
  })
})
