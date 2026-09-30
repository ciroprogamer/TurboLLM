// GitHub #52 (b15hop): find text inside a long chat. These are the pure DOM pieces behind the find
// bar — matching text in a rendered message list, and painting the matches with the browser's
// CSS Custom Highlight API (which never touches the markdown DOM, unlike wrapping matches in <mark>).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFindHighlights, findTextRanges, liveRangeOf, MAX_FIND_MATCHES, paintFindHighlights, scrollMatchIntoView } from './chat-find'

function messageList(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const texts = (ranges: AbstractRange[]) => ranges.map((r) => liveRangeOf(r)?.toString())

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

  it('does not count text nobody can see: a hidden element, or the text inside an edit box', () => {
    const root = messageList('<p>cat</p><div hidden>cat</div><textarea>cat</textarea>')

    expect(findTextRanges(root, 'cat')).toHaveLength(1)
  })

  // React streams a reply by replacing a text node's value. A live Range in that node collapses to
  // its start when that happens, which lost the reader's place in the reply and made every refresh of
  // a long chat cost more, because the browser keeps every live Range up to date. So matches are fixed
  // positions, and a live Range is made only when one is needed (to scroll, to compare).
  it('returns fixed positions, which stay put when a streaming text node has its value replaced', () => {
    const root = messageList('<p>cat one. cat two.</p>')
    const [, second] = findTextRanges(root, 'cat')
    const textNode = second.startContainer as Text
    const startedAt = second.startOffset

    textNode.nodeValue = 'cat one. cat two. and now a great deal more streamed text'

    expect(second.startContainer).toBe(textNode)
    expect(second.startOffset).toBe(startedAt)
  })

  it('makes a live range from a match only on request, and not for one whose text has gone', () => {
    const root = messageList('<p>find me</p>')
    const [match] = findTextRanges(root, 'me')
    expect(liveRangeOf(match)?.toString()).toBe('me')

    root.remove()

    expect(liveRangeOf(match)).toBeNull()
  })

  it('stops at a limit, so a one-letter search in a huge chat cannot make tens of thousands of ranges', () => {
    const root = messageList(`<p>${'e'.repeat(MAX_FIND_MATCHES + 500)}</p>`)

    expect(findTextRanges(root, 'e')).toHaveLength(MAX_FIND_MATCHES)
  })
})

// Markdown splits one line of text across elements (bold, inline code, syntax-highlighted tokens),
// so text the reader sees as one phrase is several text nodes. Find has to see the phrase.
describe('findTextRanges across formatting', () => {
  it('finds a phrase that runs across a highlighted code line', () => {
    const root = messageList('<pre><code><span class="kw">const</span> <span class="id">x</span> = 1</code></pre>')

    const [match] = findTextRanges(root, 'const x')

    expect(liveRangeOf(match)?.toString()).toBe('const x')
  })

  it('finds a phrase that runs into bold text', () => {
    const root = messageList('<p>the <strong>TurboLLM</strong> is here</p>')

    expect(texts(findTextRanges(root, 'TurboLLM is'))).toEqual(['TurboLLM is'])
  })

  it('finds a phrase that starts in one formatted piece and ends in another', () => {
    const root = messageList('<p>run <code>npm test</code> now</p>')

    expect(texts(findTextRanges(root, 'run npm'))).toEqual(['run npm'])
  })

  it('does not join text from different paragraphs, list items or table cells', () => {
    const root = messageList('<p>the end</p><p>begins here</p><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table>')

    expect(findTextRanges(root, 'endbegins')).toEqual([])
    expect(findTextRanges(root, 'onetwo')).toEqual([])
    expect(findTextRanges(root, 'ab')).toEqual([])
  })

  it('does not join text on either side of a line break', () => {
    const root = messageList('<p>line one<br>line two</p>')

    expect(findTextRanges(root, 'oneline')).toEqual([])
    expect(texts(findTextRanges(root, 'line'))).toEqual(['line', 'line'])
  })

  it('still finds several matches, in order, when they sit in different pieces', () => {
    const root = messageList('<p>cat <em>cat</em> cat</p><p>cat</p>')

    expect(findTextRanges(root, 'cat')).toHaveLength(4)
  })
})

// jsdom has no layout, so positions are stated: a match sits `characterOffset * 10` px below the top
// of the page, and the scroll area starts 100px down, is 400px tall and is scrolled to 300px.
const stated = new WeakMap<Node, Map<number, DOMRect>>()
const ON_NO_SCREEN = { top: 0, height: 0, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function layOut(match: AbstractRange, top: number, across: { left: number; width: number } = { left: 0, width: 0 }, height = 20) {
  const box = { top, height, bottom: top + height, left: across.left, right: across.left + across.width, width: across.width, x: across.left, y: top, toJSON: () => ({}) } as DOMRect
  const byOffset = stated.get(match.startContainer) ?? new Map<number, DOMRect>()
  byOffset.set(match.startOffset, box)
  stated.set(match.startContainer, byOffset)
}

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Range) { return stated.get(this.startContainer)?.get(this.startOffset) ?? ON_NO_SCREEN },
  })
})

