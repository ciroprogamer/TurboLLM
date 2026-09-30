const ALL_MATCHES_HIGHLIGHT = 'tllm-find'
const CURRENT_MATCH_HIGHLIGHT = 'tllm-find-active'
const NON_PROSE_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA'])

// A one-letter search in a very long chat can match tens of thousands of times. Past this, more matches
// help no one, and every refresh while a reply streams gets slower.
export const MAX_FIND_MATCHES = 10_000

// Text in different blocks is never one phrase, however the DOM happens to order it.
const BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BUTTON', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

// Matches are fixed positions (StaticRange), not live Ranges. React streams a reply by replacing a text
// node's value, and a live Range in that node collapses to its start when that happens, which lost the
// reader's place in the reply; and the browser keeps every live Range up to date on every change, so
// thousands of them made each refresh slower. A live Range is made only when one is needed: liveRangeOf.
export function findTextRanges(root: Node, query: string): StaticRange[] {
  if (!query) return []
  const pattern = new RegExp(escapeForRegExp(query), 'giu')
  const ranges: StaticRange[] = []
  for (const block of textNodesByBlock(root)) {
    for (const range of matchRangesIn(block, pattern, MAX_FIND_MATCHES - ranges.length)) ranges.push(range)
    if (ranges.length >= MAX_FIND_MATCHES) break
  }
  return ranges
}

/** A live Range for a match, or null once its text has left the page. Offsets are held inside the
 *  text, in case the text shrank since the match was found. */
export function liveRangeOf(match: AbstractRange): Range | null {
  if (!match.startContainer.isConnected || !match.endContainer.isConnected) return null
  const range = document.createRange()
  range.setStart(match.startContainer, Math.min(match.startOffset, lengthOf(match.startContainer)))
  range.setEnd(match.endContainer, Math.min(match.endOffset, lengthOf(match.endContainer)))
  return range
}

export function paintFindHighlights(matches: AbstractRange[], currentIndex: number): void {
  const registry = highlightRegistry()
  if (!registry) return

  // Ranges are added one at a time: `new Highlight(...matches)` spreads them as arguments, and a
  // browser throws out of stack space when there are tens of thousands.
  const allMatches = new Highlight()
  for (const match of matches) allMatches.add(match)

  const currentHighlight = new Highlight()
  const currentMatch = matches[currentIndex]
  if (currentMatch) currentHighlight.add(currentMatch)
  currentHighlight.priority = 1

  registry.set(ALL_MATCHES_HIGHLIGHT, allMatches)
  registry.set(CURRENT_MATCH_HIGHLIGHT, currentHighlight)
}

// Scrolls to the match itself, not to the element holding it: one long paragraph or code block can
// hold hundreds of matches, and centring that element never moves as the match changes inside it.
// A thinking block, code block or tool output can scroll on its own, so those are moved first.
export function scrollMatchIntoView(match: AbstractRange, scroller: HTMLElement): void {
  const live = liveRangeOf(match)
  if (!live || live.getBoundingClientRect().height === 0) return

  scrollInnerScrollAreasToMatch(live, scroller)

  const matchBox = live.getBoundingClientRect()
  const matchMiddle = matchBox.top - scroller.getBoundingClientRect().top + scroller.scrollTop + matchBox.height / 2
  scroller.scrollTo({ top: matchMiddle - scroller.clientHeight / 2 })
}

export function clearFindHighlights(): void {
  const registry = highlightRegistry()
  registry?.delete(ALL_MATCHES_HIGHLIGHT)
  registry?.delete(CURRENT_MATCH_HIGHLIGHT)
}

function highlightRegistry(): HighlightRegistry | null {
  const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
  return supported ? CSS.highlights : null
}

function lengthOf(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length
}

function scrollInnerScrollAreasToMatch(match: Range, scroller: HTMLElement): void {
  for (let area = match.startContainer.parentElement; area && area !== scroller; area = area.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(area)
    const matchBox = match.getBoundingClientRect()
    const areaBox = area.getBoundingClientRect()
    if (scrolls(overflowY) && area.scrollHeight > area.clientHeight) {
      area.scrollTop += (matchBox.top + matchBox.height / 2) - (areaBox.top + areaBox.height / 2)
    }
    if (scrolls(overflowX) && area.scrollWidth > area.clientWidth) {
      area.scrollLeft += (matchBox.left + matchBox.width / 2) - (areaBox.left + areaBox.width / 2)
    }
  }
}

function scrolls(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll'
}

// Runs of text nodes that sit in the same block, in document order. Markdown splits one line across
// elements (bold, inline code, one span per syntax-highlighted token), so a phrase is searched for
// across the whole block, not one text node at a time. A line break ends a run: text either side of a
// <br> is on different lines.
function textNodesByBlock(root: Node): Text[][] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.TEXT_NODE) return isSearchable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      return node.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  const blocks: Text[][] = []
  // `undefined` means no run is open, which is different from a run whose block is `null` (no element above it).
  let currentBlock: Element | null | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') {
      currentBlock = undefined
      continue
    }
    const block = blockOf(node, root)
    if (block !== currentBlock) blocks.push([])
    currentBlock = block
    blocks[blocks.length - 1].push(node as Text)
  }
  return blocks
}

function isSearchable(node: Node): boolean {
  const parent = node.parentElement
  if (!parent) return true
  return !NON_PROSE_ELEMENTS.has(parent.tagName) && !parent.closest('[hidden]')
}

function blockOf(node: Node, root: Node): Element | null {
  let element = node.parentElement
  while (element && !BLOCK_ELEMENTS.has(element.tagName) && element !== root) element = element.parentElement
  return element
}

function matchRangesIn(block: Text[], pattern: RegExp, limit: number): StaticRange[] {
  const text = block.map((node) => node.data).join('')
  const starts: number[] = []
  let offset = 0
  for (const node of block) {
    starts.push(offset)
    offset += node.data.length
  }
  const ranges: StaticRange[] = []
  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= limit) break
    const first = nodeContaining(starts, match.index)
    const last = nodeContaining(starts, match.index + match[0].length - 1)
    ranges.push(new StaticRange({
      startContainer: block[first],
      startOffset: match.index - starts[first],
      endContainer: block[last],
      endOffset: match.index + match[0].length - starts[last],
    }))
  }
  return ranges
}

// The last text node that starts at or before this offset of the block's joined text.
function nodeContaining(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
