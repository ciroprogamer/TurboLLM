// The questions of a System One request (ADR-439) as form rows and back. The form is offered for any
// object, reads a malformed entry as the nearest row it can show, and writes only what it shows.
import { describe, expect, it } from 'vitest'
import { MAX_NESTING_DEPTH, MIN_CHOICE_OPTIONS, MIN_SCORE_LEVELS } from '../../lib/systemone-types'
import type { Question } from '../../lib/systemone-types'
import { arraysNestedDeep, pretty } from './json-test-text'
import {
  blankQuestionRow,
  canEditAsForm,
  duplicateOptionNames,
  duplicateQuestionIds,
  freshKey,
  questionsTextFromRows,
  retypedRow,
  rowsFromQuestionsText,
} from './questions-form'
import type { QuestionFormRow } from './questions-form'
import { draftRequest } from './systemone-draft'

const NEST_TOO_DEEP = MAX_NESTING_DEPTH + 1

const URGENT: Question = {
  type: 'noul',
  instructions: 'Does the message convey urgency?',
  criteria: { true: 'The customer says they are losing money right now.' },
}
const TEAM_OPTIONS = {
  billing: 'Payment, invoices, refunds or subscription charges',
  technical: 'Bugs, outages or integration problems',
  sales: 'Pricing, plans, upgrades or discounts',
}
const TEAM: Question = { type: 'choice', instructions: 'Which team should handle this message?', criteria: TEAM_OPTIONS }
const MOOD_LEVELS = ['Calm, just asking or stating facts', 'Mildly annoyed but polite', 'Clearly frustrated']
const MOOD: Question = { type: 'score', instructions: "What is the customer's tone?", criteria: MOOD_LEVELS }
const SUPPORT_QUESTIONS = { urgent: URGENT, team: TEAM, mood: MOOD }

