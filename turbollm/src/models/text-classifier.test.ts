// Jev and Laya are one thing to the user: text classification (ADR-444). They keep their own
// flags and runtimes, but every "is this a decision model?" question asks this one predicate.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTextClassifier, isTextClassifierKey, textClassifierKind, textClassifierRuntime } from './text-classifier'
import type { JevInfo } from './jev'
import type { LayaInfo } from './laya'

const JEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const LAYA: LayaInfo = { checkpoints: ['english', 'multilingual'] }

test('a Jev model is a text classifier served by vLLM', () => {
  assert.equal(isTextClassifier({ jev: JEV }), true)
  assert.equal(textClassifierRuntime({ jev: JEV }), 'vllm')
})

test('a Laya model is a text classifier served by its own engine', () => {
  assert.equal(isTextClassifier({ laya: LAYA }), true)
  assert.equal(textClassifierRuntime({ laya: LAYA }), 'laya')
})

test('a chat model is not a text classifier and has no classifier runtime', () => {
  assert.equal(isTextClassifier({}), false)
  assert.equal(textClassifierRuntime({}), undefined)
})

// The kind API clients and model tools see: a Jev model's is 'jev' although its runtime is vLLM.
test('a Jev model is of kind jev and a Laya model of kind laya', () => {
  assert.equal(textClassifierKind({ jev: JEV }), 'jev')
  assert.equal(textClassifierKind({ laya: LAYA }), 'laya')
})

test('a chat model has no classifier kind', () => {
  assert.equal(textClassifierKind({}), undefined)
})

const LIBRARY = [
  { key: 'jev-key', jev: JEV },
  { key: 'laya-key', laya: LAYA },
  { key: 'chat-key' },
]

test('a key that names a Jev or a Laya model in the library names a text classifier', () => {
  assert.equal(isTextClassifierKey(LIBRARY, 'jev-key'), true)
  assert.equal(isTextClassifierKey(LIBRARY, 'laya-key'), true)
})

test('a key that names a chat model, or nothing in the library, does not', () => {
  assert.equal(isTextClassifierKey(LIBRARY, 'chat-key'), false)
  assert.equal(isTextClassifierKey(LIBRARY, 'gpt-4'), false)
})
