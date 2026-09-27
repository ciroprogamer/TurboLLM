// Which text classification model is alive (ADR-444): Jev and Laya are two runtimes behind one feature, so the UI
// reads one field. Built from the per-runtime `jev` and `laya` status fields, which stay as they are. Local-only,
// like them — never part of the shared `buildModelStatus`.
import type { Deps } from '../deps'
import type { JevLabel } from '../models/jev'
import type { TextClassifierRuntime } from '../models/text-classifier'
import { jevStatus, type JevStatus } from './jev-status'
import { layaStatus, type LayaStatus } from './laya-status'

export interface TextClassificationStatus {
  key: string
  name: string
  runtime: TextClassifierRuntime
  state: 'starting' | 'running' | 'stopping'
  slot: 'primary' | 'pool'
  labels?: JevLabel[]
  checkpoints?: string[]
}

/** The alive text classification model, or null. When a Jev and a Laya model are both alive the Jev one wins: the
 *  Workspace follows a Jev model, exactly as the web's `status.jev ?? status.laya` chose before this field. */
export function textClassificationStatus(d: Pick<Deps, 'modelRouter' | 'scanner'>): TextClassificationStatus | null {
  const jev = jevStatus(d)
  if (jev) return fromJev(jev)
  const laya = layaStatus(d)
  return laya ? fromLaya(laya) : null
}

function fromJev({ key, name, state, slot, labels }: JevStatus): TextClassificationStatus {
  return { key, name, runtime: 'vllm', state, slot, labels }
}

/** A Laya model is never in the primary (ADR-443 (4)). */
function fromLaya({ key, name, state, checkpoints }: LayaStatus): TextClassificationStatus {
  return { key, name, runtime: 'laya', state, slot: 'pool', checkpoints }
}
