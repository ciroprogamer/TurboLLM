import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { clearFindHighlights, findTextRanges, liveRangeOf, MAX_FIND_MATCHES, paintFindHighlights, scrollMatchIntoView } from '../../lib/chat-find'

const STREAMING_REFRESH_DELAY_MS = 150

/** The match the reader is on, and its number, for finding their place again after the chat changes. */
interface CurrentMatch {
  match: StaticRange
  index: number
}

interface ChatFindBarProps {
  scrollerRef: RefObject<HTMLElement | null>
  focusRequest: number
  onClose: () => void
  /** Called just before find scrolls the chat to a match, so the screen knows the reader moved the view. */
  onReveal?: () => void
}

export function ChatFindBar({ scrollerRef, focusRequest, onClose, onReveal }: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { query, matches, currentIndex, search, step } = useChatFind(scrollerRef, onReveal)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    step(event.shiftKey ? -1 : 1)
  }

  // On the whole bar, not just the input: after clicking Next or Close the focus is on a button.
  const handleBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    // Always stop it here: the chat's own Escape handler stops a running reply. An Escape that only
    // cancels an input-method composition (Safari reports it as keyCode 229) must do neither.
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    onClose()
  }

  const nothingToStepTo = matches.length === 0

  return (
    <div role="search" onKeyDown={handleBarKeyDown} className="flex shrink-0 items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5 md:px-8">
      <Search size={14} className="shrink-0 text-muted" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => search(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint"
        style={{ outline: 'none' }}
      />
      <span data-testid="find-count" aria-live="polite" className="shrink-0 text-[12px] tabular-nums text-muted">
        {describeMatches(query, matches.length, currentIndex)}
      </span>
      <Button size="icon" variant="ghost" className="h-7 w-7" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={nothingToStepTo} onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7" title="Next match (Enter)" aria-label="Next match" disabled={nothingToStepTo} onClick={() => step(1)}>
        <ChevronDown size={14} />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7" title="Close (Esc)" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </Button>
    </div>
  )
}

function describeMatches(query: string, matchCount: number, currentIndex: number): string {
  if (!query) return ''
  if (matchCount === 0) return 'No results'
  const total = matchCount >= MAX_FIND_MATCHES ? `${matchCount}+` : `${matchCount}`
  return `${currentIndex + 1} of ${total}`
}

function useChatFind(scrollerRef: RefObject<HTMLElement | null>, onReveal: (() => void) | undefined) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<StaticRange[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const latestQuery = useRef('')
  const currentMatch = useRef<CurrentMatch | undefined>(undefined)

  const reveal = (match: StaticRange | undefined) => {
    const scroller = scrollerRef.current
    if (!match || !scroller) return
    onReveal?.()
    scrollMatchIntoView(match, scroller)
  }

  const search = (nextQuery: string) => {
    const found = findMatches(scrollerRef, nextQuery)
    latestQuery.current = nextQuery
    setQuery(nextQuery)
    setMatches(found)
    setCurrentIndex(0)
    reveal(found[0])
  }

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return
    const next = (currentIndex + direction + matches.length) % matches.length
    setCurrentIndex(next)
    reveal(matches[next])
  }

  useEffect(() => {
    return keepMatchesCurrent(scrollerRef, latestQuery, (found) => {
      setMatches(found)
      setCurrentIndex(indexOfMatchAtOrAfter(found, currentMatch.current))
    })
  }, [scrollerRef])

  useEffect(() => {
    const match = matches[currentIndex]
    currentMatch.current = match && { match, index: currentIndex }
  }, [matches, currentIndex])
  useEffect(() => { paintFindHighlights(matches, currentIndex) }, [matches, currentIndex])
  useEffect(() => clearFindHighlights, [])

  return { query, matches, currentIndex, search, step }
}

function findMatches(scrollerRef: RefObject<HTMLElement | null>, query: string): StaticRange[] {
  const scroller = scrollerRef.current
  return scroller ? findTextRanges(scroller, query) : []
}

// After the chat changes, stay on the match the reader was on (or the next one after it), not on the
// same number: new text above it shifts every number, and the highlight would silently move elsewhere.
function indexOfMatchAtOrAfter(found: StaticRange[], previous: CurrentMatch | undefined): number {
  if (!previous) return 0
  const where = liveRangeOf(previous.match)
  // Its text has left the page. A finished reply does that: it moves from the live bubble into the
  // message list, the same words in new nodes. Keep the number, which is right when the text is the same.
  if (!where) return Math.min(previous.index, Math.max(found.length - 1, 0))
  where.collapse(true)
  // Matches are in document order, so the first one starting at or after this point is found by halving.
  let low = 0
  let high = found.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (where.comparePoint(found[middle].startContainer, found[middle].startOffset) >= 0) high = middle
    else low = middle + 1
  }
  return low === found.length ? Math.max(found.length - 1, 0) : low
}

// New text keeps arriving while a reply streams, so the matches are refreshed as the chat changes.
// The refresh runs at most once per delay, not once things go quiet: tokens can arrive faster than
// that delay for the whole reply. It never scrolls: the view stays wherever the reader put it.
function keepMatchesCurrent(
  scrollerRef: RefObject<HTMLElement | null>,
  latestQuery: RefObject<string>,
  onMatches: (found: StaticRange[]) => void,
): () => void {
  const scroller = scrollerRef.current
  if (!scroller) return () => {}

  let pendingRefresh: number | undefined
  const observer = new MutationObserver(() => {
    if (pendingRefresh !== undefined) return
    pendingRefresh = window.setTimeout(() => {
      pendingRefresh = undefined
      onMatches(findMatches(scrollerRef, latestQuery.current))
    }, STREAMING_REFRESH_DELAY_MS)
  })
  observer.observe(scroller, { childList: true, subtree: true, characterData: true })

  return () => {
    observer.disconnect()
    window.clearTimeout(pendingRefresh)
  }
}
