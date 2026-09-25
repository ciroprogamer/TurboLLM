import type { ModelEntry, TextClassificationStatus } from './types'

export type TextClassificationRuntime = TextClassificationStatus['runtime']

const RUNTIME_LABELS: Record<TextClassificationRuntime, string> = { vllm: 'vLLM', laya: 'Laya engine' }

/** A model a chat/code/routine turn can run on. Jev models label text; they never chat. */
export function isChatModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return !isSystemOneModel(m)
}

/** A model that answers through POST /v1/systemone — a Jev NLI classifier (on vLLM) or a Laya
 *  decision model (on its own 'laya' engine). Used by the text classification playground's model
 *  picker (SwitchModelMenu) to group "not a chat model" rows together regardless of which of the
 *  two it is. */
export function isSystemOneModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return !!m.jev || !!m.laya
}

/** Which runtime serves a text classification model (ADR-444), or null for a chat model. Structural, so a load
 *  target's nullable descriptors fit as well as a catalog entry's. */
export function textClassificationRuntime(m: { jev?: object | null; laya?: object | null }): TextClassificationRuntime | null {
  if (m.jev) return 'vllm'
  if (m.laya) return 'laya'
  return null
}

/** The quiet label that says which runtime serves a text classification model, beside the one name both share. */
export function textClassificationRuntimeLabel(runtime: TextClassificationRuntime): string {
  return RUNTIME_LABELS[runtime]
}
