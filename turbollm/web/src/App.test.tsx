// ADR-434 (b), (i)(1): while a Jev model is loaded, Workspace has exactly one mode. The gate is
// a pathless layout route over every /workspace* route, so a bookmark, a hardware Back button
// and an in-app link all land in the same place — and when no text classification model is
// loaded it works in reverse, sending the playground's own URL back to Chat.
//
// Like App.redirects.test.tsx, this mounts the gate over probe routes rather than the whole
// <App/>: what is under test is which path the gate sends each URL to, not the app shell.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeGate } from './App'
import type { ModelEntry, Status } from './lib/types'

const state: { status: Status | undefined; models: ModelEntry[] | undefined } = {
  status: undefined,
  models: undefined,
}

vi.mock('./lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/queries')>()),
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: state.models ? { models: state.models, scanning: false } : undefined }),
}))

const JEV = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
} as NonNullable<Status['jev']>

const CHAT_MODEL = { key: 'gemma-27b', name: 'Gemma 27B', loaded: true } as ModelEntry

function Probe() {
  const loc = useLocation()
  return <div data-testid="landed">{`${loc.pathname} ${JSON.stringify(loc.state)}`}</div>
}

function landOn(path: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<WorkspaceModeGate />}>
          <Route path="/workspace/chat" element={<Probe />} />
          <Route path="/workspace/chat/:convId" element={<Probe />} />
          <Route path="/workspace/code/:sessionId" element={<Probe />} />
          <Route path="/workspace/routines" element={<Probe />} />
          <Route path="/workspace/text-classification" element={<Probe />} />
          {/* Mirrors App.tsx's back-compat line for the playground's old URL, kept in sync by hand. */}
          <Route path="/workspace/jev" element={<Navigate to="/workspace/text-classification" replace />} />
        </Route>
        <Route path="/models" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
  const landed = screen.getByTestId('landed').textContent
  view.unmount()
  return landed
}

beforeEach(() => {
  state.status = undefined
  state.models = undefined
})

describe('WorkspaceModeGate', () => {
  it('sends every Workspace work route to the playground while a Jev model is loaded', () => {
    state.status = { jev: JEV } as Status
    for (const path of ['/workspace/chat/abc', '/workspace/code/x', '/workspace/routines']) {
      expect(landOn(path)).toBe('/workspace/text-classification {"takeoverNotice":true}')
    }
  })

  it('leaves the playground itself alone', () => {
    state.status = { jev: JEV } as Status
    expect(landOn('/workspace/text-classification')).toBe('/workspace/text-classification null')
  })

  it('sends the playground back to Chat once nothing Jev is loaded, without an explanation', () => {
    state.status = { jev: null } as Status
    state.models = []
    expect(landOn('/workspace/text-classification')).toBe('/workspace/chat {"takeoverNotice":false}')
  })

  it('never bounces a deep link on a guess', () => {
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
  })

  it('reads the models list when the status cannot be read', () => {
    state.models = [{ key: 'jev-key', name: 'qwen3.5 4b nli v2', loaded: true, jev: { labels: [] } } as unknown as ModelEntry]
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/text-classification {"takeoverNotice":true}')
  })

  it('has no opinion about routes outside Workspace', () => {
    state.status = { jev: JEV } as Status
    expect(landOn('/models')).toBe('/models null')
  })
})

describe('WorkspaceModeGate with a Laya model loaded', () => {
  const LAYA = { key: 'laya|laya|1455', name: 'laya', checkpoints: ['english'], state: 'running' } as NonNullable<Status['laya']>

  it('keeps the playground open', () => {
    state.status = { jev: null, laya: LAYA } as Status
    expect(landOn('/workspace/text-classification')).toBe('/workspace/text-classification null')
  })

  it('leaves chat, code and routines alone: a Laya model runs beside the chat model', () => {
    state.status = { jev: null, laya: LAYA } as Status
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
  })
})

// ADR-444: the daemon's one text classification field decides, by runtime.
describe('WorkspaceModeGate with the text classification status', () => {
  const ON_VLLM = { key: 'jev-key', name: 'qwen3.5 4b nli v2', runtime: 'vllm', state: 'running', slot: 'primary' }
  const ON_LAYA = { key: 'laya-key', name: 'laya', runtime: 'laya', state: 'running', slot: 'pool' }

  it('hands the Workspace to a model on vLLM', () => {
    state.status = { textClassification: ON_VLLM, jev: null, laya: null } as unknown as Status
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/text-classification {"takeoverNotice":true}')
  })

  it('keeps the playground open beside chat for a model on the Laya engine', () => {
    state.status = { textClassification: ON_LAYA, jev: null, laya: null } as unknown as Status
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
    expect(landOn('/workspace/text-classification')).toBe('/workspace/text-classification null')
  })

  it('sends the playground back to Chat when it reports nothing loaded and the library holds none', () => {
    state.status = { textClassification: null, jev: JEV } as unknown as Status
    state.models = [CHAT_MODEL]
    expect(landOn('/workspace/text-classification')).toBe('/workspace/chat {"takeoverNotice":false}')
  })
})

// ADR-444, amended 2026-09-25: the playground is a Workspace tab, a starting point, so it stays open with nothing
// loaded as long as the library holds a text classification model to load from its list.
describe('WorkspaceModeGate with nothing loaded', () => {
  const NOTHING_LOADED = { textClassification: null, jev: null, laya: null } as unknown as Status
  const LIBRARY_LAYA = { key: 'laya-key', name: 'laya', loaded: false, laya: { checkpoints: ['english'] } } as unknown as ModelEntry

  it('keeps the playground open while the library holds a text classification model', () => {
    state.status = NOTHING_LOADED
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    expect(landOn('/workspace/text-classification')).toBe('/workspace/text-classification null')
  })

  it('waits for the library before sending the playground back to Chat', () => {
    state.status = NOTHING_LOADED
    expect(landOn('/workspace/text-classification')).toBe('/workspace/text-classification null')
  })

  it('leaves chat alone', () => {
    state.status = NOTHING_LOADED
    state.models = [CHAT_MODEL, LIBRARY_LAYA]
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
  })
})

describe('the playground\'s old Jev URL', () => {
  it('lands on the text classification playground, for a bookmark', () => {
    state.status = { jev: JEV } as Status
    expect(landOn('/workspace/jev')).toBe('/workspace/text-classification null')
  })

  it('still ends on Chat when nothing is loaded and the library holds none', () => {
    state.status = { jev: null } as Status
    state.models = [CHAT_MODEL]
    expect(landOn('/workspace/jev')).toBe('/workspace/chat {"takeoverNotice":false}')
  })
})
