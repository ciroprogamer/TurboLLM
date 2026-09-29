// GitHub #52 (b15hop): find text inside a long chat. These are the pure DOM pieces behind the find
// bar — matching text in a rendered message list, and painting the matches with the browser's
// CSS Custom Highlight API (which never touches the markdown DOM, unlike wrapping matches in <mark>).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearFindHighlights, findTextRanges, paintFindHighlights, scrollMatchIntoView } from './chat-find'

function messageList(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const texts = (ranges: Range[]) => ranges.map((r) => r.toString())

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('findTextRanges', () => {
  it('finds every match, in document order, across separate messages', () => {
    const root = messageList('<p>the cat sat</p><div><p>another cat</p></div><p>no felines</p>')

    const ranges = findTextRanges(root, 'cat')

    expect(texts(ranges)).toEqual(['cat', 'cat'])
    expect(ranges[0].startContainer.textContent).toBe('the cat sat')
    expect(ranges[1].startContainer.textContent).toBe('another cat')
  })

  it('finds several matches inside one text node', () => {
    const root = messageList('<p>ab ab ab</p>')

    expect(findTextRanges(root, 'ab')).toHaveLength(3)
  })

  it('ignores case in the search but keeps the original text in the match', () => {
    const root = messageList('<p>Docker docker DOCKER</p>')

    expect(texts(findTextRanges(root, 'docker'))).toEqual(['Docker', 'docker', 'DOCKER'])
  })

  it('treats regular-expression characters as plain text', () => {
    const root = messageList('<p>a.b axb a+b (x)</p>')

    expect(texts(findTextRanges(root, 'a.b'))).toEqual(['a.b'])
    expect(texts(findTextRanges(root, 'a+b'))).toEqual(['a+b'])
    expect(texts(findTextRanges(root, '(x)'))).toEqual(['(x)'])
  })

  it('finds text inside formatting elements', () => {
    const root = messageList('<p>use <code>npm install</code> or <strong>npm ci</strong></p>')

    expect(texts(findTextRanges(root, 'npm'))).toEqual(['npm', 'npm'])
  })

  it('returns nothing for an empty query', () => {
    const root = messageList('<p>anything at all</p>')

    expect(findTextRanges(root, '')).toEqual([])
  })

  it('returns nothing when the text is absent', () => {
    const root = messageList('<p>anything at all</p>')

    expect(findTextRanges(root, 'zebra')).toEqual([])
  })

  it('does not search the text of script or style elements', () => {
    const root = messageList('<p>visible</p><script>var visible = 1</script><style>.visible {}</style>')

    expect(findTextRanges(root, 'visible')).toHaveLength(1)
  })
})

// jsdom has no layout, so positions are stated: a match sits `characterOffset * 10` px below the top
// of the page, and the scroll area starts 100px down, is 400px tall and is scrolled to 300px.
function layOut(match: Range, top: number) {
  match.getBoundingClientRect = () => ({ top, height: 20, bottom: top + 20, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) })
}

function scrollAreaAt(scrollTop: number): { scroller: HTMLElement; scrollTo: ReturnType<typeof vi.fn> } {
  const scroller = document.createElement('div')
  const scrollTo = vi.fn()
  Object.defineProperties(scroller, {
    scrollTo: { value: scrollTo },
    clientHeight: { value: 400 },
    scrollTop: { value: scrollTop, writable: true },
  })
  scroller.getBoundingClientRect = () => ({ top: 100, height: 400, bottom: 500, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) })
  return { scroller, scrollTo }
}

describe('scrollMatchIntoView', () => {
  it('centres the match itself in the scroll area', () => {
    const root = messageList('<p>find me here</p>')
    const [match] = findTextRanges(root, 'me')
    layOut(match, 1000)
    const { scroller, scrollTo } = scrollAreaAt(300)

    scrollMatchIntoView(match, scroller)

    // 1000 - 100 (area top) + 300 (already scrolled) + 10 (half the match) - 200 (half the area)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1010 })
  })

  it('moves to each match inside one tall element, instead of staying on the element', () => {
    const root = messageList('<p>ab ab ab</p>')
    const [first, second, third] = findTextRanges(root, 'ab')
    layOut(first, 500)
    layOut(second, 1500)
    layOut(third, 2500)
    const { scroller, scrollTo } = scrollAreaAt(0)

    scrollMatchIntoView(first, scroller)
    scrollMatchIntoView(second, scroller)
    scrollMatchIntoView(third, scroller)

    const targets = scrollTo.mock.calls.map(([options]) => options.top)
    expect(new Set(targets).size).toBe(3)
    expect(targets).toEqual([...targets].sort((a, b) => a - b))
  })

  it('does not scroll to a match that has no position on screen', () => {
    const root = messageList('<p>find me here</p>')
    const [match] = findTextRanges(root, 'me')
    match.getBoundingClientRect = () => ({ top: 0, height: 0, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) })
    const { scroller, scrollTo } = scrollAreaAt(300)

    scrollMatchIntoView(match, scroller)

    expect(scrollTo).not.toHaveBeenCalled()
  })
})

interface FakeHighlights extends Map<string, { ranges: Range[]; priority: number }> {}

function stubHighlightApi(): FakeHighlights {
  const registry: FakeHighlights = new Map()
  class FakeHighlight {
    ranges: Range[]
    priority = 0
    constructor(...ranges: Range[]) { this.ranges = ranges }
  }
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: registry })
  return registry
}

describe('paintFindHighlights', () => {
  it('paints every match, and the current one on top under its own name', () => {
    const registry = stubHighlightApi()
    const root = messageList('<p>ab ab ab</p>')
    const ranges = findTextRanges(root, 'ab')

    paintFindHighlights(ranges, 1)

    expect(registry.get('tllm-find')?.ranges).toEqual(ranges)
    expect(registry.get('tllm-find-active')?.ranges).toEqual([ranges[1]])
    expect(registry.get('tllm-find-active')!.priority).toBeGreaterThan(registry.get('tllm-find')!.priority)
  })

  it('clears both highlights', () => {
    const registry = stubHighlightApi()
    const root = messageList('<p>ab ab</p>')
    paintFindHighlights(findTextRanges(root, 'ab'), 0)

    clearFindHighlights()

    expect(registry.size).toBe(0)
  })

  it('does nothing, without throwing, in a browser without the highlight API', () => {
    const root = messageList('<p>ab ab</p>')
    const ranges = findTextRanges(root, 'ab')

    expect(() => paintFindHighlights(ranges, 0)).not.toThrow()
    expect(() => clearFindHighlights()).not.toThrow()
  })
})
