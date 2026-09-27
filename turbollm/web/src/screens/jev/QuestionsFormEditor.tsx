// The questions of a System One request (ADR-439) as a form: a card per question, its type picked
// from a list rather than typed. It is a second view of the questions text, not a second copy of it:
// every edit is sent up as that text at once, so the JSON view, the draft and the run all see it.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { Input } from '../../components/ui/input'
import {
  MAX_CHOICE_OPTIONS,
  MAX_QUESTIONS,
  MAX_SCORE_LEVELS,
  MIN_CHOICE_OPTIONS,
  MIN_QUESTIONS,
  MIN_SCORE_LEVELS,
} from '../../lib/systemone-types'
import { cn } from '../../lib/utils'
import {
  blankLevelRow,
  blankOptionRow,
  blankQuestionRow,
  duplicateOptionNames,
  duplicateQuestionIds,
  QUESTION_FORM_TYPES,
  questionsTextFromRows,
  retypedRow,
  rowsFromQuestionsText,
  type LevelRow,
  type OptionRow,
  type QuestionFormRow,
  type QuestionFormType,
} from './questions-form'
import { labelCls, selectCls, textareaCls } from './JsonEditor'
import { isQuestionType } from './systemone-draft'

interface QuestionsFormEditorProps {
  value: string
  onChange: (next: string) => void
  problem?: string
  /** Whether the text sends every question and option the cards show; false while an id or an
   *  option name is repeated, which the text can hold only once. */
  onValidityChange?: (valid: boolean) => void
}

const TYPE_LABEL: Record<QuestionFormType, string> = { noul: 'Yes/no', choice: 'Pick one', score: 'Scale' }

const SHARED_ID_WARNING = 'Another question has this id too. Each question needs an id of its own.'
const SHARED_OPTION_NAME_WARNING = 'Some options have the same name. Each option needs a name of its own.'

const fieldInputCls = 'h-8 text-[13px]'

/** Only for text `canEditAsForm` accepts. */
export function QuestionsFormEditor({ value, onChange, problem, onValidityChange }: QuestionsFormEditorProps) {
  const [rows, setRows] = useState(() => rowsFromQuestionsText(value))
  const sharedIds = duplicateQuestionIds(rows)
  useReportedValidity(!hasAnyClash(rows), onValidityChange)
  // The text this form last sent up. Coming back down as `value` it is only the echo of an edit
  // already on screen; any other text came from outside (an example, a stored draft) and replaces
  // the rows. Re-reading the echo would give every row a new key, and typing would lose the focus.
  const lastSent = useRef(value)

  useEffect(() => {
    if (value === lastSent.current) return
    lastSent.current = value
    setRows(rowsFromQuestionsText(value))
  }, [value])

  /** A repeated id, or a repeated option name within one question, cannot both survive in the text at
   *  once — the object those rows serialize into can only hold one member under that key. Sending it
   *  anyway would silently overwrite the earlier question or option in the draft the moment the clash
   *  appears, long before anyone acts on the on-screen warning or switches to the JSON view to fix it.
   *  So the rows still update (the cards and the warning stay live), but the text sent up, and with it
   *  the draft, stays at its last clash-free state — nothing is lost, only held — until every clash is
   *  gone, at which point the fully caught-up text is sent in one go. */
  function changeRows(next: QuestionFormRow[]) {
    setRows(next)
    if (hasAnyClash(next)) return
    const text = questionsTextFromRows(next)
    lastSent.current = text
    onChange(text)
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <QuestionCard
          key={row.key}
          row={row}
          number={index + 1}
          removable={rows.length > MIN_QUESTIONS}
          sharesId={sharedIds.includes(row.id)}
          onChange={(changed) => changeRows(replaced(rows, changed))}
          onRemove={() => changeRows(without(rows, row))}
        />
      ))}
      <AddButton text="Add question" disabled={rows.length >= MAX_QUESTIONS} onClick={() => changeRows([...rows, blankQuestionRow()])} />
      {problem && <Problem>{problem}</Problem>}
    </div>
  )
}

/** Tells the page whether the questions can be run as the cards show them. A form that is gone,
 *  because the JSON view replaced it, holds nothing back. */
function useReportedValidity(valid: boolean, onValidityChange?: (valid: boolean) => void) {
  useEffect(() => {
    onValidityChange?.(valid)
    return () => onValidityChange?.(true)
  }, [valid, onValidityChange])
}

const hasUniqueOptionNames = (row: QuestionFormRow): boolean => duplicateOptionNames(row).length === 0

