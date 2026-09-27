// The editor for the two JSON inputs of a System One request (ADR-439). It tells the user, as they
// type, whether the text is valid JSON, and it never traps the keyboard: a Tab must move focus.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EditorFrame, JsonEditor, JsonEditorBody } from './JsonEditor'
import { arraysNestedDeep } from './json-test-text'

type EditorProps = Parameters<typeof JsonEditor>[0]

const NEST_TOO_DEEP = 33
const HUGE_NESTING = 20000

function renderEditor(overrides: Partial<EditorProps> = {}) {
  const onChange = vi.fn()
  const props: EditorProps = { id: 'state', label: 'state', value: '', onChange, mode: 'json', ...overrides }
  const view = render(<JsonEditor {...props} />)
  const rerenderWith = (next: Partial<EditorProps>) => view.rerender(<JsonEditor {...props} {...next} />)
  return { onChange, rerenderWith, ...view }
}

const formatButton = (label = 'state') => screen.getByRole('button', { name: `Format ${label}` })

describe('JsonEditor', () => {
  it('is reachable by its label, shows the value and reports typed text', () => {
    const { onChange } = renderEditor({ value: 'abc' })
    const textarea = screen.getByLabelText('state') as HTMLTextAreaElement
    expect(textarea.value).toBe('abc')
    fireEvent.change(textarea, { target: { value: 'abcd' } })
    expect(onChange).toHaveBeenCalledWith('abcd')
  })

  it('says Valid JSON for valid text in json mode', () => {
    renderEditor({ mode: 'json', value: '{"a":1}' })
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
  })

  it('names the fault, with its line and column shown exactly once, for invalid text in json mode', () => {
    renderEditor({ mode: 'json', value: '{\n  "a": 1,\n}' })
    const status = screen.getByText(/^Invalid JSON:/)
    expect(status.textContent).toMatch(/line 3, column 1/)
    expect(status.textContent?.match(/line 3/g)).toHaveLength(1)
  })

  it('leaves the position out when the parse error carries none', () => {
    renderEditor({ mode: 'json', value: 'I was charged twice.' })
    const status = screen.getByText(/^Invalid JSON:/)
    expect(status.textContent).not.toMatch(/line \d/)
  })

  it('accepts plain text in json-or-text mode and says it is sent as a string', () => {
    const { rerenderWith } = renderEditor({ mode: 'json-or-text', value: 'I was charged twice.' })
    expect(screen.getByText('Plain text – sent as a string.')).toBeInTheDocument()
    rerenderWith({ value: '{"a":1}' })
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
    rerenderWith({ value: '42' })
    expect(screen.getByText('Plain text – sent as a string.')).toBeInTheDocument()
  })

  it('treats null, true and invalid JSON as plain text in json-or-text mode, and a string as valid', () => {
    const { rerenderWith } = renderEditor({ mode: 'json-or-text', value: 'null' })
    expect(screen.getByText('Plain text – sent as a string.')).toBeInTheDocument()
    rerenderWith({ value: 'true' })
    expect(screen.getByText('Plain text – sent as a string.')).toBeInTheDocument()
    rerenderWith({ value: '{oops' })
    expect(screen.getByText('Plain text – sent as a string.')).toBeInTheDocument()
    rerenderWith({ value: '"already a string"' })
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
  })

  it('disables Format for invalid text and, for valid text, replaces it with the two-space pretty print', () => {
    const { onChange, rerenderWith } = renderEditor({ value: '{oops' })
    expect(formatButton()).toBeDisabled()
    rerenderWith({ value: '{"a":1}' })
    expect(formatButton()).toBeEnabled()
    fireEvent.click(formatButton())
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('announces the status politely and stops the browser from correcting the text', () => {
    renderEditor({ value: '{"a":1}' })
    const textarea = screen.getByLabelText('state')
    const status = screen.getByText('Valid JSON')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status.id).not.toBe('')
    expect(textarea).toHaveAttribute('aria-describedby', status.id)
    expect(textarea).toHaveAttribute('spellcheck', 'false')
    expect(textarea).toHaveAttribute('autocorrect', 'off')
    expect(textarea).toHaveAttribute('autocapitalize', 'off')
    expect(textarea).toHaveAttribute('data-gramm', 'false')
  })

  it('inserts an indent at the caret on Tab, instead of moving focus off the editor', () => {
    const { onChange } = renderEditor({ value: '{"a":1}' })
    const textarea = screen.getByLabelText('state') as HTMLTextAreaElement
    textarea.setSelectionRange(1, 1) // right after the opening brace
    const notPrevented = fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(notPrevented).toBe(false)
    expect(onChange).toHaveBeenCalledWith('{  "a":1}')
  })

  it('replaces a selection with the indent on Tab, like typing over it', () => {
    const { onChange } = renderEditor({ value: '{"a":1}' })
    const textarea = screen.getByLabelText('state') as HTMLTextAreaElement
    textarea.setSelectionRange(1, 4) // the selected '"a"'
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(onChange).toHaveBeenCalledWith('{  :1}')
  })

  it('leaves Shift+Tab alone, so focus can still move backward out of the editor', () => {
    const { onChange } = renderEditor({ value: '{"a":1}' })
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('state'), { key: 'Tab', shiftKey: true })
    expect(notPrevented).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows a rule failure with role alert under valid text, and nothing without one', () => {
    const problem = 'questions.q.type must be one of noul, choice, score'
    const { rerenderWith } = renderEditor({ mode: 'json', value: '{"a":1}' })
    expect(screen.queryByRole('alert')).toBeNull()
    rerenderWith({ problem })
    expect(screen.getByRole('alert')).toHaveTextContent(problem)
  })

  it('gives each of two editors on a page its own Format button', () => {
    render(
      <>
        <JsonEditor id="state" label="state" value="{}" onChange={vi.fn()} mode="json-or-text" />
        <JsonEditor id="questions" label="questions" value="{}" onChange={vi.fn()} mode="json" />
      </>,
    )
    expect(formatButton('state')).toBeInTheDocument()
    expect(formatButton('questions')).toBeInTheDocument()
  })

  it('puts Format after the textarea in the document, so Tab goes from the editor to Format', () => {
    renderEditor({ value: '{"a":1}' })
    const follows = screen.getByLabelText('state').compareDocumentPosition(formatButton())
    expect(follows & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives the textarea the full width of its row', () => {
    renderEditor({ value: '{"a":1}' })
    expect(screen.getByLabelText('state')).toHaveClass('w-full')
  })

  it('refuses to pretty-print a value nested past the limit, without changing its status', () => {
    renderEditor({ mode: 'json', value: arraysNestedDeep(NEST_TOO_DEEP) })
    expect(formatButton()).toBeDisabled()
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
  })

  it('renders a value nested twenty thousand deep without throwing', () => {
    expect(() => renderEditor({ mode: 'json', value: arraysNestedDeep(HUGE_NESTING) })).not.toThrow()
    expect(formatButton()).toBeDisabled()
  })

  it('shows one message per fault: the status for unparseable text, the rule failure for valid text', () => {
    const problem = 'questions is not valid JSON: x'
    const { rerenderWith } = renderEditor({ mode: 'json', value: '{oops', problem })
    expect(screen.getByText(/^Invalid JSON:/)).toBeInTheDocument()
    expect(screen.queryByText(problem)).toBeNull()
    rerenderWith({ value: '{"a":1}' })
    expect(screen.getByText(problem)).toBeInTheDocument()
  })

  it('renders the caption when given and nothing when not', () => {
    const caption = 'JSON object or array, or plain text.'
    const { rerenderWith } = renderEditor({ mode: 'json-or-text', value: 'x' })
    expect(screen.queryByText(caption)).toBeNull()
    rerenderWith({ caption })
    expect(screen.getByText(caption)).toBeInTheDocument()
  })

  it('formats valid JSON automatically when the editor loses focus, so Format is not the only way', () => {
    const { onChange } = renderEditor({ value: '{"a":1}' })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('does not call onChange on blur when the text is already formatted', () => {
    const { onChange } = renderEditor({ value: '{\n  "a": 1\n}' })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves invalid JSON alone on blur, in either mode', () => {
    const { onChange, rerenderWith } = renderEditor({ mode: 'json', value: '{oops' })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
    rerenderWith({ mode: 'json-or-text', value: 'I was charged twice.' })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not reformat on blur a value nested past the limit, the same case Format itself refuses', () => {
    const { onChange } = renderEditor({ mode: 'json', value: arraysNestedDeep(NEST_TOO_DEEP) })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
  })

  // A json-or-text field sends a bare number/boolean/null as the literal STRING typed (stateFromText
  // keeps text unless it parses to an object, array or string) — reformatting it would silently swap
  // the sent value from that string to the parsed number. Reported live: '1.50' became '1.5' on blur.
  it.each(['1.50', 'true', 'null'])(
    'disables Format, and does not reformat on blur, for the bare literal %s in json-or-text mode',
    (value) => {
      const { onChange } = renderEditor({ mode: 'json-or-text', value })
      expect(formatButton()).toBeDisabled()
      fireEvent.blur(screen.getByLabelText('state'))
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('still formats an object, array or string in json-or-text mode, where the parsed value is what is sent', () => {
    const { onChange } = renderEditor({ mode: 'json-or-text', value: '{"a":1}' })
    expect(formatButton()).toBeEnabled()
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  // Reported live: pasting a second question over an unrenamed id, then clicking elsewhere, silently
  // dropped the first one from the visible text with no chance to notice before it was gone.
  it('does not reformat a duplicate key away on blur, only on an explicit Format click', () => {
    const duplicate = '{\n  "a": 1,\n  "a": 2\n}'
    const { onChange, rerenderWith } = renderEditor({ mode: 'json', value: duplicate })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
    rerenderWith({ value: duplicate })
    expect(formatButton()).toBeEnabled()
    fireEvent.click(formatButton())
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 2\n}')
  })

  it('does not mistake a string value equal to a key name for a second key', () => {
    const value = '{"a":"a","b":2}'
    const { onChange } = renderEditor({ mode: 'json', value })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).toHaveBeenCalledWith('{\n  "a": "a",\n  "b": 2\n}')
  })

  it('still catches a real duplicate key even when an earlier value is the string form of that key', () => {
    const value = '{"a":"a","a":1}'
    const { onChange } = renderEditor({ mode: 'json', value })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('catches a duplicate key hidden behind a different escaping of the same character', () => {
    const value = '{"a":1,"\\u0061":2}'
    const { onChange } = renderEditor({ mode: 'json', value })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not mistake the same key name reused in two different objects for a duplicate', () => {
    const minified = '{"q":{"a":1},"q2":{"a":1}}'
    const { onChange } = renderEditor({ mode: 'json', value: minified })
    fireEvent.blur(screen.getByLabelText('state'))
    expect(onChange).toHaveBeenCalledWith('{\n  "q": {\n    "a": 1\n  },\n  "q2": {\n    "a": 1\n  }\n}')
  })

  // The questions field keeps one label row across its JSON and form views, so it heads the editor's
  // body itself rather than letting the editor draw a second one.
  it('lets a page head the editor with a label row of its own, before the textarea and beside Format', () => {
    const header = (
      <>
        <label htmlFor="questions">questions</label>
        <button type="button">Switch view</button>
      </>
    )
    render(
      <EditorFrame header={header}>
        <JsonEditorBody id="questions" label="questions" value={'{"a":1}'} onChange={vi.fn()} mode="json" />
      </EditorFrame>,
    )
    const toggle = screen.getByRole('button', { name: 'Switch view' })
    expect(screen.getAllByText('questions', { selector: 'label' })).toHaveLength(1)
    expect(toggle.parentElement).toContainElement(screen.getByText('questions', { selector: 'label' }))
    expect(toggle.compareDocumentPosition(screen.getByLabelText('questions')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(formatButton('questions')).toBeEnabled()
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
  })

  it('shows hostile text as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)> {'
    const { container } = renderEditor({ mode: 'json', value: hostile })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/^Invalid JSON:/)).toBeInTheDocument()
  })
})
