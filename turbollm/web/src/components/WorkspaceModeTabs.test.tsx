// ADR-444, amended 2026-09-25: the text classification playground is a Workspace tab beside Chat, Code and Routines —
// a second full-width row of the same control, since the sidebar is too narrow for a fourth segment — not a link
// under the tabs. The founder called that link "a very obvious design red flag".
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeTabs } from './WorkspaceModeTabs'
import type { ModelEntry, Status } from '../lib/types'

const h = vi.hoisted(() => ({ track: vi.fn() }))

const state: { status: Status | undefined; models: ModelEntry[] | undefined; routines: boolean } = {
  status: undefined,
  models: undefined,
  routines: true,
}

vi.mock('../lib/queries', () => ({
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: state.models ? { models: state.models, scanning: false } : undefined }),
  useSettings: () => ({ query: { data: { experimental: { routines: state.routines } } } }),
  useSysInfo: () => ({ data: { os: 'linux/x64' }, isError: false }),
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: (...a: unknown[]) => h.track(...a),
}))

const NOTHING_LOADED = { textClassification: null, jev: null, laya: null } as unknown as Status
const CHAT_MODEL = { key: 'gemma-27b', name: 'Gemma 27B', loaded: true } as ModelEntry
const LIBRARY_LAYA = { key: 'laya-key', name: 'laya', loaded: false, laya: { checkpoints: ['english'] } } as unknown as ModelEntry
const LAYA_LOADED = {
  textClassification: { key: 'laya-key', name: 'laya', runtime: 'laya', state: 'running', slot: 'pool', checkpoints: ['english'] },
  jev: null,
  laya: null,
} as unknown as Status
const JEV_LOADED = {
  textClassification: { key: 'jev-key', name: 'nli', runtime: 'vllm', state: 'running', slot: 'primary', labels: [] },
  jev: null,
  laya: null,
} as unknown as Status

function renderTabs(path = '/workspace/chat', collapsed = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceModeTabs collapsed={collapsed} />
    </MemoryRouter>,
  )
}

function modeGroup(): HTMLElement {
  return screen.getByRole('group', { name: 'Workspace mode' })
}

beforeEach(() => {
  h.track.mockReset()
  state.status = NOTHING_LOADED
  state.models = [CHAT_MODEL]
  state.routines = true
})

describe('WorkspaceModeTabs', () => {
  it('is the unchanged Chat, Code and Routines control for a user with no text classification model', () => {
    renderTabs()
    const group = modeGroup()
    expect(within(group).getByText('Chat').closest('[aria-current="page"]')).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: /Code/ })).toHaveAttribute('href', '/workspace/code')
    expect(within(group).getByRole('link', { name: /Routines/ })).toHaveAttribute('href', '/workspace/routines')
    expect(within(group).queryByText('Text classification')).toBeNull()
  })

  it('leaves Routines out while the experimental flag is off', () => {
    state.routines = false
    renderTabs()
    expect(within(modeGroup()).queryByText('Routines')).toBeNull()
  })

  it('adds Text classification as a second row of the same control when the library holds such a model', () => {
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs()
    const group = modeGroup()
    const textClassification = within(group).getByRole('link', { name: /Text classification/ })
    expect(textClassification).toHaveAttribute('href', '/workspace/text-classification')
    const chat = within(group).getByText('Chat').closest('[aria-current="page"]')
    expect(textClassification.parentElement).not.toBe(chat?.parentElement)
  })

  it('shows the tab while one is loaded, before the library has been read', () => {
    state.status = LAYA_LOADED
    state.models = undefined
    renderTabs()
    expect(within(modeGroup()).getByRole('link', { name: /Text classification/ })).toBeInTheDocument()
  })

  it('marks Text classification as the current page on the playground', () => {
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs('/workspace/text-classification')
    const group = modeGroup()
    expect(within(group).getByText('Text classification').closest('[aria-current="page"]')).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: /Chat/ })).toBeInTheDocument()
  })

  it('offers only Text classification while a Jev model has taken the Workspace over', () => {
    state.status = JEV_LOADED
    state.models = [CHAT_MODEL]
    renderTabs('/workspace/text-classification')
    const group = modeGroup()
    expect(within(group).getByText('Text classification').closest('[aria-current="page"]')).toBeInTheDocument()
    expect(within(group).queryByText('Chat')).toBeNull()
    expect(within(group).queryByText('Code')).toBeNull()
    expect(within(group).queryByText('Routines')).toBeNull()
  })
})

describe('WorkspaceModeTabs in the collapsed rail', () => {
  it('adds a Text classification icon after the others when a model exists', () => {
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs('/workspace/chat', true)
    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('title'))).toEqual(['Chat', 'Code', 'Routines', 'Text classification'])
    expect(links[3]).toHaveAttribute('href', '/workspace/text-classification')
  })

  it('has no Text classification icon when none exists', () => {
    renderTabs('/workspace/chat', true)
    expect(screen.queryByTitle('Text classification')).toBeNull()
  })

  it('marks the current mode', () => {
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs('/workspace/text-classification', true)
    expect(screen.getByTitle('Text classification')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTitle('Chat')).not.toHaveAttribute('aria-current')
  })
})

describe('WorkspaceModeTabs telemetry', () => {
  it('records opening the playground for a loaded Laya model, under its existing event name', async () => {
    state.status = LAYA_LOADED
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs()
    await userEvent.click(screen.getByRole('link', { name: /Text classification/ }))
    expect(h.track).toHaveBeenCalledWith('workspace', 'open_laya_playground')
  })

  it('records nothing when no Laya model is loaded', async () => {
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    renderTabs()
    await userEvent.click(screen.getByRole('link', { name: /Text classification/ }))
    expect(h.track).not.toHaveBeenCalled()
  })
})
