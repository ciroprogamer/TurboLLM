const ALL_MATCHES_HIGHLIGHT = 'tllm-find'
const CURRENT_MATCH_HIGHLIGHT = 'tllm-find-active'
const NON_PROSE_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA'])

// A one-letter search in a very long chat can match tens of thousands of times, and every match is a
// live Range the browser must keep up to date as the DOM changes. Past this, more matches help no one.
export const MAX_FIND_MATCHES = 10_000

// Text in different blocks is never one phrase, however the DOM happens to order it.
const BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BUTTON', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

export function findTextRanges(root: Node, query: string): Range[] {
  if (!query) return []
  const pattern = new RegExp(escapeForRegExp(query), 'giu')
  const ranges: Range[] = []
  for (const block of textNodesByBlock(root)) {
    for (const range of matchRangesIn(block, pattern, MAX_FIND_MATCHES - ranges.length)) ranges.push(range)
    if (ranges.length >= MAX_FIND_MATCHES) break
  }
  return ranges
}

export function paintFindHighlights(matches: Range[], currentIndex: number): void {
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
export function scrollMatchIntoView(match: Range, scroller: HTMLElement): void {
  if (match.getBoundingClientRect().height === 0) return

  scrollInnerScrollAreasToMatch(match, scroller)

  const matchBox = match.getBoundingClientRect()
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
// across the whole block, not one text node at a time.
function textNodesByBlock(root: Node): Text[][] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSearchable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  const blocks: Text[][] = []
  let currentBlock: Element | null = null
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const block = blockOf(node, root)
    if (block !== currentBlock) blocks.push([])
    currentBlock = block
    blocks[blocks.length - 1].push(node)
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

function matchRangesIn(block: Text[], pattern: RegExp, limit: number): Range[] {
  const text = block.map((node) => node.data).join('')
  const starts: number[] = []
  let offset = 0
  for (const node of block) {
    starts.push(offset)
    offset += node.data.length
  }
  const ranges: Range[] = []
  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= limit) break
    const first = nodeContaining(starts, match.index)
    const last = nodeContaining(starts, match.index + match[0].length - 1)
    const range = document.createRange()
    range.setStart(block[first], match.index - starts[first])
    range.setEnd(block[last], match.index + match[0].length - starts[last])
    ranges.push(range)
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
