// useHfSearch and Discover's "Text classification" category (ADR-444). The category is a different
// list from the engine search, so it must be its own cache entry: a key without it would serve the
// engine's rows under the category's name.
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HfSearchCategory } from './api'
import { useHfSearch } from './queries'

const ROWS = { results: [{ repo: 'unsloth/Qwen3-8B-GGUF' }] }

let urls: string[]

function answerEverySearch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(ROWS), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

function withQueryClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function renderSearch(category?: HfSearchCategory) {
  return renderHook(({ c }) => useHfSearch('', 'trending', c), {
    wrapper: withQueryClient(),
    initialProps: { c: category },
  })
}

beforeEach(() => {
  urls = []
  answerEverySearch()
})

describe('useHfSearch', () => {
  it('fetches the text-classification category when asked for it', async () => {
    renderSearch('text-classification')
    await waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toBe('/api/v1/hf/search?q=&sort=trending&category=text-classification')
  })

  it('fetches the category afresh when it is switched on over the engine search', async () => {
    const { result, rerender } = renderSearch()
    await waitFor(() => expect(result.current.data).toEqual(ROWS))
    rerender({ c: 'text-classification' })
    await waitFor(() => expect(urls).toHaveLength(2))
    expect(urls[1]).toContain('&category=text-classification')
  })

  // The category merges several Hugging Face queries and is slow. Keeping the previous rows on
  // screen while it loads is right for a new sort or query, but here they are the engine's rows,
  // shown under a "Text classification" chip that says they are not.
  it('does not show the engine rows as the category while the category loads', async () => {
    const { result, rerender } = renderSearch()
    await waitFor(() => expect(result.current.data).toEqual(ROWS))
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    rerender({ c: 'text-classification' })
    await waitFor(() => expect(result.current.isFetching).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('keeps the previous rows while a new query loads within the same list', async () => {
    const { result, rerender } = renderHook(({ q }) => useHfSearch(q, 'trending', 'text-classification'), {
      wrapper: withQueryClient(),
      initialProps: { q: '' },
    })
    await waitFor(() => expect(result.current.data).toEqual(ROWS))
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    rerender({ q: 'nli' })
    await waitFor(() => expect(result.current.isFetching).toBe(true))
    expect(result.current.data).toEqual(ROWS)
  })
})