/** The one row the text holds, for the leniency cases that each read a single entry. */
function onlyRowOf(questions: unknown): QuestionFormRow {
  const rows = rowsFromQuestionsText(pretty(questions))
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** A row without its keys, which are fresh on every read and so never part of what was read. */
function contentOf(row: QuestionFormRow) {
  const { key: _key, options, levels, ...rest } = row
  return {
    ...rest,
    options: options.map(({ key: _optionKey, ...option }) => option),
    levels: levels.map(({ key: _levelKey, ...level }) => level),
  }
}

const keysOf = (rows: QuestionFormRow[]): string[] =>
  rows.flatMap((row) => [row.key, ...row.options.map((option) => option.key), ...row.levels.map((level) => level.key)])

const BLANK_NOUL_CONTENT ={ type: 'noul', instructionsText: '', yesText: '', options: [], levels: [] }

/** The questions the text says after one pass through the form, unedited. */
const throughTheForm = (questions: unknown): unknown =>
  JSON.parse(questionsTextFromRows(rowsFromQuestionsText(pretty(questions))))

function noulRow(id: string, instructionsText: string, yesText = ''): QuestionFormRow {
  return { key: freshKey(), id, type: 'noul', instructionsText, yesText, options: [], levels: [] }
}

describe('canEditAsForm', () => {
  it.each([
    ['an array', '[]'],
    ['a string', '"urgent"'],
    ['a number', '42'],
    ['null', 'null'],
    ['invalid JSON', '{oops'],
  ])('refuses %s', (_kind, text) => {
    expect(canEditAsForm(text)).toBe(false)
  })

  it('accepts an empty object, which is still an object of questions', () => {
    expect(canEditAsForm('{}')).toBe(true)
  })

  it('accepts a real questions object, and one whose entries are malformed', () => {
    expect(canEditAsForm('{"urgent":{"type":"noul","instructions":"Is it urgent?"}}')).toBe(true)
    expect(canEditAsForm('{"urgent":"not a question","team":null}')).toBe(true)
  })

  it('refuses an object nested past the limit, which no field could show as text', () => {
    expect(canEditAsForm(`{"q":{"type":"noul","instructions":${arraysNestedDeep(NEST_TOO_DEEP)}}}`)).toBe(false)
  })

  // The limit holds for each field of a question, as the request rules count it, and not for the whole
  // text: a field nested to the limit sits two levels deeper than that in the text.
  it('accepts a field nested to the limit, which the request rules accept too', () => {
    const questionsText = `{"q":{"type":"noul","instructions":${arraysNestedDeep(MAX_NESTING_DEPTH)}}}`
    expect(draftRequest('model', { stateText: 'state', questionsText }).ok).toBe(true)
    expect(canEditAsForm(questionsText)).toBe(true)
  })
})

describe('rowsFromQuestionsText', () => {
  it('reads one row per question, in the object\'s own order, each with its id, type and instructions', () => {
    const rows = rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS))
    expect(rows.map((row) => [row.id, row.type, row.instructionsText])).toEqual([
      ['urgent', 'noul', URGENT.instructions],
      ['team', 'choice', TEAM.instructions],
      ['mood', 'score', MOOD.instructions],
    ])
  })

  it('reads a yes/no question\'s "yes" criterion and never its "false" one', () => {
    const row = onlyRowOf({ q: { type: 'noul', instructions: 'i', criteria: { true: 'Yes means this.', false: 'No means that.' } } })
    expect(row.yesText).toBe('Yes means this.')
    expect(JSON.stringify(row)).not.toContain('No means that.')
  })

  it('reads a pick-one question\'s options, and a scale\'s levels, in their order', () => {
    const [, team, mood] = rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS))
    expect(contentOf(team).options).toEqual([
      { name: 'billing', descriptionText: 'Payment, invoices, refunds or subscription charges' },
      { name: 'technical', descriptionText: 'Bugs, outages or integration problems' },
      { name: 'sales', descriptionText: 'Pricing, plans, upgrades or discounts' },
    ])
    expect(contentOf(mood).levels.map((level) => level.text)).toEqual(MOOD.criteria)
  })

  it('reads only the criteria of the question\'s own type', () => {
    const [urgent, team, mood] = rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS)).map(contentOf)
    expect([urgent.options, urgent.levels, team.yesText, team.levels]).toEqual([[], [], '', []])
    expect([mood.yesText, mood.options]).toEqual(['', []])
  })

  it('gives every row, option and level a key of its own', () => {
    const keys = keysOf(rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS)))
    const questions = Object.keys(SUPPORT_QUESTIONS).length
    expect(keys).toHaveLength(questions + Object.keys(TEAM_OPTIONS).length + MOOD_LEVELS.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each([
    ['a string', 'not a question'],
    ['null', null],
    ['an array', [{ type: 'choice' }]],
  ])('reads an entry that is %s as a blank yes/no row, keeping its id', (_kind, entry) => {
    const row = onlyRowOf({ q: entry })
    expect(row.id).toBe('q')
    expect(contentOf(row)).toEqual({ id: 'q', ...BLANK_NOUL_CONTENT })
  })

  it.each([
    ['missing', { instructions: 'i' }],
    ['not a type the server knows', { type: 'yesno', instructions: 'i' }],
    ['not a string', { type: 3, instructions: 'i' }],
  ])('reads a type that is %s as yes/no', (_kind, entry) => {
    expect(onlyRowOf({ q: entry }).type).toBe('noul')
  })

  it.each([
    ['missing', { type: 'noul' }],
    ['a number', { type: 'noul', instructions: 42 }],
    ['a boolean', { type: 'noul', instructions: true }],
    ['null', { type: 'noul', instructions: null }],
  ])('reads instructions that are %s as empty', (_kind, entry) => {
    expect(onlyRowOf({ q: entry }).instructionsText).toBe('')
  })

  it('shows instructions written as an object or an array as their pretty-printed JSON, so nothing is lost', () => {
    const asObject = { question: 'Is it urgent?', context: 'A support inbox.' }
    const asArray = ['Is it urgent?', 'Answer for the whole thread.']
    expect(onlyRowOf({ q: { type: 'noul', instructions: asObject } }).instructionsText).toBe(pretty(asObject))
    expect(onlyRowOf({ q: { type: 'noul', instructions: asArray } }).instructionsText).toBe(pretty(asArray))
  })

  it('shows a "yes" criterion, an option description or a level written as JSON as its pretty-printed JSON', () => {
    const detail = { means: 'a refund', unless: 'already refunded' }
    const noul = onlyRowOf({ q: { type: 'noul', instructions: 'i', criteria: { true: detail } } })
    const choice = onlyRowOf({ q: { type: 'choice', instructions: 'i', criteria: { billing: detail, sales: ['a', 'b'] } } })
    const score = onlyRowOf({ q: { type: 'score', instructions: 'i', criteria: [detail, 'Clearly frustrated'] } })
    expect(noul.yesText).toBe(pretty(detail))
    expect(choice.options.map((option) => option.descriptionText)).toEqual([pretty(detail), pretty(['a', 'b'])])
    expect(score.levels.map((level) => level.text)).toEqual([pretty(detail), 'Clearly frustrated'])
  })

  it('reads a yes/no question without criteria, or with misshapen ones, as having no "yes" text', () => {
    expect(onlyRowOf({ q: { type: 'noul', instructions: 'i' } }).yesText).toBe('')
    expect(onlyRowOf({ q: { type: 'noul', instructions: 'i', criteria: ['yes'] } }).yesText).toBe('')
    expect(onlyRowOf({ q: { type: 'noul', instructions: 'i', criteria: { true: 7 } } }).yesText).toBe('')
  })

  it.each([
    ['missing', undefined],
    ['an array', ['billing', 'sales']],
    ['a string', 'billing or sales'],
  ])('reads a pick-one question whose criteria are %s as having no options', (_kind, criteria) => {
    expect(onlyRowOf({ q: { type: 'choice', instructions: 'i', criteria } }).options).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['an object', { 0: 'Calm', 1: 'Angry' }],
    ['a string', 'Calm to angry'],
  ])('reads a scale whose criteria are %s as having no levels', (_kind, criteria) => {
    expect(onlyRowOf({ q: { type: 'score', instructions: 'i', criteria } }).levels).toEqual([])
  })
})

