// One JSON input of a System One request (ADR-439): a plain textarea with a live status line.
// There is no editor library on purpose (nothing new is added to the web app). Tab indents instead
// of moving focus, the usual code-editor convention; Shift+Tab is left alone as the escape hatch, so
// the control is never a full keyboard trap.
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Button } from '../../components/ui/button'
import { jsonDepth, MAX_NESTING_DEPTH } from '../../lib/systemone-types'

interface JsonEditorProps {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  mode: 'json' | 'json-or-text'
  problem?: string
  caption?: string
}

type Inspection =
  | { valid: true; value: unknown; formattable: boolean }
  | { valid: false; error: string }

type Status = { text: string; invalid: boolean }

const VALID_STATUS = 'Valid JSON'
const PLAIN_TEXT_STATUS = 'Plain text – sent as a string.'

const TAB_INDENT = '  '

export function JsonEditor({ id, label, value, onChange, mode, problem, caption }: JsonEditorProps) {
  const inspection = useMemo(() => inspectJson(value), [value])
  const status = describeStatus(mode, value, inspection)
  const canFormat = inspection.valid && inspection.formattable
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
   *  when it would be a no-op (already formatted) or unsafe (unformattable), exactly Format's own rule. */
  function formatOnBlur() {
    if (!canFormat || !inspection.valid) return
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
      <label htmlFor={id} className="col-start-1 row-start-1 text-[12px] font-medium text-muted">
        {label}
      </label>
      <textarea
        id={id}
        ref={textareaRef}
        className="col-span-2 row-start-2 min-h-[140px] w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent placeholder:text-faint"
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
    </div>
  )
}

/** Parses once and also decides whether a pretty-print is safe: a value nested past the limit
 *  could overflow the stack when printed, and the request rules refuse it anyway. */
function inspectJson(text: string): Inspection {
  try {
    const value: unknown = JSON.parse(text)
    return { valid: true, value, formattable: jsonDepth(value, MAX_NESTING_DEPTH) <= MAX_NESTING_DEPTH }
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
