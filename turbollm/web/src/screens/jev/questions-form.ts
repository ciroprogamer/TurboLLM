// The questions of a System One request (ADR-439) as the rows of a form, and back. The form is a
// second view of the same text the questions JSON editor shows, so each direction is lenient where
// the other is strict: any object opens, and only what the form shows is ever written. Pure: no React.
import { MIN_CHOICE_OPTIONS, MIN_SCORE_LEVELS } from '../../lib/systemone-types'
import type { Criterion, NoulQuestion, Question } from '../../lib/systemone-types'
import { firstTooDeepQuestionsField, isObject, isQuestionType, stateFromText } from './systemone-draft'

export type QuestionFormType = Question['type']

export interface OptionRow {
  key: string
  name: string
  descriptionText: string
}

export interface LevelRow {
  key: string
  text: string
}

/** One question as the form edits it. `key` names the row on screen and never changes while it is
 *  edited, so renaming a question never replaces its fields (and the focus inside them). */
export interface QuestionFormRow {
  key: string
  id: string
  type: QuestionFormType
  instructionsText: string
  /** Yes/no only. `criteria.false` has no field: the server accepts it but never uses it. */
  yesText: string
  options: OptionRow[]
  levels: LevelRow[]
}

export const QUESTION_FORM_TYPES: readonly QuestionFormType[] = ['noul', 'choice', 'score']

let lastKey = 0

/** Any object of questions, however malformed its entries, since the form can show each of them. A
 *  field nested past the limit the request rules set is refused: printing it could overflow the stack. */
export function canEditAsForm(questionsText: string): boolean {
  try {
    const questions: unknown = JSON.parse(questionsText)
    return isObject(questions) && firstTooDeepQuestionsField(questions) === undefined
  } catch {
    return false
  }
}

/** Only for text `canEditAsForm` accepts. An entry is read as the nearest row the form can show. */
export function rowsFromQuestionsText(questionsText: string): QuestionFormRow[] {
  const questions = JSON.parse(questionsText) as Record<string, unknown>
  return Object.entries(questions).map(([id, question]) => rowOf(id, question))
}

/** A repeated id overwrites the earlier question, exactly as a repeated key typed into the JSON does:
 *  `duplicateQuestionIds` and `duplicateOptionNames` find what would be lost. */
export function questionsTextFromRows(rows: QuestionFormRow[]): string {
  const questions = Object.fromEntries(rows.map((row) => [row.id, questionOf(row)]))
  return JSON.stringify(questions, null, 2)
}

/** The ids more than one question has, each of which the text keeps only one question of. */
export function duplicateQuestionIds(rows: QuestionFormRow[]): string[] {
  return namesGivenMoreThanOnce(rows.map((row) => row.id))
}

/** The option names a pick-one question has more than once. Only a pick-one question writes its options. */
export function duplicateOptionNames(row: QuestionFormRow): string[] {
  return row.type === 'choice' ? namesGivenMoreThanOnce(row.options.map((option) => option.name)) : []
}

/** A new question for "Add question". It starts as yes/no, and already holds the fewest options and
 *  levels the other types accept, so picking either type needs no further clicks. */
export function blankQuestionRow(): QuestionFormRow {
  return {
    key: freshKey(),
    id: '',
    type: 'noul',
    instructionsText: '',
    yesText: '',
    options: fewestBlankOptions(),
    levels: fewestBlankLevels(),
  }
}

/** The question as another type. The options and levels it holds stay, so switching back loses
 *  nothing; a type with none yet gets the fewest blank ones it accepts, as a new question has. */
export function retypedRow(row: QuestionFormRow, type: QuestionFormType): QuestionFormRow {
  return {
    ...row,
    type,
    options: type === 'choice' && row.options.length === 0 ? fewestBlankOptions() : row.options,
    levels: type === 'score' && row.levels.length === 0 ? fewestBlankLevels() : row.levels,
  }
}

export function blankOptionRow(): OptionRow {
  return { key: freshKey(), name: '', descriptionText: '' }
}

export function blankLevelRow(): LevelRow {
  return { key: freshKey(), text: '' }
}

const fewestBlankOptions = (): OptionRow[] => Array.from({ length: MIN_CHOICE_OPTIONS }, blankOptionRow)

const fewestBlankLevels = (): LevelRow[] => Array.from({ length: MIN_SCORE_LEVELS }, blankLevelRow)

/** A React key for a row, an option or a level. */
export function freshKey(): string {
  lastKey += 1
  return `key-${lastKey}`
}

function rowOf(id: string, question: unknown): QuestionFormRow {
  const entry = isObject(question) ? question : {}
  const type = isQuestionType(entry.type) ? entry.type : 'noul'
  return {
    key: freshKey(),
    id,
    type,
    instructionsText: textOf(entry.instructions),
    yesText: type === 'noul' ? yesTextOf(entry.criteria) : '',
    options: type === 'choice' ? optionRowsOf(entry.criteria) : [],
    levels: type === 'score' ? levelRowsOf(entry.criteria) : [],
  }
}

function yesTextOf(criteria: unknown): string {
  return isObject(criteria) ? textOf(criteria.true) : ''
}

function optionRowsOf(criteria: unknown): OptionRow[] {
  if (!isObject(criteria)) return []
  return Object.entries(criteria).map(([name, description]) => ({
    key: freshKey(),
    name,
    descriptionText: textOf(description),
  }))
}

function levelRowsOf(criteria: unknown): LevelRow[] {
  if (!Array.isArray(criteria)) return []
  return criteria.map((level) => ({ key: freshKey(), text: textOf(level) }))
}

function questionOf(row: QuestionFormRow): Question {
  const instructions = fieldValueOf(row.instructionsText)
  switch (row.type) {
    case 'noul':
      return { type: 'noul', instructions, ...yesCriteriaOf(row.yesText) }
    case 'choice':
      return { type: 'choice', instructions, criteria: Object.fromEntries(row.options.map(optionEntryOf)) }
    case 'score':
      return { type: 'score', instructions, criteria: row.levels.map((level) => fieldValueOf(level.text)) }
  }
}

/** Nothing at all for an empty "yes" text: never `criteria: {}`, and never a `false` criterion. */
function yesCriteriaOf(yesText: string): Pick<NoulQuestion, 'criteria'> {
  return yesText.trim() === '' ? {} : { criteria: { true: fieldValueOf(yesText) } }
}

const optionEntryOf = (option: OptionRow): [string, Criterion] => [option.name, fieldValueOf(option.descriptionText)]

function namesGivenMoreThanOnce(names: string[]): string[] {
  return [...new Set(names)].filter((name) => names.indexOf(name) !== names.lastIndexOf(name))
}

/** A field's text read as the state editor reads its own, so JSON the field was shown as goes back as
 *  that JSON, and plain English stays a string. */
const fieldValueOf = stateFromText

/** A field's value as the text `fieldValueOf` reads back as that same value: JSON written by hand is
 *  shown pretty-printed, and a string that would read as JSON is shown as a quoted JSON string. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return fieldValueOf(value) === value ? value : JSON.stringify(value)
  return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : ''
}