const hasAnyClash = (rows: QuestionFormRow[]): boolean =>
  duplicateQuestionIds(rows).length > 0 || !rows.every(hasUniqueOptionNames)

interface QuestionCardProps {
  row: QuestionFormRow
  number: number
  removable: boolean
  sharesId: boolean
  onChange: (row: QuestionFormRow) => void
  onRemove: () => void
}

/** One question. Its buttons name it by its id, or by its place while the id is still blank. */
function QuestionCard({ row, number, removable, sharesId, onChange, onRemove }: QuestionCardProps) {
  const fieldId = useId()
  const questionName = row.id.trim() === '' ? `question ${number}` : row.id
  const change = (edit: Partial<QuestionFormRow>) => onChange({ ...row, ...edit })
  return (
    <div role="group" aria-label={`Question ${number}`} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-end gap-2">
        <Field label="id" htmlFor={`${fieldId}-id`} className="min-w-0 flex-1">
          <Input
            id={`${fieldId}-id`}
            className={fieldInputCls}
            placeholder="e.g. urgent"
            value={row.id}
            onChange={(e) => change({ id: e.target.value })}
          />
        </Field>
        <Field label="type" htmlFor={`${fieldId}-type`}>
          <select
            id={`${fieldId}-type`}
            className={selectCls}
            value={row.type}
            onChange={(e) => { if (isQuestionType(e.target.value)) onChange(retypedRow(row, e.target.value)) }}
          >
            {QUESTION_FORM_TYPES.map((type) => (
              <option key={type} value={type}>{TYPE_LABEL[type]}</option>
            ))}
          </select>
        </Field>
        <IconButton label={`Remove question ${number}`} disabled={!removable} onClick={onRemove}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {sharesId && <Problem>{SHARED_ID_WARNING}</Problem>}
      <Field label="instructions" htmlFor={`${fieldId}-instructions`}>
        <textarea
          id={`${fieldId}-instructions`}
          className={cn(textareaCls, 'min-h-[60px]')}
          value={row.instructionsText}
          onChange={(e) => change({ instructionsText: e.target.value })}
        />
      </Field>
      <CriteriaFields row={row} questionName={questionName} onEdit={change} />
    </div>
  )
}

/** The part of a question its type decides (`retypedRow` keeps the parts of the other types). */
function CriteriaFields({ row, questionName, onEdit }: { row: QuestionFormRow; questionName: string; onEdit: (edit: Partial<QuestionFormRow>) => void }) {
  switch (row.type) {
    case 'noul':
      return <YesCriterion text={row.yesText} questionName={questionName} onChange={(yesText) => onEdit({ yesText })} />
    case 'choice':
      return (
        <OptionList
          options={row.options}
          questionName={questionName}
          sharesNames={!hasUniqueOptionNames(row)}
          onChange={(options) => onEdit({ options })}
        />
      )
    case 'score':
      return <LevelList levels={row.levels} questionName={questionName} onChange={(levels) => onEdit({ levels })} />
  }
}

