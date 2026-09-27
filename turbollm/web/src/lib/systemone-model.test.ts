// Which loaded model the System One playground runs against: the Jev model when one is loaded (it owns the
// Workspace), otherwise the Laya model (ADR-443). Status is the authority; the catalog is the fallback for a
// client that cannot read /status (ADR-422).
import { describe, expect, it } from 'vitest'
import { loadedSystemOneModel } from './systemone-model'
import type { JevInfo, JevStatus, LayaStatus, ModelEntry, Status, TextClassificationStatus } from './types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const JEV: JevStatus = { key: 'jev|mlx-fp16|1', name: 'jev', labels: JEV_INFO.labels, state: 'running', slot: 'primary' }
const LAYA: LayaStatus = { key: 'laya|laya|1455', name: 'laya', checkpoints: ['english', 'multilingual'], state: 'running' }
const JEV_TEXT_CLASSIFIER: TextClassificationStatus = {
  key: JEV.key, name: JEV.name, runtime: 'vllm', state: 'running', slot: 'primary', labels: JEV.labels,
}
const LAYA_TEXT_CLASSIFIER: TextClassificationStatus = {
  key: LAYA.key, name: LAYA.name, runtime: 'laya', state: 'running', slot: 'pool', checkpoints: LAYA.checkpoints,
}

function status(fields: Partial<Status>): Status {
  return fields as Status
}

// ADR-444: the daemon names the one alive text classification model itself; the per-runtime fields and the
// catalog are only for a daemon that predates it.
describe('loadedSystemOneModel with the text classification status', () => {
  it('is the Jev model, with its labels, when the daemon reports one on vLLM', () => {
    expect(loadedSystemOneModel(status({ textClassification: JEV_TEXT_CLASSIFIER }), undefined)).toEqual(JEV)
  })

  it('is the Laya model, with its checkpoints and no labels, when the daemon reports one on the Laya engine', () => {
    expect(loadedSystemOneModel(status({ textClassification: LAYA_TEXT_CLASSIFIER }), undefined)).toEqual({
      key: LAYA.key, name: LAYA.name, labels: [], checkpoints: LAYA.checkpoints, state: 'running', slot: 'pool',
    })
  })

  it('wins over the per-runtime fields and the catalog when it says nothing is loaded', () => {
    const catalog = [{ key: JEV.key, name: JEV.name, jev: JEV_INFO, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(status({ textClassification: null, jev: JEV, laya: LAYA }), catalog)).toBeNull()
  })
})

describe('loadedSystemOneModel', () => {
  it('is the Jev model when the daemon reports one', () => {
    expect(loadedSystemOneModel(status({ jev: JEV, laya: LAYA }), undefined)).toEqual(JEV)
  })

  it('is the Laya model, in its pool slot and with its checkpoints, when no Jev model is loaded', () => {
    expect(loadedSystemOneModel(status({ jev: null, laya: LAYA }), undefined)).toEqual({
      key: LAYA.key, name: LAYA.name, labels: [], checkpoints: LAYA.checkpoints, state: 'running', slot: 'pool',
    })
  })

  it('is nothing when the daemon reports neither, whatever the catalog says', () => {
    const catalog = [{ key: 'x', name: 'x', laya: { checkpoints: ['english'] }, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(status({ jev: null, laya: null }), catalog)).toBeNull()
  })

  it('falls back to a loaded Jev model in the catalog when the status cannot be read', () => {
    const catalog = [{ key: JEV.key, name: JEV.name, jev: JEV_INFO, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(undefined, catalog)).toEqual({
      key: JEV.key, name: JEV.name, labels: JEV_INFO.labels, state: 'running', slot: null,
    })
  })

  it('falls back to a loaded Laya model in the catalog when the status cannot be read', () => {
    const catalog = [{ key: LAYA.key, name: LAYA.name, laya: { checkpoints: ['english'] }, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(undefined, catalog)).toEqual({
      key: LAYA.key, name: LAYA.name, labels: [], checkpoints: ['english'], state: 'running', slot: 'pool',
    })
  })
})
