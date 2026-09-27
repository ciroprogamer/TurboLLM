// The questions of a System One request (ADR-439) as a form over the questions text. Typing in it must
// feel like typing: a keystroke never rebuilds the rows, while new text from outside (an example, a
// stored draft) always does.
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MAX_CHOICE_OPTIONS, MAX_QUESTIONS, MAX_SCORE_LEVELS } from '../../lib/systemone-types'
import { pretty } from './json-test-text'
import { QuestionsFormEditor } from './QuestionsFormEditor'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'

const URGENT = { type: 'noul', instructions: 'Does the message convey urgency?' }
const TEAM = { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments', technical: 'Bugs' } }
const MOOD = { type: 'score', instructions: "What is the customer's tone?", criteria: ['Calm', 'Annoyed', 'Angry'] }

/** The form as the playground holds it: each text it sends up comes back down as its value, and
 *  Load example replaces that value from outside, as the Example picker does. */
function HostedForm({ initial, example, onText, onValidityChange }: HostedFormProps) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <QuestionsFormEditor value={value} onChange={(next) => { setValue(next); onText(next) }} onValidityChange={onValidityChange} />
      <button type="button" onClick={() => setValue(example)}>Load example</button>
    </>
  )
}

interface HostedFormProps {
  initial: string
  example: string
  onText: (text: string) => void
  onValidityChange: (valid: boolean) => void
}