/** A box inside the chat that scrolls on its own (a thinking block, a code block, tool output). */
function innerScrollBox(element: HTMLElement, box: { top: number; height: number; left: number; width: number }, content: { height: number; width: number }, overflow: 'auto' | 'visible' = 'auto') {
  element.style.overflowX = overflow
  element.style.overflowY = overflow
  Object.defineProperties(element, {
    scrollTop: { value: 0, writable: true },
    scrollLeft: { value: 0, writable: true },
    clientHeight: { value: box.height },
    clientWidth: { value: box.width },
    scrollHeight: { value: content.height },
    scrollWidth: { value: content.width },
  })
  element.getBoundingClientRect = () => ({ ...box, bottom: box.top + box.height, right: box.left + box.width, x: box.left, y: box.top, toJSON: () => ({}) })
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

  it('scrolls a thinking block, code block or tool output that holds the match, so the match is not hidden inside it', () => {
    const root = messageList('<pre>line one\nline two, find me here</pre>')
    const block = root.querySelector('pre') as HTMLElement
    innerScrollBox(block, { top: 1000, height: 250, left: 0, width: 600 }, { height: 5000, width: 600 })
    const [match] = findTextRanges(root, 'find me')
    layOut(match, 4000)
    const { scroller, scrollTo } = scrollAreaAt(0)

    scrollMatchIntoView(match, scroller)

    // The match's middle (4010) sits 2885px below the block's middle (1125).
    expect(block.scrollTop).toBe(2885)
    expect(scrollTo).toHaveBeenCalled()
  })

  it('scrolls a long code line sideways to the match', () => {
    const root = messageList('<pre>a very long line of code with the needle at the far end</pre>')
    const block = root.querySelector('pre') as HTMLElement
    innerScrollBox(block, { top: 1000, height: 100, left: 100, width: 500 }, { height: 100, width: 3000 })
    const [match] = findTextRanges(root, 'needle')
    layOut(match, 1010, { left: 2500, width: 40 })
    const { scroller } = scrollAreaAt(0)

    scrollMatchIntoView(match, scroller)

    // The match's middle (2520) sits 2170px right of the block's middle (350).
    expect(block.scrollLeft).toBe(2170)
    expect(block.scrollTop).toBe(0)
  })

  it('leaves alone a box that is not a scroll area, even if its content is taller than it is', () => {
    const root = messageList('<div><p>find me here</p></div>')
    const wrapper = root.querySelector('div') as HTMLElement
    innerScrollBox(wrapper, { top: 1000, height: 100, left: 0, width: 600 }, { height: 900, width: 600 }, 'visible')
    const [match] = findTextRanges(root, 'me')
    layOut(match, 1500)
    const { scroller } = scrollAreaAt(0)

    scrollMatchIntoView(match, scroller)

    expect(wrapper.scrollTop).toBe(0)
  })

  it('leaves alone a scroll area whose content fits', () => {
    const root = messageList('<pre>find me here</pre>')
    const block = root.querySelector('pre') as HTMLElement
    innerScrollBox(block, { top: 1000, height: 250, left: 0, width: 600 }, { height: 250, width: 600 })
    const [match] = findTextRanges(root, 'me')
    layOut(match, 1100)
    const { scroller } = scrollAreaAt(0)

    scrollMatchIntoView(match, scroller)

    expect(block.scrollTop).toBe(0)
    expect(block.scrollLeft).toBe(0)
  })

  it('does not scroll to a match that has no position on screen', () => {
    const root = messageList('<p>find me here</p>')
    const [match] = findTextRanges(root, 'me')
    layOut(match, 0, { left: 0, width: 0 }, 0)
    const { scroller, scrollTo } = scrollAreaAt(300)

    scrollMatchIntoView(match, scroller)

    expect(scrollTo).not.toHaveBeenCalled()
  })
})

interface FakeHighlights extends Map<string, { ranges: Range[]; priority: number }> {}

function stubHighlightApi(): FakeHighlights {
  const registry: FakeHighlights = new Map()
  class FakeHighlight {
    ranges: Range[] = []
    priority = 0
    // The real constructor takes its ranges as arguments, and a browser runs out of stack when they
    // are spread from a big enough array (about 62,000 in Chromium 152), which blanked the app.
    constructor(...ranges: Range[]) {
      if (ranges.length > 60_000) throw new RangeError('Maximum call stack size exceeded')
      this.ranges = ranges
    }
    add(range: Range) { this.ranges.push(range) }
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

  it('paints a very large number of matches without running out of stack', () => {
    const registry = stubHighlightApi()
    const root = messageList('<p>ab</p>')
    const oneMatch = findTextRanges(root, 'ab')[0]
    const ranges = Array.from({ length: 70_000 }, () => new StaticRange({ startContainer: oneMatch.startContainer, startOffset: oneMatch.startOffset, endContainer: oneMatch.endContainer, endOffset: oneMatch.endOffset }))

    expect(() => paintFindHighlights(ranges, 0)).not.toThrow()

    expect(registry.get('tllm-find')?.ranges).toHaveLength(70_000)
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
