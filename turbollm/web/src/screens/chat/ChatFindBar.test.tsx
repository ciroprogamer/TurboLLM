// GitHub #52 (b15hop): a find bar for long chat sessions. Rendered against a real DOM message list,
// so the matching, the "3 of 17" count, and the jumping between matches are the real code paths.
// The CSS highlight registry is a small stand-in (jsdom has none), and scrollIntoView is recorded.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatFindBar } from './ChatFindBar'

const CHAT_HTML = '<p>the cat sat</p><p>a dog</p><p>another cat here</p><p>last cat</p>'

let scrolledElements: Element[]
let highlightRegistry: Map<string, { ranges: Range[] }>

beforeEach(() => {
  scrolledElements = []
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolledElements.push(this) },
  })

  highlightRegistry = new Map()
  class FakeHighlight {
    ranges: Range[]
    priority = 0
    constructor(...ranges: Range[]) { this.ranges = ranges }
  }
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: highlightRegistry })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function Harness({ onClose = () => {}, focusRequest = 0 }: { onClose?: () => void; focusRequest?: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <ChatFindBar scrollerRef={scrollerRef} focusRequest={focusRequest} onClose={onClose} />
      <div ref={scrollerRef} data-testid="scroller" dangerouslySetInnerHTML={{ __html: CHAT_HTML }} />
    </>
  )
}

const findInput = () => screen.getByRole('textbox', { name: /find in chat/i }) as HTMLInputElement
const search = (query: string) => fireEvent.change(findInput(), { target: { value: query } })
const count = () => screen.getByTestId('find-count').textContent

describe('ChatFindBar', () => {
  it('puts the cursor in the search box when it opens', () => {
    render(<Harness />)

    expect(document.activeElement).toBe(findInput())
  })

  it('shows how many matches there are, starting on the first', () => {
    render(<Harness />)

    search('cat')

    expect(count()).toBe('1 of 3')
  })

  it('shows no count until something is typed', () => {
    render(<Harness />)

    expect(count()).toBe('')
  })

  it('says so when nothing matches', () => {
    render(<Harness />)

    search('zebra')

    expect(count()).toBe('No results')
  })

  it('highlights every match and marks the current one', () => {
    render(<Harness />)

    search('cat')

    expect(highlightRegistry.get('tllm-find')?.ranges).toHaveLength(3)
    expect(highlightRegistry.get('tllm-find-active')?.ranges).toHaveLength(1)
  })

  it('scrolls the first match into view as soon as it is found', () => {
    render(<Harness />)

    search('cat')

    expect(scrolledElements.map((el) => el.textContent)).toEqual(['the cat sat'])
  })

  it('Enter jumps to the next match and scrolls to it', () => {
    render(<Harness />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter' })

    expect(count()).toBe('2 of 3')
    expect(scrolledElements.at(-1)?.textContent).toBe('another cat here')
  })

  it('Shift+Enter jumps back, and wraps from the first match to the last', () => {
    render(<Harness />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter', shiftKey: true })

    expect(count()).toBe('3 of 3')
  })

  it('Enter wraps from the last match to the first', () => {
    render(<Harness />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter' })
    fireEvent.keyDown(findInput(), { key: 'Enter' })
    fireEvent.keyDown(findInput(), { key: 'Enter' })

    expect(count()).toBe('1 of 3')
  })

  it('has next and previous buttons that do the same', () => {
    render(<Harness />)
    search('cat')

    fireEvent.click(screen.getByRole('button', { name: /next match/i }))
    expect(count()).toBe('2 of 3')

    fireEvent.click(screen.getByRole('button', { name: /previous match/i }))
    expect(count()).toBe('1 of 3')
  })

  it('disables next and previous while there is nothing to jump to', () => {
    render(<Harness />)

    search('zebra')

    expect((screen.getByRole('button', { name: /next match/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /previous match/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts again from the first match when the search changes', () => {
    render(<Harness />)
    search('cat')
    fireEvent.keyDown(findInput(), { key: 'Enter' })

    search('cat s')

    expect(count()).toBe('1 of 1')
  })

  it('closes on Escape, without also stopping a running generation', () => {
    const onClose = vi.fn()
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    render(<Harness onClose={onClose} />)

    fireEvent.keyDown(findInput(), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(windowKeyDown).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('closes from the close button', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /close find/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('removes its highlights when it closes', () => {
    const { unmount } = render(<Harness />)
    search('cat')

    unmount()

    expect(highlightRegistry.size).toBe(0)
  })

  it('takes new text into account while the chat is still streaming, without pulling the view away', async () => {
    render(<Harness />)
    search('cat')
    const scrollsBefore = scrolledElements.length

    act(() => {
      const streamed = document.createElement('p')
      streamed.textContent = 'one more cat'
      screen.getByTestId('scroller').appendChild(streamed)
    })

    await waitFor(() => expect(count()).toBe('1 of 4'))
    expect(scrolledElements).toHaveLength(scrollsBefore)
  })

  it('selects the existing search text when asked to focus again, so typing replaces it', () => {
    const { rerender } = render(<Harness focusRequest={0} />)
    search('cat')
    findInput().blur()

    rerender(<Harness focusRequest={1} />)

    expect(document.activeElement).toBe(findInput())
    expect(findInput().selectionStart).toBe(0)
    expect(findInput().selectionEnd).toBe('cat'.length)
  })
})
