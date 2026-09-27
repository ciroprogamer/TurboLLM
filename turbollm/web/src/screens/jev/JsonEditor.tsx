// One JSON input of a System One request (ADR-439): a plain textarea with a live status line.
// There is no editor library on purpose (nothing new is added to the web app). Tab indents instead
// of moving focus, the usual code-editor convention; Shift+Tab is left alone as the escape hatch, so
// the control is never a full keyboard trap.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { Button } from '../../components/ui/button'
import { cn } from '../../lib/utils'
import { isTooDeep } from './systemone-draft'

interface JsonEditorProps {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  mode: 'json' | 'json-or-text'
  problem?: string
  caption?: string
}

/** Tab is captured here to indent (see `onKeyDown` below), so the field's caption must say how to
 *  still leave it by keyboard — WCAG 2.1.2 requires the escape route be disclosed, not just exist. */
export const TAB_INDENT_HINT = 'Shift+Tab moves to the next field.'

/** The look the request's fields share, so the questions form and the Example picker beside these
 *  editors read as one page. */
export const labelCls = 'text-[12px] font-medium text-muted'
export const selectCls = 'max-w-[210px] rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink'
export const textareaCls =
  'w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-[12px] leading-relaxed text-ink outline-none focus:border-accent placeholder:text-faint'

type Inspection =
  | { valid: true; value: unknown; formattable: boolean }
  | { valid: false; error: string }

type Status = { text: string; invalid: boolean }

const VALID_STATUS = 'Valid JSON'
const PLAIN_TEXT_STATUS = 'Plain text – sent as a string.'

const TAB_INDENT = '  '

export function JsonEditor(props: JsonEditorProps) {
  const header = (
    <label htmlFor={props.id} className={labelCls}>
      {props.label}
    </label>
  )
  return (
    <EditorFrame header={header}>
      <JsonEditorBody {...props} />
    </EditorFrame>
  )
}

/** An editor's grid: the header row on top, which a page may fill with more than the label, such as a
 *  toggle to another view of the same text; Format beside it, and the body below. */
export function EditorFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
      <div className="col-start-1 row-start-1 flex flex-wrap items-center gap-2">{header}</div>
      {children}
    </div>
  )
}

/** Everything of the editor but its header row, for an `EditorFrame` whose header the page draws. */
export function JsonEditorBody({ id, label, value, onChange, mode, problem, caption }: JsonEditorProps) {
  const inspection = useMemo(() => inspectJson(value), [value])
  const status = describeStatus(mode, value, inspection)
  const canFormat = inspection.valid && inspection.formattable && sendsThePrettyPrint(mode, inspection.value)
  const statusId = `${id}-status`
  // The status line already says why unparseable text is wrong: one message per fault, not two.
  const shownProblem = status.invalid ? undefined : problem

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  // Restoring the caret has to wait for the value we just sent up to come back down as this
  // textarea's own prop; doing it inline in the key handler would set it right before React
  // overwrites the DOM value and moves the caret to the end.
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    textareaRef.current?.setSelectionRange(caret, caret)
  }, [value])

  function format() {
    if (inspection.valid) onChange(JSON.stringify(inspection.value, null, 2))
  }

  /** The same reformat Format runs, so leaving the editor tidies valid JSON without a click. Skipped
   *  when it would be a no-op (already formatted) or unsafe (unformattable), exactly Format's own rule
   *  — and, only for this automatic trigger, when the text has a duplicate key: reformatting collapses
   *  it to whichever value JSON.parse kept, and an unwatched click away must never be what does that. */
  function formatOnBlur() {
    if (!canFormat || !inspection.valid || hasDuplicateKeys(value)) return
    const formatted = JSON.stringify(inspection.value, null, 2)
    if (formatted !== value) onChange(formatted)
  }

  /** Tab inserts an indent, as in a code editor, rather than leaving the field: JSON is typed here
   *  more than it is tabbed past. Shift+Tab is untouched, so leaving backward always still works. */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab' || event.shiftKey) return
    event.preventDefault()
    const el = event.currentTarget
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    pendingCaret.current = start + TAB_INDENT.length
    onChange(value.slice(0, start) + TAB_INDENT + value.slice(end))
  }

  return (
    <>
      <textarea
        id={id}
        ref={textareaRef}
        className={cn(textareaCls, 'col-span-2 row-start-2 min-h-[140px] font-mono')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={formatOnBlur}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        data-gramm="false"
        aria-describedby={statusId}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="col-start-2 row-start-1"
        aria-label={`Format ${label}`}
        disabled={!canFormat}
        onClick={format}
      >
        Format
      </Button>
      {caption && <p className="col-span-2 row-start-3 text-[12px] text-muted">{caption}</p>}
      <p id={statusId} aria-live="polite" className="col-span-2 row-start-4 text-[12px] text-muted">
        {status.text}
      </p>
      {shownProblem && (
        <p role="alert" className="col-span-2 row-start-5 text-[13px] text-err">
          {shownProblem}
        </p>
      )}
    </>
  )
}