function renderHosted(questions: unknown, example: unknown = { mood: MOOD }) {
  const onText = vi.fn()
  const onValidityChange = vi.fn()
  const view = render(
    <HostedForm initial={pretty(questions)} example={pretty(example)} onText={onText} onValidityChange={onValidityChange} />,
  )
  const lastQuestions = (): unknown => JSON.parse(onText.mock.lastCall?.[0] ?? 'null')
  const lastValidity = (): boolean | undefined => onValidityChange.mock.lastCall?.[0]
  return { onText, lastQuestions, lastValidity, unmount: view.unmount }
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const question = (number: number): HTMLElement => screen.getByRole('group', { name: `Question ${number}` })
const fieldOf = (number: number, label: string): HTMLElement => within(question(number)).getByLabelText(label)
const questionIds = (): string[] =>
  screen.getAllByRole('group', { name: /^Question \d+$/ }).map((card) => (within(card).getByLabelText('id') as HTMLInputElement).value)

describe('QuestionsFormEditor', () => {
  it('shows a card per question, in order, with its id, its type and its instructions', () => {
    renderHosted({ urgent: URGENT, team: TEAM, mood: MOOD })
    expect(questionIds()).toEqual(['urgent', 'team', 'mood'])
    expect(fieldOf(1, 'type')).toHaveDisplayValue('Yes/no')
    expect(fieldOf(2, 'type')).toHaveDisplayValue('Pick one')
    expect(fieldOf(3, 'type')).toHaveDisplayValue('Scale')
    expect(fieldOf(3, 'instructions')).toHaveValue(MOOD.instructions)
  })

  it('offers the three types by the names a user knows them by', () => {
    renderHosted({ urgent: URGENT })
    const options = within(fieldOf(1, 'type')).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((option) => [option.value, option.textContent])).toEqual([
      ['noul', 'Yes/no'],
      ['choice', 'Pick one'],
      ['score', 'Scale'],
    ])
  })

  it('sends the whole questions text on every edit', () => {
    const { lastQuestions } = renderHosted({ urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(1, 'id'), { target: { value: 'urgency' } })
    expect(lastQuestions()).toEqual({ urgency: URGENT, team: TEAM })
  })

  // Re-reading the text on every render, or taking the form's own text coming back as new text, gives
  // every row a new key: React then replaces each field, and the focus is lost after one character.
  it.each([
    ['a question id', () => fieldOf(1, 'id')],
    ['the instructions', () => fieldOf(1, 'instructions')],
    ['an option name', () => fieldOf(2, 'Name of option 1 of team')],
    ['a level', () => fieldOf(3, 'Description of level 0 of mood')],
  ])('keeps the same field, and the focus in it, across keystrokes in %s', (_field, findField) => {
    renderHosted({ urgent: URGENT, team: TEAM, mood: MOOD })
    const typedInto = findField() as HTMLInputElement
    typedInto.focus()
    for (const keystroke of ['a', 'b', 'c']) {
      fireEvent.change(typedInto, { target: { value: typedInto.value + keystroke } })
      expect(findField()).toBe(typedInto)
      expect(document.activeElement).toBe(typedInto)
    }
    expect(typedInto.value).toMatch(/abc$/)
  })

  it('rebuilds the rows from new text given from outside, as picking an example does', () => {
    const onChange = vi.fn()
    const { rerender } = render(<QuestionsFormEditor value={pretty({ urgent: URGENT, team: TEAM })} onChange={onChange} />)
    rerender(<QuestionsFormEditor value={pretty({ mood: MOOD })} onChange={onChange} />)
    expect(questionIds()).toEqual(['mood'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rebuilds the rows again when the outside text goes back to an earlier text', () => {
    const onChange = vi.fn()
    const first = pretty({ urgent: URGENT, team: TEAM })
    const { rerender } = render(<QuestionsFormEditor value={first} onChange={onChange} />)
    rerender(<QuestionsFormEditor value={pretty({ mood: MOOD })} onChange={onChange} />)
    rerender(<QuestionsFormEditor value={first} onChange={onChange} />)
    expect(questionIds()).toEqual(['urgent', 'team'])
  })

  it('rebuilds the rows from an example loaded after the user has typed', async () => {
    renderHosted({ urgent: URGENT, team: TEAM }, { urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(1, 'id'), { target: { value: 'renamed' } })
    await userEvent.click(screen.getByRole('button', { name: 'Load example' }))
    expect(questionIds()).toEqual(['urgent', 'team'])
  })
})

describe('QuestionsFormEditor with a yes/no question', () => {
  const YES_LABEL = "What does 'yes' look like? Optional."
  const advanced = (name = 'urgent') => screen.getByRole('button', { name: `Advanced options for ${name}` })

  it('keeps the "yes" field behind Advanced, and has no field for "false" at all', async () => {
    renderHosted({ urgent: URGENT })
    expect(within(question(1)).queryByLabelText(YES_LABEL)).toBeNull()
    await userEvent.click(advanced())
    expect(fieldOf(1, YES_LABEL)).toHaveValue('')
    expect(within(question(1)).getAllByRole('textbox')).toEqual([fieldOf(1, 'id'), fieldOf(1, 'instructions'), fieldOf(1, YES_LABEL)])
  })

  it('writes the "yes" text as criteria.true, and leaves the criteria out once it is cleared', async () => {
    const { lastQuestions } = renderHosted({ urgent: URGENT })
    await userEvent.click(advanced())
    fireEvent.change(fieldOf(1, YES_LABEL), { target: { value: 'They are losing money now.' } })
    expect(lastQuestions()).toEqual({ urgent: { ...URGENT, criteria: { true: 'They are losing money now.' } } })
    fireEvent.change(fieldOf(1, YES_LABEL), { target: { value: '' } })
    expect(lastQuestions()).toEqual({ urgent: URGENT })
  })

  it('opens Advanced by itself when the question already has a "yes" text', () => {
    renderHosted({ urgent: { ...URGENT, criteria: { true: 'Losing money.' } } })
    expect(advanced()).toHaveAttribute('aria-expanded', 'true')
    expect(fieldOf(1, YES_LABEL)).toHaveValue('Losing money.')
  })

  it('names Advanced by the question\'s place while its id is blank', () => {
    renderHosted({ '': URGENT })
    expect(advanced('question 1')).toBeInTheDocument()
  })
})

describe('QuestionsFormEditor with a pick-one question', () => {
  it('shows each option as a name and a description, and writes an edit to either', () => {
    const { lastQuestions } = renderHosted({ team: TEAM })
    expect(fieldOf(1, 'Name of option 1 of team')).toHaveValue('billing')
    expect(fieldOf(1, 'Description of option 2 of team')).toHaveValue('Bugs')
    fireEvent.change(fieldOf(1, 'Name of option 1 of team'), { target: { value: 'payments' } })
    fireEvent.change(fieldOf(1, 'Description of option 2 of team'), { target: { value: 'Bugs and outages' } })
    expect(lastQuestions()).toEqual({ team: { ...TEAM, criteria: { payments: 'Payments', technical: 'Bugs and outages' } } })
  })

  it('adds a blank option, and removes options down to the minimum and no further', async () => {
    const { lastQuestions } = renderHosted({ team: TEAM })
    expect(button('Remove option 1 of team')).toBeDisabled()
    expect(button('Remove option 2 of team')).toBeDisabled()

    await userEvent.click(button('Add option to team'))
    expect(fieldOf(1, 'Name of option 3 of team')).toHaveValue('')
    await userEvent.click(button('Remove option 1 of team'))

    expect(fieldOf(1, 'Name of option 1 of team')).toHaveValue('technical')
    expect(lastQuestions()).toEqual({ team: { ...TEAM, criteria: { technical: 'Bugs', '': '' } } })
    expect(button('Remove option 1 of team')).toBeDisabled()
  })

  it(`stops adding options at ${MAX_CHOICE_OPTIONS}`, () => {
    const criteria = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS }, (_, index) => [`option ${index}`, '']))
    renderHosted({ team: { ...TEAM, criteria } })
    expect(button('Add option to team')).toBeDisabled()
  })
})

describe('QuestionsFormEditor with a scale', () => {
  it('shows each level beside its place on the scale, and writes an edit to one', () => {
    const { lastQuestions } = renderHosted({ mood: MOOD })
    expect(MOOD.criteria.map((_text, place) => (fieldOf(1, `Description of level ${place} of mood`) as HTMLInputElement).value)).toEqual(MOOD.criteria)
    expect(fieldOf(1, 'Description of level 2 of mood').parentElement).toHaveTextContent(/^2/)
    fireEvent.change(fieldOf(1, 'Description of level 1 of mood'), { target: { value: 'Mildly annoyed' } })
    expect(lastQuestions()).toEqual({ mood: { ...MOOD, criteria: ['Calm', 'Mildly annoyed', 'Angry'] } })
  })

  it('moves a level up or down the scale, but never past either end', async () => {
    const { lastQuestions } = renderHosted({ mood: MOOD })
    expect(button('Move level 0 of mood up')).toBeDisabled()
    expect(button('Move level 2 of mood down')).toBeDisabled()

    await userEvent.click(button('Move level 2 of mood up'))
    expect(lastQuestions()).toEqual({ mood: { ...MOOD, criteria: ['Calm', 'Angry', 'Annoyed'] } })
    await userEvent.click(button('Move level 0 of mood down'))
    expect(lastQuestions()).toEqual({ mood: { ...MOOD, criteria: ['Angry', 'Calm', 'Annoyed'] } })
    expect(fieldOf(1, 'Description of level 0 of mood')).toHaveValue('Angry')
  })

  it('removes levels down to the minimum and no further, and adds a blank one at the end', async () => {
    const { lastQuestions } = renderHosted({ mood: MOOD })
    await userEvent.click(button('Remove level 0 of mood'))
    expect(lastQuestions()).toEqual({ mood: { ...MOOD, criteria: ['Annoyed', 'Angry'] } })
    expect(button('Remove level 0 of mood')).toBeDisabled()

    await userEvent.click(button('Add level to mood'))
    expect(fieldOf(1, 'Description of level 2 of mood')).toHaveValue('')
    expect(lastQuestions()).toEqual({ mood: { ...MOOD, criteria: ['Annoyed', 'Angry', ''] } })
  })

  it(`stops adding levels at ${MAX_SCORE_LEVELS}`, () => {
    renderHosted({ mood: { ...MOOD, criteria: Array.from({ length: MAX_SCORE_LEVELS }, (_, place) => `Level ${place}`) } })
    expect(button('Add level to mood')).toBeDisabled()
  })
})

describe('QuestionsFormEditor changing a question\'s type', () => {
  it('keeps the instructions, and the options the question held, through a change of type and back', () => {
    const { lastQuestions } = renderHosted({ team: TEAM })
    fireEvent.change(fieldOf(1, 'type'), { target: { value: 'score' } })
    expect(within(question(1)).queryByLabelText('Name of option 1 of team')).toBeNull()
    expect(fieldOf(1, 'instructions')).toHaveValue(TEAM.instructions)
    expect(lastQuestions()).toEqual({ team: { type: 'score', instructions: TEAM.instructions, criteria: ['', ''] } })

    fireEvent.change(fieldOf(1, 'type'), { target: { value: 'choice' } })
    expect(fieldOf(1, 'Name of option 1 of team')).toHaveValue('billing')
    expect(lastQuestions()).toEqual({ team: TEAM })
  })

  it('gives a question read without options two blank ones as soon as it becomes pick-one', () => {
    renderHosted({ urgent: URGENT })
    fireEvent.change(fieldOf(1, 'type'), { target: { value: 'choice' } })
    expect(fieldOf(1, 'Name of option 1 of urgent')).toHaveValue('')
    expect(fieldOf(1, 'Name of option 2 of urgent')).toHaveValue('')
  })
})

describe('QuestionsFormEditor adding and removing questions', () => {
  it('will not remove the only question', () => {
    renderHosted({ urgent: URGENT })
    expect(button('Remove question 1')).toBeDisabled()
  })

  it('removes a question while there is more than one', async () => {
    const { lastQuestions } = renderHosted({ urgent: URGENT, team: TEAM })
    await userEvent.click(button('Remove question 1'))
    expect(questionIds()).toEqual(['team'])
    expect(lastQuestions()).toEqual({ team: TEAM })
    expect(button('Remove question 1')).toBeDisabled()
  })

  it('adds a blank yes/no question, whose two blank options are there as soon as it becomes pick-one', async () => {
    const { lastQuestions } = renderHosted({ urgent: URGENT })
    await userEvent.click(button('Add question'))
    expect(questionIds()).toEqual(['urgent', ''])
    expect(fieldOf(2, 'type')).toHaveDisplayValue('Yes/no')
    expect(lastQuestions()).toEqual({ urgent: URGENT, '': { type: 'noul', instructions: '' } })

    fireEvent.change(fieldOf(2, 'type'), { target: { value: 'choice' } })
    expect(fieldOf(2, 'Name of option 1 of question 2')).toHaveValue('')
    expect(fieldOf(2, 'Name of option 2 of question 2')).toHaveValue('')
  })

  it(`stops adding questions at ${MAX_QUESTIONS}`, () => {
    renderHosted(Object.fromEntries(Array.from({ length: MAX_QUESTIONS }, (_, index) => [`q${index}`, URGENT])))
    expect(button('Add question')).toBeDisabled()
  })
})

// The text holds one question per id and one option per name, so a repeated one would send less than
// the cards show. It is said at once, where it is, and the form reports itself unfit to run.
describe('QuestionsFormEditor with a repeated id or option name', () => {
  const SHARED_ID = 'Another question has this id too. Each question needs an id of its own.'
  const SHARED_OPTION_NAME = 'Some options have the same name. Each option needs a name of its own.'

  it('warns on both questions at once when two share an id, and reports itself invalid', () => {
    const { lastValidity } = renderHosted({ urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(2, 'id'), { target: { value: 'urgent' } })
    expect(within(question(1)).getByRole('alert')).toHaveTextContent(SHARED_ID)
    expect(within(question(2)).getByRole('alert')).toHaveTextContent(SHARED_ID)
    expect(lastValidity()).toBe(false)
  })

  it('stops warning, and reports itself valid, once the id is made unique again', () => {
    const { lastValidity } = renderHosted({ urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(2, 'id'), { target: { value: 'urgent' } })
    fireEvent.change(fieldOf(2, 'id'), { target: { value: 'routing' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(lastValidity()).toBe(true)
  })

  it('warns on a pick-one question two of whose options share a name, and reports itself invalid', () => {
    const { lastValidity } = renderHosted({ urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(2, 'Name of option 2 of team'), { target: { value: 'billing' } })
    expect(within(question(2)).getByRole('alert')).toHaveTextContent(SHARED_OPTION_NAME)
    expect(within(question(1)).queryByRole('alert')).toBeNull()
    expect(lastValidity()).toBe(false)
  })

  it('holds nothing back once it is gone', () => {
    const { lastValidity, unmount } = renderHosted({ urgent: URGENT, team: TEAM })
    fireEvent.change(fieldOf(2, 'id'), { target: { value: 'urgent' } })
    unmount()
    expect(lastValidity()).toBe(true)
  })

  it.each(SYSTEMONE_EXAMPLES.map((example) => [example.label, example.questionsText]))(
    'shows no warning, and reports itself valid, for the example "%s"',
    (_label, questionsText) => {
      const onValidityChange = vi.fn()
      render(<QuestionsFormEditor value={questionsText} onChange={vi.fn()} onValidityChange={onValidityChange} />)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(onValidityChange).toHaveBeenLastCalledWith(true)
    },
  )
})

describe('QuestionsFormEditor showing a problem', () => {
  it('shows the rule failure once, as an alert after everything else, and nothing without one', () => {
    const problem = 'questions.team.criteria must be an object of 2 to 255 options.'
    const value = pretty({ urgent: URGENT })
    const { rerender } = render(<QuestionsFormEditor value={value} onChange={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<QuestionsFormEditor value={value} onChange={vi.fn()} problem={problem} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(problem)
    expect(button('Add question').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
