// Jev and Laya share one name, "Text classification" (ADR-444); what still differs is the runtime that serves the
// model, so a model row names it quietly beside the name. Nothing for a chat model.
import { textClassificationRuntime, textClassificationRuntimeLabel } from '../lib/model-kind'
import type { ModelEntry } from '../lib/types'

export function TextClassificationRuntimeLabel({ model }: { model: Pick<ModelEntry, 'jev' | 'laya'> }) {
  const runtime = textClassificationRuntime(model)
  if (!runtime) return null
  return <span className="shrink-0 whitespace-nowrap text-[11px] text-muted">{textClassificationRuntimeLabel(runtime)}</span>
}
