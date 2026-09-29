// GitHub #52 (b15hop): an expanded thinking block opened a fixed 192px scroll box, so on a fast
// model the reasoning could not be skimmed as it grew, and a runaway loop went unnoticed. An
// expanded block now grows with its text and the chat's own scroll does the work.
//
// The collapsed-by-default and hidden-by-setting behaviours are pinned alongside, because the
// change touches the same block and neither may move.
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

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
