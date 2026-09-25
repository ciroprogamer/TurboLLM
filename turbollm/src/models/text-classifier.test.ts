// Jev and Laya are one thing to the user: text classification (ADR-444). They keep their own
// flags and runtimes, but every "is this a decision model?" question asks this one predicate.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTextClassifier, textClassifierRuntime } from './text-classifier'
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