describe('questionsTextFromRows', () => {
  it('gives back the same questions it read, for all three types', () => {
    expect(throughTheForm(SUPPORT_QUESTIONS)).toEqual(SUPPORT_QUESTIONS)
  })

  it('writes the questions as two-space JSON, in row order', () => {
    const rows = [noulRow('b', 'Second?'), noulRow('a', 'First?')]
    expect(questionsTextFromRows(rows)).toBe(
      pretty({ b: { type: 'noul', instructions: 'Second?' }, a: { type: 'noul', instructions: 'First?' } }),
    )
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('leaves out a yes/no question\'s criteria when its "yes" text is %s', (_kind, yesText) => {
    expect(JSON.parse(questionsTextFromRows([noulRow('q', 'Is it urgent?', yesText)]))).toEqual({
      q: { type: 'noul', instructions: 'Is it urgent?' },
    })
  })

  it('writes a "yes" text as criteria.true, and drops a criteria.false it was given', () => {
    const question = { type: 'noul', instructions: 'i', criteria: { true: 'Yes means this.', false: 'No means that.' } }
    expect(throughTheForm({ q: question })).toEqual({ q: { type: 'noul', instructions: 'i', criteria: { true: 'Yes means this.' } } })
  })

  it('gives back instructions, a "yes" criterion, option descriptions and levels written as JSON as that same JSON', () => {
    const detail = { means: 'a refund', unless: ['already refunded'] }
    const questions = {
      urgent: { type: 'noul', instructions: { question: 'Is it urgent?', context: 'A support inbox.' }, criteria: { true: detail } },
      team: { type: 'choice', instructions: ['Which team?', 'Pick the closest.'], criteria: { billing: detail, sales: 'Pricing' } },
      mood: { type: 'score', instructions: 'How angry?', criteria: [detail, 'Angry'] },
    }
    expect(throughTheForm(questions)).toEqual(questions)
  })

  it('gives back a string whose text reads as JSON as that same string', () => {
    const questions = {
      q: { type: 'score', instructions: '"Quoted," they said.', criteria: ['{"level":0}', '["calm"]', '"calm"'] },
    }
    expect(throughTheForm(questions)).toEqual(questions)
  })

  it('leaves a question written as JSON exactly as it was when another question is edited', () => {
    const untouched = { type: 'noul', instructions: { question: 'Is it urgent?', context: 'A support inbox.' } }
    const [edited, other] = rowsFromQuestionsText(pretty({ team: TEAM, urgent: untouched }))
    const questions = JSON.parse(questionsTextFromRows([{ ...edited, id: 'routing' }, other]))
    expect(questions.urgent).toEqual(untouched)
  })

  it('writes only the criteria of the row\'s current type, whatever else the row still holds', () => {
    const [urgent, team, mood] = rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS))
    const rows = [
      { ...team, id: 'was-team', type: 'score' as const, levels: mood.levels },
      { ...mood, id: 'was-mood', type: 'noul' as const },
      { ...urgent, id: 'was-urgent', type: 'choice' as const, options: team.options },
    ]
    expect(JSON.parse(questionsTextFromRows(rows))).toEqual({
      'was-team': { type: 'score', instructions: TEAM.instructions, criteria: MOOD.criteria },
      'was-mood': { type: 'noul', instructions: MOOD.instructions },
      'was-urgent': { type: 'choice', instructions: URGENT.instructions, criteria: TEAM.criteria },
    })
  })

  it('lets a repeated id overwrite the earlier question, as a repeated JSON key does', () => {
    const rows = [noulRow('q', 'First?'), noulRow('q', 'Second?')]
    expect(JSON.parse(questionsTextFromRows(rows))).toEqual({ q: { type: 'noul', instructions: 'Second?' } })
  })

  it('writes an empty object for no rows', () => {
    expect(questionsTextFromRows([])).toBe('{}')
  })
})

