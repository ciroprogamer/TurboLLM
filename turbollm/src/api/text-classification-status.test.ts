// `textClassificationStatus()` is the one answer to "which text classification model is alive" (ADR-444): Jev and
// Laya are two runtimes behind one feature. When both are alive the Jev one wins, as the web's
// `status.jev ?? status.laya` always chose.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textClassificationStatus } from './text-classification-status'
import type { Deps } from '../deps'
import type { AliveSlot } from '../gateway/model-router'
import type { ModelEntry } from '../models/scanner'

const LABELS = ['contradiction', 'entailment', 'neutral']
const JEV = {
  key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  name: 'qwen3.5 4b nli v2',
  jev: { labels: LABELS, nliTemplate: '', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}
const LAYA = { key: 'laya|laya|1455', name: 'laya', laya: { checkpoints: ['english', 'multilingual'] } }
const CHAT = { key: 'gemma 4 e4b|Q6_K|6217256480', name: 'Gemma 4 E4B' }

function depsWith(slots: AliveSlot[]): Pick<Deps, 'modelRouter' | 'scanner'> {
  const library = new Map([JEV, LAYA, CHAT].map((m) => [m.key, m as unknown as ModelEntry]))
  return {
    modelRouter: { aliveSlots: () => slots },
    scanner: { get: (key: string) => library.get(key) },
  } as unknown as Pick<Deps, 'modelRouter' | 'scanner'>
}

function slot(modelKey: string, overrides: Partial<AliveSlot> = {}): AliveSlot {
  return { modelKey, state: 'running', primary: false, lastUsedMs: 0, ...overrides }
}

test('a Jev primary is a vLLM text classifier in the primary slot, with its labels', () => {
  const status = textClassificationStatus(depsWith([slot(JEV.key, { primary: true })]))

  assert.deepEqual(status, {
    key: JEV.key, name: JEV.name, runtime: 'vllm', state: 'running', slot: 'primary', labels: LABELS,
  })
})

test('a Jev model in a pool slot is reported in the pool', () => {
  const status = textClassificationStatus(depsWith([slot(CHAT.key, { primary: true }), slot(JEV.key, { state: 'starting' })]))

  assert.deepEqual(status, {
    key: JEV.key, name: JEV.name, runtime: 'vllm', state: 'starting', slot: 'pool', labels: LABELS,
  })
})

test('a Laya model is a laya text classifier, always in the pool, with its checkpoints', () => {
  const status = textClassificationStatus(depsWith([slot(CHAT.key, { primary: true }), slot(LAYA.key, { state: 'stopping' })]))

  assert.deepEqual(status, {
    key: LAYA.key, name: LAYA.name, runtime: 'laya', state: 'stopping', slot: 'pool', checkpoints: ['english', 'multilingual'],
  })
})

test('with a Jev and a Laya model both alive, the Jev one wins even when the Laya one was used more recently', () => {
  const status = textClassificationStatus(depsWith([
    slot(JEV.key, { lastUsedMs: 100 }),
    slot(LAYA.key, { lastUsedMs: 900 }),
  ]))

  assert.equal(status?.key, JEV.key)
  assert.equal(status?.runtime, 'vllm')
})

test('no text classification model alive → null, whatever chat model is loaded', () => {
  assert.equal(textClassificationStatus(depsWith([])), null)
  assert.equal(textClassificationStatus(depsWith([slot(CHAT.key, { primary: true })])), null)
})
