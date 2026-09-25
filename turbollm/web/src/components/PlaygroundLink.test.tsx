// A Laya model never takes the Workspace over (ADR-443), so the playground needs a way in that is always there
// while one is loaded — the "ready" toast is gone once dismissed. Founder-reported, 2026-09-25: "where is playground".
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaygroundLink } from './PlaygroundLink'

const state: { status: unknown } = { status: undefined }

vi.mock('../lib/queries', () => ({
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: { models: [] } }),
}))

function renderLink(collapsed = false) {
  return render(<MemoryRouter><PlaygroundLink collapsed={collapsed} /></MemoryRouter>)
}

const LAYA = { key: 'laya-1', name: 'laya', checkpoints: ['english'], state: 'running' }

beforeEach(() => {
  state.status = undefined
})

describe('PlaygroundLink', () => {
  it('opens the playground while a Laya model is loaded, naming it', () => {
    state.status = { jev: null, laya: LAYA }
    renderLink()
    const link = screen.getByRole('link', { name: /laya · Open playground/ })
    expect(link).toHaveAttribute('href', '/workspace/text-classification')
  })

  it('is there while the Laya model is still loading, too', () => {
    state.status = { jev: null, laya: { ...LAYA, state: 'starting' } }
    renderLink()
    expect(screen.getByRole('link', { name: /Open playground/ })).toBeInTheDocument()
  })

  it('is an icon with a title in the collapsed rail', () => {
    state.status = { jev: null, laya: LAYA }
    renderLink(true)
    expect(screen.getByRole('link', { name: 'Open the text classification playground' })).toHaveAttribute('href', '/workspace/text-classification')
  })

  it('is nothing when no Laya model is loaded', () => {
    state.status = { jev: null, laya: null }
    const { container } = renderLink()
    expect(container).toBeEmptyDOMElement()
  })
})

// ADR-444: the daemon names the text classification model and its runtime in one field.
describe('PlaygroundLink with the text classification status', () => {
  it('opens the playground for a model on the Laya engine, naming it', () => {
    state.status = { textClassification: { ...LAYA, runtime: 'laya', slot: 'pool' }, jev: null, laya: null }
    renderLink()
    expect(screen.getByRole('link', { name: /laya · Open playground/ })).toHaveAttribute('href', '/workspace/text-classification')
  })

  it('is nothing for a model on vLLM: the playground is the whole Workspace then', () => {
    state.status = {
      textClassification: { key: 'jev-1', name: 'nli', runtime: 'vllm', state: 'running', slot: 'primary', labels: [] },
      jev: null,
      laya: LAYA,
    }
    const { container } = renderLink()
    expect(container).toBeEmptyDOMElement()
  })

  it('is nothing when it reports nothing loaded, whatever the Laya field says', () => {
    state.status = { textClassification: null, jev: null, laya: LAYA }
    const { container } = renderLink()
    expect(container).toBeEmptyDOMElement()
  })
})
