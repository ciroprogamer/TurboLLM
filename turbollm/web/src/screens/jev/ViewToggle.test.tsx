// Two views of one thing (ADR-439): the response or its curl, the questions as JSON or as a form. The
// toggle is a pressed-state button group, so a screen reader hears which view is showing.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ViewToggle } from './ViewToggle'

const VIEWS = ['json', 'form'] as const
const VIEW_LABELS = { json: 'JSON', form: 'Form' }

function renderToggle(overrides: { view?: 'json' | 'form'; unavailable?: { form?: string } } = {}) {
  const onView = vi.fn()
  render(
    <ViewToggle
      label="Questions input"
      views={VIEWS}
      viewLabels={VIEW_LABELS}
      view={overrides.view ?? 'json'}
      onView={onView}
      unavailable={overrides.unavailable}
    />,
  )
  return { onView }
}

const viewButton = (name: string) => screen.getByRole('button', { name })

describe('ViewToggle', () => {
  it('offers one button per view, in order, inside a group named by its label', () => {
    renderToggle()
    const buttons = within(screen.getByRole('group', { name: 'Questions input' })).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['JSON', 'Form'])
  })

  it('presses the view that is showing and no other', () => {
    renderToggle({ view: 'form' })
    expect(viewButton('Form')).toHaveAttribute('aria-pressed', 'true')
    expect(viewButton('JSON')).toHaveAttribute('aria-pressed', 'false')
  })

  it('asks for the view whose button is clicked', async () => {
    const { onView } = renderToggle()
    await userEvent.click(viewButton('Form'))
    expect(onView).toHaveBeenCalledWith('form')
  })

  it('disables a view that is unavailable, says why on it, and leaves the other usable', async () => {
    const { onView } = renderToggle({ unavailable: { form: 'Fix the JSON to use the form' } })
    expect(viewButton('Form')).toBeDisabled()
    expect(viewButton('Form')).toHaveAttribute('title', 'Fix the JSON to use the form')
    expect(viewButton('JSON')).toBeEnabled()
    expect(viewButton('JSON')).not.toHaveAttribute('title')
    await userEvent.click(viewButton('Form'))
    expect(onView).not.toHaveBeenCalled()
  })
})
