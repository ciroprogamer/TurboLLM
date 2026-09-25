// Which loaded model the System One playground runs against (ADR-443): the Jev model when one is loaded, since it
// owns the Workspace, otherwise the Laya model. Status is the authority — its one text classification field first
// (ADR-444), then the per-runtime fields of an older daemon; the models list is the fallback for a client that
// cannot read /status (ADR-422).
import type { LayaStatus, LoadedJev, ModelEntry, Status, TextClassificationStatus } from './types'

export function loadedSystemOneModel(status: Status | undefined, models: ModelEntry[] | undefined): LoadedJev | null {
  if (status && 'textClassification' in status) {
    return status.textClassification ? fromTextClassificationStatus(status.textClassification) : null
  }
  if (status && 'jev' in status) {
    if (status.jev) return status.jev
    return status.laya ? fromLayaStatus(status.laya) : null
  }
  return fromCatalog(models ?? [])
}

function fromTextClassificationStatus(model: TextClassificationStatus): LoadedJev {
  const { key, name, state, slot } = model
  if (model.runtime === 'laya') return { key, name, labels: [], checkpoints: model.checkpoints ?? [], state, slot }
  return { key, name, labels: model.labels ?? [], state, slot }
}

/** A Laya model has no labels of its own (its questions carry them) and is always in its own pool slot. */
function fromLayaStatus(laya: LayaStatus): LoadedJev {
  return { key: laya.key, name: laya.name, labels: [], checkpoints: laya.checkpoints, state: laya.state, slot: 'pool' }
}

/** The catalog cannot tell a Jev model's slot, so it says null rather than guessing (ADR-427 (c)). */
function fromCatalog(models: ModelEntry[]): LoadedJev | null {
  const jev = models.find((m) => m.jev && m.loaded)
  if (jev?.jev) return { key: jev.key, name: jev.name, labels: jev.jev.labels, state: 'running', slot: null }
  const laya = models.find((m) => m.laya && m.loaded)
  if (laya?.laya) {
    return { key: laya.key, name: laya.name, labels: [], checkpoints: laya.laya.checkpoints, state: 'running', slot: 'pool' }
  }
  return null
}
