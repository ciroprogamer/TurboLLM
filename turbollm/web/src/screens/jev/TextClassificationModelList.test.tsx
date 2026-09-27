// The playground's own left column lists the library's text classification models, each with its runtime and a Load
// or Eject button (ADR-444, amended 2026-09-25), so the playground is a starting point and not only a destination.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TextClassificationModelList } from './TextClassificationModelList'
import type { LoadedJev, ModelEntry } from '../../lib/types'

function model(over: Partial<ModelEntry> & { key: string; name: string }): ModelEntry {
  return {
    incomplete: false,
    parseError: null,
    embedding: false,
    compatibleWithActiveEngine: true,
    loaded: false,
    ...over,
  } as ModelEntry
}

const CHAT = model({ key: 'gemma-27b', name: 'Gemma 27B', loaded: true })
const JEV = model({
  key: 'jev-key',
  name: 'Qwen NLI',
  jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: '', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
})
const LAYA = model({ key: 'laya-key', name: 'laya', laya: { checkpoints: ['english'] } })

const LAYA_LOADED: LoadedJev = { key: 'laya-key', name: 'laya', labels: [], checkpoints: ['english'], state: 'running', slot: 'pool' }

function renderList(models: ModelEntry[], { current = null, pendingKey }: { current?: LoadedJev | null; pendingKey?: string } = {}) {
  const onLoad = vi.fn()
  const onEject = vi.fn()
  render(<TextClassificationModelList models={models} current={current} pendingKey={pendingKey} onLoad={onLoad} onEject={onEject} />)
  return { onLoad, onEject }
}

function list(): HTMLElement {
  return screen.getByRole('region', { name: 'Text classification models' })
}

describe('TextClassificationModelList', () => {
  it('lists only the text classification models, each with its runtime', () => {
    renderList([CHAT, JEV, LAYA])
    expect(within(list()).queryByText('Gemma 27B')).toBeNull()
    expect(within(list()).getByText('Qwen NLI')).toBeInTheDocument()
    expect(within(list()).getByText('vLLM')).toBeInTheDocument()
    expect(within(list()).getByText('laya')).toBeInTheDocument()
    expect(within(list()).getByText('Laya engine')).toBeInTheDocument()
  })

  it('loads a model that is not loaded', async () => {
    const { onLoad } = renderList([JEV, LAYA])
    await userEvent.click(screen.getByRole('button', { name: 'Load Qwen NLI' }))
    expect(onLoad).toHaveBeenCalledWith(JEV)
  })

  it('ejects the model the playground is running', async () => {
    const { onEject } = renderList([JEV, LAYA], { current: LAYA_LOADED })
    expect(screen.queryByRole('button', { name: 'Load laya' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Eject laya' }))
    expect(onEject).toHaveBeenCalledWith(LAYA)
  })

  it('ejects a model the library reports loaded, even when the playground shows another', async () => {
    const { onEject } = renderList([JEV, { ...LAYA, loaded: true }], { current: { ...LAYA_LOADED, key: 'jev-key', checkpoints: undefined } })
    await userEvent.click(screen.getByRole('button', { name: 'Eject laya' }))
    expect(onEject).toHaveBeenCalledWith({ ...LAYA, loaded: true })
  })

  // A disabled button shows no tooltip (pointer-events: none), so the reason is on the row itself.
  it('offers no load that would be refused, and says why', () => {
    renderList([{ ...JEV, compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' }])
    expect(screen.getByRole('button', { name: 'Load Qwen NLI' })).toBeDisabled()
    expect(within(list()).getByText('Needs vLLM (Linux or WSL2)')).toBeInTheDocument()
  })

  it('shows the load in flight', () => {
    renderList([JEV, LAYA], { pendingKey: 'laya-key' })
    const loading = screen.getByRole('button', { name: 'Load laya' })
    expect(loading).toBeDisabled()
    expect(loading).toHaveTextContent('Loading…')
  })
})
