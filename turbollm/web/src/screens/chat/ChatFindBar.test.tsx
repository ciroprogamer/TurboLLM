// GitHub #52 (b15hop): a find bar for long chat sessions. Rendered against a real DOM message list,
// so the matching, the "3 of 17" count, and the jumping between matches are the real code paths.
// jsdom has no layout, so two things are stood in for: the CSS highlight registry, and where things
// are on the page. A match sits 100px per paragraph down the page, plus its character offset, and
// every scroll of the chat is recorded as the position it was scrolled to.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_FIND_MATCHES } from '../../lib/chat-find'
import { ChatFindBar } from './ChatFindBar'

const CHAT_HTML = '<p>the cat sat</p><p>a dog</p><p>another cat here</p><p>last cat</p>'
const MATCH_HEIGHT = 20

let scrolledTo: number[]
let highlightRegistry: Map<string, { ranges: Range[] }>

function pageTopOf(match: Range): number {
  const paragraph = match.startContainer.parentElement as HTMLElement
  const paragraphIndex = [...(paragraph.parentElement as HTMLElement).children].indexOf(paragraph)
  return paragraphIndex * 100 + match.startOffset
}

beforeEach(() => {
  scrolledTo = []
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: Element, options: ScrollToOptions) { scrolledTo.push(options.top as number) },
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Range) { return { top: pageTopOf(this), height: MATCH_HEIGHT } },
  })

  highlightRegistry = new Map()
  class FakeHighlight {
    ranges: Range[] = []
    priority = 0
    add(range: Range) { this.ranges.push(range) }
  }
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: highlightRegistry })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

interface HarnessProps { onClose?: () => void; onReveal?: () => void; focusRequest?: number; html?: string }

function Harness({ onClose = () => {}, onReveal, focusRequest = 0, html = CHAT_HTML }: HarnessProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <ChatFindBar scrollerRef={scrollerRef} focusRequest={focusRequest} onClose={onClose} onReveal={onReveal} />
      <div ref={scrollerRef} data-testid="scroller" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}