describe('duplicateQuestionIds', () => {
  it('names each id more than one row has, once, in the order the rows first give it', () => {
    const rows = ['b', 'a', 'c', 'a', 'b', 'a'].map((id) => noulRow(id, 'i'))
    expect(duplicateQuestionIds(rows)).toEqual(['b', 'a'])
  })

  it('names none when every id is its own', () => {
    expect(duplicateQuestionIds(rowsFromQuestionsText(pretty(SUPPORT_QUESTIONS)))).toEqual([])
  })

  it('counts two blank ids as the same id, since the text can hold only one of them', () => {
    expect(duplicateQuestionIds([noulRow('', 'i'), noulRow('', 'j')])).toEqual([''])
  })
})

describe('duplicateOptionNames', () => {
  const choiceRow = (...names: string[]): QuestionFormRow => ({
    ...noulRow('team', 'i'),
    type: 'choice',
    options: names.map((name) => ({ key: freshKey(), name, descriptionText: '' })),
  })

  it('names each option name a pick-one question has more than once, once, in first-seen order', () => {
    expect(duplicateOptionNames(choiceRow('sales', 'billing', 'sales', 'billing', 'sales'))).toEqual(['sales', 'billing'])
  })

  it('names none when every option has its own name', () => {
    expect(duplicateOptionNames(choiceRow('billing', 'sales'))).toEqual([])
  })

  it('names none for a question of another type, which never writes the options it still holds', () => {
    expect(duplicateOptionNames({ ...choiceRow('sales', 'sales'), type: 'score' })).toEqual([])
  })
})

describe('retypedRow', () => {
  const BLANK_OPTIONS = Array.from({ length: MIN_CHOICE_OPTIONS }, () => ({ name: '', descriptionText: '' }))
  const BLANK_LEVELS = Array.from({ length: MIN_SCORE_LEVELS }, () => ({ text: '' }))

  it('gives a question read without options the fewest blank ones a pick-one question takes', () => {
    const retyped = retypedRow(onlyRowOf({ urgent: URGENT }), 'choice')
    expect(retyped.type).toBe('choice')
    expect(contentOf(retyped).options).toEqual(BLANK_OPTIONS)
  })

  it('gives a question read without levels the fewest blank ones a scale takes', () => {
    const retyped = retypedRow(onlyRowOf({ urgent: URGENT }), 'score')
    expect(retyped.type).toBe('score')
    expect(contentOf(retyped).levels).toEqual(BLANK_LEVELS)
  })

  it('keeps the options a question holds through a change of type and back, adding none', () => {
    const team = onlyRowOf({ team: TEAM })
    const backAgain = retypedRow(retypedRow(team, 'score'), 'choice')
    expect(backAgain.options).toEqual(team.options)
  })

  it('keeps the levels a question holds through a change of type and back, adding none', () => {
    const mood = onlyRowOf({ mood: MOOD })
    const backAgain = retypedRow(retypedRow(mood, 'noul'), 'score')
    expect(backAgain.levels).toEqual(mood.levels)
  })
})

describe('blankQuestionRow', () => {
  it('is an empty yes/no question with two blank options and two blank levels ready for either other type', () => {
    expect(contentOf(blankQuestionRow())).toEqual({
      id: '',
      ...BLANK_NOUL_CONTENT,
      options: Array.from({ length: MIN_CHOICE_OPTIONS }, () => ({ name: '', descriptionText: '' })),
      levels: Array.from({ length: MIN_SCORE_LEVELS }, () => ({ text: '' })),
    })
  })

  it('gives the row, its options and its levels keys no other row has', () => {
    const keys = keysOf([blankQuestionRow(), blankQuestionRow()])
    expect(new Set(keys).size).toBe(2 * (1 + MIN_CHOICE_OPTIONS + MIN_SCORE_LEVELS))
  })
})

describe('freshKey', () => {
  it('never hands out the same key twice', () => {
    const keys = Array.from({ length: 1000 }, () => freshKey())
    expect(new Set(keys).size).toBe(1000)
  })
})