/** Behind Advanced because it is optional. There is no field for "no": the server never uses it. */
function YesCriterion({ text, questionName, onChange }: { text: string; questionName: string; onChange: (text: string) => void }) {
  const inputId = useId()
  return (
    <Collapsible defaultOpen={text !== ''}>
      <CollapsibleTrigger
        aria-label={`Advanced options for ${questionName}`}
        className="group flex items-center gap-1.5 text-[12px] text-muted hover:text-ink"
      >
        <ChevronRight size={12} className="transition-transform group-data-[state=open]:rotate-90" />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Field label="What does 'yes' look like? Optional." htmlFor={inputId} className="mt-2 border-l border-border pl-3">
          <Input id={inputId} className={fieldInputCls} value={text} onChange={(e) => onChange(e.target.value)} />
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface OptionListProps {
  options: OptionRow[]
  questionName: string
  sharesNames: boolean
  onChange: (options: OptionRow[]) => void
}

function OptionList({ options, questionName, sharesNames, onChange }: OptionListProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className={labelCls}>Options</p>
      {options.map((option, index) => (
        <OptionLine
          key={option.key}
          option={option}
          number={index + 1}
          questionName={questionName}
          removable={options.length > MIN_CHOICE_OPTIONS}
          onChange={(changed) => onChange(replaced(options, changed))}
          onRemove={() => onChange(without(options, option))}
        />
      ))}
      {sharesNames && <Problem>{SHARED_OPTION_NAME_WARNING}</Problem>}
      <AddButton
        text="Add option"
        label={`Add option to ${questionName}`}
        disabled={options.length >= MAX_CHOICE_OPTIONS}
        onClick={() => onChange([...options, blankOptionRow()])}
      />
    </div>
  )
}

interface OptionLineProps {
  option: OptionRow
  number: number
  questionName: string
  removable: boolean
  onChange: (option: OptionRow) => void
  onRemove: () => void
}

function OptionLine({ option, number, questionName, removable, onChange, onRemove }: OptionLineProps) {
  const optionName = `option ${number} of ${questionName}`
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={`Name of ${optionName}`}
        className={cn(fieldInputCls, 'w-1/3 min-w-0')}
        placeholder="name"
        value={option.name}
        onChange={(e) => onChange({ ...option, name: e.target.value })}
      />
      <Input
        aria-label={`Description of ${optionName}`}
        className={cn(fieldInputCls, 'min-w-0 flex-1')}
        placeholder="what it means"
        value={option.descriptionText}
        onChange={(e) => onChange({ ...option, descriptionText: e.target.value })}
      />
      <IconButton label={`Remove ${optionName}`} disabled={!removable} onClick={onRemove}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

/** The order of the levels is the scale itself (level 0 is its bottom), so they are moved, never sorted. */
function LevelList({ levels, questionName, onChange }: { levels: LevelRow[]; questionName: string; onChange: (levels: LevelRow[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className={labelCls}>Levels</p>
      {levels.map((level, place) => (
        <LevelLine
          key={level.key}
          level={level}
          place={place}
          questionName={questionName}
          isTop={place === levels.length - 1}
          removable={levels.length > MIN_SCORE_LEVELS}
          onChange={(changed) => onChange(replaced(levels, changed))}
          onMove={(to) => onChange(movedTo(levels, place, to))}
          onRemove={() => onChange(without(levels, level))}
        />
      ))}
      <AddButton
        text="Add level"
        label={`Add level to ${questionName}`}
        disabled={levels.length >= MAX_SCORE_LEVELS}
        onClick={() => onChange([...levels, blankLevelRow()])}
      />
    </div>
  )
}

interface LevelLineProps {
  level: LevelRow
  place: number
  questionName: string
  isTop: boolean
  removable: boolean
  onChange: (level: LevelRow) => void
  onMove: (to: number) => void
  onRemove: () => void
}

/** Named by its place on the scale, the number a score answers with. */
function LevelLine({ level, place, questionName, isTop, removable, onChange, onMove, onRemove }: LevelLineProps) {
  const levelName = `level ${place} of ${questionName}`
  return (
    <div className="flex items-center gap-2">
      <span className="w-5 shrink-0 text-center font-mono text-[12px] text-muted">{place}</span>
      <Input
        aria-label={`Description of ${levelName}`}
        className={cn(fieldInputCls, 'min-w-0 flex-1')}
        value={level.text}
        onChange={(e) => onChange({ ...level, text: e.target.value })}
      />
      <IconButton label={`Move ${levelName} up`} disabled={place === 0} onClick={() => onMove(place - 1)}>
        <ArrowUp size={14} />
      </IconButton>
      <IconButton label={`Move ${levelName} down`} disabled={isTop} onClick={() => onMove(place + 1)}>
        <ArrowDown size={14} />
      </IconButton>
      <IconButton label={`Remove ${levelName}`} disabled={!removable} onClick={onRemove}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

interface AddButtonProps {
  text: string
  label?: string
  disabled: boolean
  onClick: () => void
}

function AddButton({ text, label, disabled, onClick }: AddButtonProps) {
  return (
    <Button type="button" variant="outline" size="sm" className="w-fit" aria-label={label} disabled={disabled} onClick={onClick}>
      <Plus size={14} /> {text}
    </Button>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="iconSm" className="shrink-0" aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[13px] text-err">
      {children}
    </p>
  )
}

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
    </div>
  )
}

function replaced<Item extends { key: string }>(items: Item[], changed: Item): Item[] {
  return items.map((item) => (item.key === changed.key ? changed : item))
}

function without<Item extends { key: string }>(items: Item[], removed: Item): Item[] {
  return items.filter((item) => item.key !== removed.key)
}

function movedTo<Item>(items: Item[], from: number, to: number): Item[] {
  const moved = [...items]
  moved.splice(to, 0, ...moved.splice(from, 1))
  return moved
}
