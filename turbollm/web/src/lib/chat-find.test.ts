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

describe('scrollMatchIntoView', () => {
  it('brings the element holding the match to the middle of the scroll area', () => {
    const root = messageList('<p>find me here</p>')
    const paragraph = root.querySelector('p') as HTMLElement
    const scrollIntoView = vi.fn()
    Object.defineProperty(paragraph, 'scrollIntoView', { value: scrollIntoView })
    const [match] = findTextRanges(root, 'me')

    scrollMatchIntoView(match)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
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