/** Parses once and also decides whether a pretty-print is safe: a value nested past the limit
 *  could overflow the stack when printed, and the request rules refuse it anyway. */
function inspectJson(text: string): Inspection {
  try {
    const value: unknown = JSON.parse(text)
    return { valid: true, value, formattable: !isTooDeep(value) }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function describeStatus(mode: JsonEditorProps['mode'], text: string, inspection: Inspection): Status {
  if (mode === 'json') {
    return inspection.valid
      ? { text: VALID_STATUS, invalid: false }
      : { text: invalidJsonStatus(text, inspection.error), invalid: true }
  }
  const sentAsJson = inspection.valid && isObjectArrayOrString(inspection.value)
  return { text: sentAsJson ? VALID_STATUS : PLAIN_TEXT_STATUS, invalid: false }
}

function isObjectArrayOrString(value: unknown): boolean {
  return typeof value === 'string' || (typeof value === 'object' && value !== null)
}

/** In json-or-text mode, a bare number/boolean/null is sent as the literal text typed (stateFromText
 *  keeps it as a string unless it parses to an object, array or string) — pretty-printing it would swap
 *  the parsed number back in, silently sending a different value than what is on screen. In plain json
 *  mode the parsed value is always what is sent, so reformatting is always safe. */
function sendsThePrettyPrint(mode: JsonEditorProps['mode'], value: unknown): boolean {
  return mode === 'json' || isObjectArrayOrString(value)
}

type Container = 'object' | 'array'

/** Whether any one object literal in `text` names the same key twice. `JSON.parse`'s own reviver cannot
 *  answer this — by the time it runs, the object is already built with the duplicate collapsed away — so
 *  this walks the raw text itself: a small bracket- and string-aware scan, not a full JSON parser, since
 *  `text` is only ever passed here once `JSON.parse` has already accepted it. */
function hasDuplicateKeys(text: string): boolean {
  const containers: Container[] = []
  const seenKeysByDepth: Set<string>[] = []
  let atMemberStart = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) { i++; continue }
    if (char === '{') { containers.push('object'); seenKeysByDepth.push(new Set()); atMemberStart = true; i++; continue }
    if (char === '[') { containers.push('array'); seenKeysByDepth.push(new Set()); atMemberStart = false; i++; continue }
    if (char === '}' || char === ']') { containers.pop(); seenKeysByDepth.pop(); atMemberStart = false; i++; continue }
    if (char === ',') { atMemberStart = containers.at(-1) === 'object'; i++; continue }
    if (char === '"') {
      const isKey = atMemberStart && containers.at(-1) === 'object'
      const { text: literal, end } = readJsonString(text, i)
      i = end
      if (isKey) {
        const seen = seenKeysByDepth.at(-1)
        if (seen?.has(literal)) return true
        seen?.add(literal)
        i = skipToAfterColon(text, i)
      }
      atMemberStart = false
      continue
    }
    atMemberStart = false
    i++
  }
  return false
}

/** The raw (still-escaped) text of the string starting at `text[start]` (a `"`), and the index just past
 *  its closing quote. The escaped form is enough to tell two keys apart; it never needs decoding here. */
function readJsonString(text: string, start: number): { text: string; end: number } {
  let i = start + 1
  let literal = ''
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\') { literal += text[i] + (text[i + 1] ?? ''); i += 2; continue }
    literal += text[i]
    i++
  }
  return { text: literal, end: i + 1 }
}

function skipToAfterColon(text: string, from: number): number {
  let i = from
  while (i < text.length && text[i] !== ':') i++
  return i + 1
}

const ENGINE_LINE_AND_COLUMN = / \(line \d+ column \d+\)$/
const POSITION_AT_END = /position (\d+)$/

/** The engine's own message ends with its own " (line N column M)" on some versions; it is
 *  replaced, not added to, so the position shows exactly once. */
function invalidJsonStatus(text: string, error: string): string {
  const message = error.replace(ENGINE_LINE_AND_COLUMN, '')
  const position = POSITION_AT_END.exec(message)
  if (position === null) return `Invalid JSON: ${message}`
  const { line, column } = lineAndColumnOf(text, Number(position[1]))
  return `Invalid JSON: ${message} (line ${line}, column ${column})`
}

function lineAndColumnOf(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, position)
  return { line: before.split('\n').length, column: position - before.lastIndexOf('\n') }
}
