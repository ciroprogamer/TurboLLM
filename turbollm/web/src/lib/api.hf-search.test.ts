// Discover's "Text classification" category (ADR-444) is one query parameter on the same search
// route. The daemon ignores any category it does not know, so the only way to get it wrong from
// here is to drop it, or to send one when the user never asked for the category.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hfSearch } from './api'

describe('hfSearch', () => {
  let urls: string[]

  beforeEach(() => {
    urls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
  })

  it('asks for the text-classification category when given it', async () => {
    await hfSearch('nli', 'downloads', 'text-classification')
    expect(urls).toEqual(['/api/v1/hf/search?q=nli&sort=downloads&category=text-classification'])
  })

  it('sends no category for the ordinary engine search', async () => {
    await hfSearch('qwen', 'trending')
    expect(urls).toEqual(['/api/v1/hf/search?q=qwen&sort=trending'])
  })
})
