// Its own module because both hf.ts and text-classification-search.ts read it, and the search module importing
// hf.ts at runtime would close an import cycle (hf.ts runs the search).
import type { RawSearchItem } from './hf'

/** A row of HF's model list names its repo in `id`; `modelId` is the older field for the same thing. */
export function repoIdOf(model: Pick<RawSearchItem, 'id' | 'modelId'>): string {
  return model.id ?? model.modelId ?? ''
}
