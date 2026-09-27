// Discover's "Text classification" category (ADR-444): one toggle beside the sort that swaps the
// engine's search for the Laya and Jev models TurboLLM can run, whichever engine is active.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoverTab } from './DiscoverTab'
import type { HfSearchCategory, HfSearchItem } from '../../lib/types'

const CATEGORY_DESCRIPTION = 'Laya and Jev models TurboLLM can run, whichever engine is active'

const state: {
  sys: { os: string; ramMB: number; gpus: { name: string; vramMb: number }[] }
  engineRows: HfSearchItem[]
  categoryRows: HfSearchItem[]
  searchedCategories: (HfSearchCategory | undefined)[]
} = { sys: desktop(), engineRows: [], categoryRows: [], searchedCategories: [] }

vi.mock('../../lib/queries', () => ({
  useHfSearch: (_q: string, _sort: string, category?: HfSearchCategory) => {
    state.searchedCategories.push(category)
    const results = category ? state.categoryRows : state.engineRows
    return { data: { results }, isLoading: false, isError: false, error: null, refetch: vi.fn() }
  },
  useSysInfo: () => ({ data: state.sys }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))
vi.mock('./DownloadsPanel', () => ({ DownloadsPanel: () => null }))
vi.mock('./ImportUrlDialog', () => ({ ImportUrlDialog: () => null }))
vi.mock('./HfRepoDialog', () => ({ HfRepoContent: ({ repo }: { repo: string }) => <p>Details of {repo}</p> }))

function desktop() {
  return { os: 'windows', ramMB: 32768, gpus: [{ name: 'RTX', vramMb: 16384 }] }
}

function phone() {
  return { os: 'android/arm64', ramMB: 7655, gpus: [] }
}

function row(repo: string, textClassification?: HfSearchItem['textClassification']): HfSearchItem {
  return { repo, downloads: 1200, likes: 30, updatedAt: '', gated: false, tags: [], localCount: 0, textClassification }
}

function categoryToggle() {
  return screen.getByRole('button', { name: 'Text classification' })
}

function resultRow(repo: string) {
  return screen.getByRole('button', { name: new RegExp(repo) })
}

function lastSearchedCategory() {
  return state.searchedCategories.at(-1)
}

beforeEach(() => {
  state.sys = desktop()
  state.engineRows = [row('unsloth/Qwen3-8B-GGUF')]
  state.categoryRows = [row('convaiinnovations/laya', { runtime: 'laya' }), row('AlexWortega/openjev', { runtime: 'vllm' })]
  state.searchedCategories = []
})

describe('DiscoverTab — Text classification category', () => {
  it('is off by default and leaves the engine search as it was', () => {
    render(<DiscoverTab />)
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'false')
    expect(lastSearchedCategory()).toBeUndefined()
    expect(resultRow('unsloth/Qwen3-8B-GGUF')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search models by name or author…')).toBeInTheDocument()
    expect(screen.queryByText('Laya engine')).not.toBeInTheDocument()
  })

  it('lists the category once switched on, naming the engine each row loads on', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(lastSearchedCategory()).toBe('text-classification')
    expect(screen.queryByRole('button', { name: /Qwen3-8B/ })).not.toBeInTheDocument()
    expect(within(resultRow('convaiinnovations/laya')).getByText('Laya engine')).toBeInTheDocument()
    expect(within(resultRow('AlexWortega/openjev')).getByText('vLLM')).toBeInTheDocument()
  })

  it('switches from the keyboard', async () => {
    const user = userEvent.setup()
    render(<DiscoverTab />)
    categoryToggle().focus()
    await user.keyboard('{Enter}')
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard(' ')
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('returns to the unchanged engine search when switched off', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    await userEvent.click(categoryToggle())
    expect(lastSearchedCategory()).toBeUndefined()
    expect(resultRow('unsloth/Qwen3-8B-GGUF')).toBeInTheDocument()
    expect(screen.queryByText('vLLM')).not.toBeInTheDocument()
  })

  it('says what the category is while it is on', async () => {
    state.categoryRows = []
    render(<DiscoverTab />)
    expect(categoryToggle()).toHaveAttribute('title', CATEGORY_DESCRIPTION)
    await userEvent.click(categoryToggle())
    expect(screen.getByPlaceholderText('Search Laya and Jev models…')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(CATEGORY_DESCRIPTION))).toBeInTheDocument()
  })

  it('keeps category rows when "Fits my hardware" is on, though their names carry no size', async () => {
    state.sys = phone()
    render(<DiscoverTab />)
    expect(screen.getByRole('checkbox', { name: /Fits my hardware/ })).toBeChecked()
    await userEvent.click(categoryToggle())
    expect(resultRow('convaiinnovations/laya')).toBeInTheDocument()
    expect(resultRow('AlexWortega/openjev')).toBeInTheDocument()
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument()
  })

  it('does not pin the Android chat picks above the category', async () => {
    state.sys = phone()
    render(<DiscoverTab />)
    expect(screen.getByText('Good picks for this device')).toBeInTheDocument()
    await userEvent.click(categoryToggle())
    expect(screen.queryByText('Good picks for this device')).not.toBeInTheDocument()
  })

  it('opens a category row in the repo details, as any other row', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    await userEvent.click(resultRow('convaiinnovations/laya'))
    expect(screen.getByText('Details of convaiinnovations/laya')).toBeInTheDocument()
  })
})

describe('DiscoverTab — an empty list', () => {
  it('says the engine search found nothing', () => {
    state.engineRows = []
    render(<DiscoverTab />)
    expect(screen.getByText('No models found.')).toBeInTheDocument()
  })

  it('names the query that found nothing', async () => {
    state.engineRows = []
    render(<DiscoverTab />)
    await userEvent.type(screen.getByPlaceholderText('Search models by name or author…'), 'nothing-here')
    expect(await screen.findByText('No models found for “nothing-here”.')).toBeInTheDocument()
  })

  it('says the fit filter hid every result, rather than that there were none', () => {
    state.sys = phone()
    state.engineRows = [row('unsloth/Qwen3.6-35B-A3B-GGUF')]
    render(<DiscoverTab />)
    expect(screen.getByText(/None of the 1 results fit this machine's memory/)).toBeInTheDocument()
  })
})
