// The questions of a System One request (ADR-439) as JSON or as a form: two views of the same text under
// one label row, whose toggle stays where it is when the view changes.
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { pretty } from './json-test-text'
import { QuestionsField } from './QuestionsField'

const URGENT = { type: 'noul', instructions: 'Does the message convey urgency?' }
const ANGRY = { type: 'noul', instructions: 'The customer is angry.' }

function HostedField({ initial, onFormValidityChange }: { initial: string; onFormValidityChange: (valid: boolean) => void }) {
  const [value, setValue] = useState(initial)
  return <QuestionsField value={value} onChange={setValue} onFormValidityChange={onFormValidityChange} />
}

function renderField(questions: unknown = { urgent: URGENT }) {
  const onFormValidityChange = vi.fn()
  render(<HostedField initial={pretty(questions)} onFormValidityChange={onFormValidityChange} />)
  return { onFormValidityChange }
}

const viewToggle = () => screen.getByRole('group', { name: 'Questions input' })
const viewButton = (name: 'JSON' | 'Form') => within(viewToggle()).getByRole('button', { name })
const questionsLabel = () => screen.getByText('questions', { selector: 'label' })

describe('QuestionsField', () => {
  it('keeps its one label and its toggle, the very same elements, through a switch of view and back', async () => {
    renderField()
    const label = questionsLabel()
    const toggle = viewToggle()

    await userEvent.click(viewButton('Form'))
    expect(questionsLabel()).toBe(label)
    expect(viewToggle()).toBe(toggle)
    expect(screen.getAllByText('questions')).toHaveLength(1)

    await userEvent.click(viewButton('JSON'))
    expect(viewToggle()).toBe(toggle)
  })

  it('names the textarea by that label in the JSON view, and the form by it in the Form view', async () => {
    renderField()
    expect(screen.getByRole('textbox', { name: 'questions' })).toBeInTheDocument()

    await userEvent.click(viewButton('Form'))
    expect(screen.queryByRole('textbox', { name: 'questions' })).toBeNull()
    expect(screen.getByRole('group', { name: 'questions' })).toContainElement(screen.getByRole('group', { name: 'Question 1' }))
  })

  it('passes on whether the form can be run as it shows, and holds nothing back once the JSON view is back', async () => {
    const { onFormValidityChange } = renderField({ urgent: URGENT, angry: ANGRY })
    await userEvent.click(viewButton('Form'))
    fireEvent.change(within(screen.getByRole('group', { name: 'Question 2' })).getByLabelText('id'), { target: { value: 'urgent' } })
    expect(onFormValidityChange).toHaveBeenLastCalledWith(false)

    await userEvent.click(viewButton('JSON'))
    expect(onFormValidityChange).toHaveBeenLastCalledWith(true)
  })
})
