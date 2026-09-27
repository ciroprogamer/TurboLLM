// The questions of a System One request (ADR-439) as JSON or as a form, two views of the same text:
// JSON alone was found hard to write by hand. One label row heads both views and never changes with
// them, so the view toggle a user just pressed keeps the focus.
import { useId, useState } from 'react'
import { canEditAsForm } from './questions-form'
import { EditorFrame, JsonEditorBody, labelCls } from './JsonEditor'
import { QuestionsFormEditor } from './QuestionsFormEditor'
import { ViewToggle } from './ViewToggle'

interface QuestionsFieldProps {
  value: string
  onChange: (next: string) => void
  problem?: string
  onFormValidityChange: (valid: boolean) => void
}

const QUESTIONS_LABEL = 'questions'
const JSON_EDITOR_ID = 'jev-questions'

const QUESTIONS_VIEWS = ['json', 'form'] as const

type QuestionsView = (typeof QUESTIONS_VIEWS)[number]

const QUESTIONS_VIEW_LABEL: Record<QuestionsView, string> = { json: 'JSON', form: 'Form' }

const FORM_UNAVAILABLE_HINT = 'Fix the JSON to use the form'

/** The form is offered only while the text is an object it can show; otherwise the JSON editor is
 *  shown, whichever view was picked. */
export function QuestionsField({ value, onChange, problem, onFormValidityChange }: QuestionsFieldProps) {
  const [view, setView] = useState<QuestionsView>('json')
  const labelId = useId()
  const formUsable = canEditAsForm(value)
  const shownView: QuestionsView = formUsable ? view : 'json'
  const header = (
    <>
      <label id={labelId} htmlFor={shownView === 'json' ? JSON_EDITOR_ID : undefined} className={labelCls}>
        {QUESTIONS_LABEL}
      </label>
      <ViewToggle
        label="Questions input"
        views={QUESTIONS_VIEWS}
        viewLabels={QUESTIONS_VIEW_LABEL}
        view={shownView}
        onView={setView}
        unavailable={formUsable ? undefined : { form: FORM_UNAVAILABLE_HINT }}
      />
    </>
  )
  return (
    <EditorFrame header={header}>
      {shownView === 'json' ? (
        <JsonEditorBody id={JSON_EDITOR_ID} label={QUESTIONS_LABEL} mode="json" value={value} onChange={onChange} problem={problem} />
      ) : (
        <div role="group" aria-labelledby={labelId} className="col-span-2 row-start-2">
          <QuestionsFormEditor value={value} onChange={onChange} problem={problem} onValidityChange={onFormValidityChange} />
        </div>
      )}
    </EditorFrame>
  )
}
