// ADR-434 (f): the Chat model picker must never offer a Jev model — it labels text and cannot
// chat, and a loaded one would turn this whole screen into the playground. Renders the REAL screen
// (its own model-list logic) with the data hooks and heavy children stubbed at their boundary —
// the same "mock at the API boundary, keep the screen's own logic real" discipline as
// CodeSessionScreen.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../lib/types'

// jsdom's environment doesn't wire up a working localStorage (the thinking-budget and reasoning-
// effort readers touch it on first render) — same gap CodeSessionScreen.test.tsx works around.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

let mockLibrary: Array<Partial<ModelEntry>> = []
let mockConversation: unknown = undefined

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: mockLibrary } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useModelDetail: () => ({ data: undefined }),
    useEngines: () => ({ data: undefined }),
    useSettings: () => ({ query: { data: undefined } }),
    useSysInfo: () => ({ data: undefined }),
    useChatAgents: () => ({ data: [] }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})

vi.mock('../lib/chat-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-queries')>()
  return {
    ...actual,
    useConversation: () => ({ data: mockConversation }),
    useConversationMutations: () => {
      const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
      return {
        create: idle(), update: idle(), compact: idle(), deleteMsg: idle(), editMsg: idle(),
        regenerate: idle(), stop: idle(), undoCompaction: idle(),
      }
    },
  }
})

vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return {
    ...actual,
    useLinks: () => ({ data: [] }),
    useRemoteModels: () => ({ data: [] }),
    useLinkStatus: () => ({ data: undefined }),
  }
})

vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})

vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

// pdfjs-dist reads DOMMatrix at import time, which jsdom lacks; no PDF is attached in this test.
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))

vi.mock('./chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./chat/ConversationSettingsDialog', () => ({ ConversationSettingsDialog: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

let modelsOfferedByPicker: Array<Partial<ModelEntry>> | null = null
vi.mock('../components/ModelLoadMenu', () => ({
  ModelLoadMenu: (props: { models: Array<Partial<ModelEntry>> }) => {
    modelsOfferedByPicker = props.models
    return null
  },
}))

async function renderScreen() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ChatScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

// GitHub #52 (b15hop): find text inside a long chat. The find bar itself is covered in
// chat/ChatFindBar.test.tsx; these check what only the screen owns — when Ctrl/Cmd+F is taken from
// the browser, the header button, and that the bar searches the messages the screen really renders.
function chatMessage(seq: number, role: 'user' | 'assistant', content: string) {
  return {
    id: `m${seq}`, convId: 'c1', seq, role, content, reasoning: '', attachments: [], textAttachments: [],
    toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false,
  }
}

function openConversation() {
  return {
    id: 'c1', title: 'Cats', systemPrompt: '', modelKey: '', sampling: {}, expertMode: false, preserveThinking: true,
    messages: [chatMessage(1, 'user', 'Tell me about the cat'), chatMessage(2, 'assistant', 'A cat is a small mammal. Every cat purrs.')],
  }
}

async function renderOpenConversation() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // jsdom has no layout: give matches a position and let the chat be scrolled without doing anything.
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, writable: true, value: () => ({ top: 0, height: 20 }) })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes><Route path="/chat/:convId" element={<ChatScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const findBox = () => screen.queryByRole('textbox', { name: /find in chat/i })
const pressFindShortcut = (init: KeyboardEventInit = { key: 'f', ctrlKey: true }) => {
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('ChatScreen — find in chat', () => {
  beforeEach(() => { mockConversation = openConversation() })
  afterEach(() => { mockConversation = undefined })

  it('opens the find bar on Ctrl+F, taking the shortcut from the browser', async () => {
    await renderOpenConversation()
    expect(findBox()).toBeNull()

    const event = pressFindShortcut()

    await waitFor(() => expect(findBox()).not.toBeNull())
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens the find bar on Cmd+F too', async () => {
    await renderOpenConversation()

    pressFindShortcut({ key: 'F', metaKey: true })

    await waitFor(() => expect(findBox()).not.toBeNull())
  })

  it('leaves Ctrl+F to the browser when no conversation is open', async () => {
    mockConversation = undefined
    const { ChatScreen } = await import('./ChatScreen')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryRouter><ChatScreen /></MemoryRouter></QueryClientProvider>)

    const event = pressFindShortcut()

    expect(event.defaultPrevented).toBe(false)
    expect(findBox()).toBeNull()
  })

  it('opens the find bar from a header button, for phones and mice', async () => {
    await renderOpenConversation()

    fireEvent.click(screen.getByRole('button', { name: /find in chat/i }))

    await waitFor(() => expect(findBox()).not.toBeNull())
  })

  it('closes the find bar on Escape', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await waitFor(() => expect(findBox()).not.toBeNull())

    fireEvent.keyDown(findBox()!, { key: 'Escape' })

    expect(findBox()).toBeNull()
  })

  it('brings the cursor back to the box when Ctrl+F is pressed while it is already open', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await waitFor(() => expect(findBox()).not.toBeNull())
    ;(document.activeElement as HTMLElement).blur()

    pressFindShortcut()

    await waitFor(() => expect(document.activeElement).toBe(findBox()))
  })

  it('searches the messages the chat actually shows', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await waitFor(() => expect(findBox()).not.toBeNull())

    fireEvent.change(findBox()!, { target: { value: 'cat' } })

    expect(screen.getByTestId('find-count').textContent).toBe('1 of 3')
  })
})

describe('ChatScreen — model picker offers chat models only', () => {
  const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', compatibleWithActiveEngine: true }
  const jevModel: Partial<ModelEntry> = {
    key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', compatibleWithActiveEngine: true,
    jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
  }
  const wrongEngineChatModel: Partial<ModelEntry> = { key: 'gguf-on-vllm', name: 'GGUF on vLLM', compatibleWithActiveEngine: false }

  beforeEach(() => {
    mockLibrary = [chatModel, jevModel, wrongEngineChatModel]
    modelsOfferedByPicker = null
  })

  it('offers the engine-compatible chat model and not the Jev model', async () => {
    await renderScreen()
    await waitFor(() => expect(modelsOfferedByPicker).not.toBeNull())
    expect(modelsOfferedByPicker?.map((m) => m.key)).toEqual(['qwen3-8b'])
  })
})
