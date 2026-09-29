// GitHub #52 (b15hop): an expanded thinking block opened a fixed 192px scroll box, so on a fast
// model the reasoning could not be skimmed as it grew, and a runaway loop went unnoticed. An
// expanded block now grows with its text until the reader drags it to a size, and that size is
// remembered (one size, shared by every block).
//
// The collapsed-by-default and hidden-by-setting behaviours are pinned alongside, because the
// change touches the same block and neither may move.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble, StreamingBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const SIZE_KEY = 'tllm.thinkingBlock.height'

let store: Map<string, string>
let resizeObservers: Array<() => void>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })

  resizeObservers = []
  class FakeResizeObserver {
    private observing = false
    constructor(private readonly callback: ResizeObserverCallback) {
      resizeObservers.push(() => { if (this.observing) this.callback([], this) })
    }
    observe() { this.observing = true }
    unobserve() { this.observing = false }
    disconnect() { this.observing = false }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

/** What the browser does when the reader drags the resize handle: it sets an inline height and the
 *  element's size changes, which a ResizeObserver reports. */
function dragTo(block: HTMLElement, height: string) {
  block.style.height = height
  act(() => resizeObservers.forEach((notify) => notify()))
}

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return { ...actual, useChatAgents: () => ({ data: [] }), useModels: () => ({ data: { models: [] } }) }
})

const LONG_REASONING = Array.from({ length: 200 }, (_, i) => `step ${i}: still weighing the options`).join('\n')

function reasoningMessage(reasoning: string): Message {
  return {
    id: 'm1', convId: 'c1', seq: 2, role: 'assistant', content: 'Final answer.', reasoning,
    attachments: [], textAttachments: [], toolCalls: [], stats: { thinkMs: 4200 }, createdAt: '',
    variantGroup: null, isActive: true, edited: false,
  }
}

function renderBubble(message: Message, showThinking = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble
        message={message}
        isLast={false}
        editingId={null}
        onEditSave={() => {}}
        onEditCancel={() => {}}
        showThinking={showThinking}
      />
    </QueryClientProvider>,
  )
}

function openThinkingBlock() {
  fireEvent.click(screen.getByRole('button', { name: /thought for 4\.2s/i }))
  return screen.getByText(/step 0: still weighing/).closest('pre') as HTMLElement
}

describe('thinking block', () => {
  it('grows with its reasoning instead of scrolling inside a fixed-height box', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    const reasoning = openThinkingBlock()

    expect(reasoning.className).not.toMatch(/(^|\s)max-h-/)
    expect(reasoning.className).not.toMatch(/(^|\s)overflow-y-/)
  })

  it('can be resized from its bottom edge', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    const reasoning = openThinkingBlock()

    expect(reasoning.className).toMatch(/(^|\s)resize-y(\s|$)/)
  })

  it('has no set height until the reader sets one, so it keeps growing with the text', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    expect(openThinkingBlock().style.height).toBe('')
  })

  it('opens at the size the reader chose before', () => {
    store.set(SIZE_KEY, '320')
    renderBubble(reasoningMessage(LONG_REASONING))

    expect(openThinkingBlock().style.height).toBe('320px')
  })

  it('remembers the size the reader drags it to', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    dragTo(openThinkingBlock(), '260px')

    expect(store.get(SIZE_KEY)).toBe('260')
  })

  it('does not take the text growing as a size chosen by the reader', () => {
    renderBubble(reasoningMessage(LONG_REASONING))
    openThinkingBlock()

    act(() => resizeObservers.forEach((notify) => notify()))

    expect(store.has(SIZE_KEY)).toBe(false)
  })

  it('resizes every open block when one is dragged', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble message={{ ...reasoningMessage(LONG_REASONING), id: 'a' }} isLast={false} editingId={null} onEditSave={() => {}} onEditCancel={() => {}} />
        <MessageBubble message={{ ...reasoningMessage('other reasoning here'), id: 'b' }} isLast={false} editingId={null} onEditSave={() => {}} onEditCancel={() => {}} />
      </QueryClientProvider>,
    )
    const [first, second] = screen.getAllByRole('button', { name: /thought for 4\.2s/i })
    fireEvent.click(first)
    fireEvent.click(second)
    const blocks = [screen.getByText(/step 0: still weighing/).closest('pre'), screen.getByText(/other reasoning here/).closest('pre')] as HTMLElement[]

    dragTo(blocks[0], '260px')

    expect(blocks[1].style.height).toBe('260px')
  })

  it('shows every line of a long reasoning once opened', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    const reasoning = openThinkingBlock()

    expect(reasoning.textContent).toContain('step 199: still weighing the options')
  })

  it('stays collapsed until the header is clicked', () => {
    renderBubble(reasoningMessage(LONG_REASONING))

    expect(screen.queryByText(/step 0: still weighing/)).toBeNull()
  })

  it('shows only the stats line, with no expand control, when thinking is hidden in settings', () => {
    renderBubble(reasoningMessage(LONG_REASONING), false)

    expect(screen.getByText(/thought for 4\.2s/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /thought for 4\.2s/i })).toBeNull()
  })
})

describe('thinking block while it streams', () => {
  it('keeps the newest reasoning in view once the reader has set a size', () => {
    store.set(SIZE_KEY, '200')
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 999 })
    try {
      const queryClient = new QueryClient()
      const streaming = (reasoning: string) => (
        <QueryClientProvider client={queryClient}>
          <StreamingBubble timeline={[]} reasoning={reasoning} progress={null} liveGenTps={0} genTokens={0} />
        </QueryClientProvider>
      )
      const { rerender } = render(streaming('first thoughts'))
      fireEvent.click(screen.getByRole('button', { name: /thinking/i }))
      const block = screen.getByText(/first thoughts/).closest('pre') as HTMLElement
      block.scrollTop = 0

      rerender(streaming('first thoughts and then a great deal more'))

      expect(block.scrollTop).toBe(999)
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollHeight', original)
    }
  })
})
