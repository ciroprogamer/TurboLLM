// The editor for the two JSON inputs of a System One request (ADR-439). It tells the user, as they
// type, whether the text is valid JSON, and it never traps the keyboard: a Tab must move focus.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JsonEditor } from './JsonEditor'

type EditorProps = Parameters<typeof JsonEditor>[0]

const NEST_TOO_DEEP = 33
const HUGE_NESTING = 20000
const arraysNestedDeep = (depth: number) => '['.repeat(depth) + ']'.repeat(depth)

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

  it('shows hostile text as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)> {'
    const { container } = renderEditor({ mode: 'json', value: hostile })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/^Invalid JSON:/)).toBeInTheDocument()
  })
})
