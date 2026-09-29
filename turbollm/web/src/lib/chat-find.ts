const ALL_MATCHES_HIGHLIGHT = 'tllm-find'
const CURRENT_MATCH_HIGHLIGHT = 'tllm-find-active'
const NON_PROSE_ELEMENTS = new Set(['SCRIPT', 'STYLE'])

export function findTextRanges(root: Node, query: string): Range[] {
  if (!query) return []
  const pattern = new RegExp(escapeForRegExp(query), 'giu')
  return textNodesUnder(root).flatMap((textNode) => matchRangesIn(textNode, pattern))
}

export function paintFindHighlights(matches: Range[], currentIndex: number): void {
  const registry = highlightRegistry()
  if (!registry) return

  const currentMatch = matches[currentIndex]
  const currentHighlight = new Highlight(...(currentMatch ? [currentMatch] : []))
  currentHighlight.priority = 1

  registry.set(ALL_MATCHES_HIGHLIGHT, new Highlight(...matches))
  registry.set(CURRENT_MATCH_HIGHLIGHT, currentHighlight)
}

export function scrollMatchIntoView(match: Range): void {
  match.startContainer.parentElement?.scrollIntoView({ block: 'center' })
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

function textNodesUnder(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isProse(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)
  return textNodes
}

function isProse(node: Node): boolean {
  const parent = node.parentElement
  return !parent || !NON_PROSE_ELEMENTS.has(parent.tagName)
}

function matchRangesIn(textNode: Text, pattern: RegExp): Range[] {
  return [...textNode.data.matchAll(pattern)].map((match) => {
    const range = document.createRange()
    range.setStart(textNode, match.index)
    range.setEnd(textNode, match.index + match[0].length)
    return range
  })
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