const HALF_A_MATCH = MATCH_HEIGHT / 2
// Where the chat scrolls for each "cat" in CHAT_HTML: paragraph index * 100, plus the word's offset in it.
const FIRST_CAT = 4 + HALF_A_MATCH // "the cat sat"
const SECOND_CAT = 200 + 8 + HALF_A_MATCH // "another cat here"

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

  it('scrolls the chat to the first match as soon as it is found', () => {
    render(<Harness />)

    search('cat')

    expect(scrolledTo).toEqual([FIRST_CAT])
  })

  it('Enter jumps to the next match and scrolls the chat to it', () => {
    render(<Harness />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter' })

    expect(count()).toBe('2 of 3')
    expect(scrolledTo.at(-1)).toBe(SECOND_CAT)
  })

  it('scrolls to every match, even when they are all inside one long message', () => {
    render(<Harness html="<p>cat cat cat</p>" />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter' })
    fireEvent.keyDown(findInput(), { key: 'Enter' })

    expect(scrolledTo).toEqual([0 + HALF_A_MATCH, 4 + HALF_A_MATCH, 8 + HALF_A_MATCH])
  })

  it('scrolls the chat back when stepping to the previous match', () => {
    render(<Harness />)
    search('cat')
    fireEvent.keyDown(findInput(), { key: 'Enter' })

    fireEvent.keyDown(findInput(), { key: 'Enter', shiftKey: true })

    expect(scrolledTo.at(-1)).toBe(FIRST_CAT)
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
    const scrollsBefore = scrolledTo.length

    act(() => {
      const streamed = document.createElement('p')
      streamed.textContent = 'one more cat'
      screen.getByTestId('scroller').appendChild(streamed)
    })

    await waitFor(() => expect(count()).toBe('1 of 4'))
    expect(scrolledTo).toHaveLength(scrollsBefore)
  })

  it('closes on Escape from its buttons too, not only from the search box', () => {
    const onClose = vi.fn()
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    render(<Harness onClose={onClose} />)
    search('cat')

    fireEvent.keyDown(screen.getByRole('button', { name: /next match/i }), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(windowKeyDown).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('does not close when Escape only cancels an input-method composition', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    fireEvent.keyDown(findInput(), { key: 'Escape', isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not jump to the next match when Enter only confirms an input-method composition', () => {
    render(<Harness />)
    search('cat')

    fireEvent.keyDown(findInput(), { key: 'Enter', isComposing: true })

    expect(count()).toBe('1 of 3')
  })

  it('says when there are more matches than it will follow, instead of a count that looks exact', () => {
    render(<Harness html={`<p>${'e'.repeat(MAX_FIND_MATCHES + 100)}</p>`} />)

    search('e')

    expect(count()).toBe(`1 of ${MAX_FIND_MATCHES}+`)
  })

  it('tells the chat when it moves the view on purpose, but not when it only refreshes', async () => {
    const onReveal = vi.fn()
    render(<Harness onReveal={onReveal} />)

    search('cat')
    expect(onReveal).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(findInput(), { key: 'Enter' })
    expect(onReveal).toHaveBeenCalledTimes(2)

    act(() => {
      const streamed = document.createElement('p')
      streamed.textContent = 'one more cat'
      screen.getByTestId('scroller').appendChild(streamed)
    })
    await waitFor(() => expect(count()).toBe('2 of 4'))
    expect(onReveal).toHaveBeenCalledTimes(2)
  })

  describe('while a reply streams', () => {
    const streamAMatchEvery = async (milliseconds: number, times: number) => {
      for (let i = 0; i < times; i += 1) {
        await act(async () => {
          const streamed = document.createElement('p')
          streamed.textContent = 'cat'
          screen.getByTestId('scroller').appendChild(streamed)
          await vi.advanceTimersByTimeAsync(milliseconds)
        })
      }
    }
    const total = () => Number(count()?.split(' of ')[1])

    it('keeps the count current while text is still arriving, not only once it goes quiet', async () => {
      vi.useFakeTimers()
      render(<Harness />)
      search('cat')

      // Tokens arrive faster than the refresh delay, so a refresh that waits for a quiet moment never runs.
      await streamAMatchEvery(50, 10)

      expect(total()).toBeGreaterThan(3)
    })

    it('keeps stepping through matches in the very text that is streaming in, without falling back', async () => {
      vi.useFakeTimers()
      render(<Harness html="<p>cat one. cat two. cat three. cat four</p>" />)
      search('cat')
      const streaming = screen.getByTestId('scroller').querySelector('p')!.firstChild as Text
      // React streams a reply by replacing the text node's value, not by adding a node.
      const streamAWord = async () => {
        await act(async () => {
          streaming.nodeValue = `${streaming.data} word`
          await vi.advanceTimersByTimeAsync(200)
        })
      }

      fireEvent.keyDown(findInput(), { key: 'Enter' })
      fireEvent.keyDown(findInput(), { key: 'Enter' })
      expect(count()).toBe('3 of 4')
      await streamAWord()
      expect(count()).toBe('3 of 4')

      fireEvent.keyDown(findInput(), { key: 'Enter' })
      await streamAWord()
      expect(count()).toBe('4 of 4')

      fireEvent.keyDown(findInput(), { key: 'Enter' })
      expect(count()).toBe('1 of 4')
    })

    it('stays on the same match when text arrives above it', async () => {
      vi.useFakeTimers()
      render(<Harness />)
      search('cat')
      fireEvent.keyDown(findInput(), { key: 'Enter' })
      expect(count()).toBe('2 of 3')

      await act(async () => {
        const earlier = document.createElement('p')
        earlier.textContent = 'a cat that arrived first'
        screen.getByTestId('scroller').prepend(earlier)
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(count()).toBe('3 of 4')
    })
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
