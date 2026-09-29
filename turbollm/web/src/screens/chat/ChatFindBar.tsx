import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { clearFindHighlights, findTextRanges, paintFindHighlights, scrollMatchIntoView } from '../../lib/chat-find'

const STREAMING_REFRESH_DELAY_MS = 150

interface ChatFindBarProps {
  scrollerRef: RefObject<HTMLElement | null>
  focusRequest: number
  onClose: () => void
}

export function ChatFindBar({ scrollerRef, focusRequest, onClose }: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { query, matches, currentIndex, search, step } = useChatFind(scrollerRef)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  const nothingToStepTo = matches.length === 0

  return (
    <div role="search" className="flex shrink-0 items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5 md:px-8">
      <Search size={14} className="shrink-0 text-muted" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => search(event.target.value)}
        onKeyDown={handleKeyDown}
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
  return matchCount === 0 ? 'No results' : `${currentIndex + 1} of ${matchCount}`
}

function useChatFind(scrollerRef: RefObject<HTMLElement | null>) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const latestQuery = useRef('')

  const search = (nextQuery: string) => {
    const found = findMatches(scrollerRef, nextQuery)
    latestQuery.current = nextQuery
    setQuery(nextQuery)
    setMatches(found)
    setCurrentIndex(0)
    if (found[0]) scrollMatchIntoView(found[0])
  }

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return
    const next = (currentIndex + direction + matches.length) % matches.length
    setCurrentIndex(next)
    scrollMatchIntoView(matches[next])
  }

  useEffect(() => {
    return keepMatchesCurrent(scrollerRef, latestQuery, (found) => {
      setMatches(found)
      setCurrentIndex((index) => Math.min(index, Math.max(found.length - 1, 0)))
    })
  }, [scrollerRef])

  useEffect(() => { paintFindHighlights(matches, currentIndex) }, [matches, currentIndex])
  useEffect(() => clearFindHighlights, [])

  return { query, matches, currentIndex, search, step }
}

function findMatches(scrollerRef: RefObject<HTMLElement | null>, query: string): Range[] {
  const scroller = scrollerRef.current
  return scroller ? findTextRanges(scroller, query) : []
}

// New text keeps arriving while a reply streams, so the matches are refreshed as the chat changes.
// This never scrolls: the view stays wherever the reader put it.
function keepMatchesCurrent(
  scrollerRef: RefObject<HTMLElement | null>,
  latestQuery: RefObject<string>,
  onMatches: (found: Range[]) => void,
): () => void {
  const scroller = scrollerRef.current
  if (!scroller) return () => {}

  let pendingRefresh: number | undefined
  const observer = new MutationObserver(() => {
    window.clearTimeout(pendingRefresh)
    pendingRefresh = window.setTimeout(() => onMatches(findMatches(scrollerRef, latestQuery.current)), STREAMING_REFRESH_DELAY_MS)
  })
  observer.observe(scroller, { childList: true, subtree: true, characterData: true })

  return () => {
    observer.disconnect()
    window.clearTimeout(pendingRefresh)
  }
}
