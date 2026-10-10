// Which engine is serving the loaded model. Not the same as `registry.active()` since `.litertlm` models load on the
// LiteRT-LM engine whichever engine is active (engineForModel): with llama-server active, a LiteRT-LM model is served
// by LiteRT-LM, and every request has to be shaped for LiteRT-LM (the model path in `model`, max_completion_tokens).
import type { Engine } from '../config/config'
import type { Deps } from '../deps'

/** The engine the running (or starting) model was launched on, else the active one. */
export function servingEngine(d: Pick<Deps, 'registry' | 'manager'>): Engine | null {
  return d.manager.currentOpts()?.engine ?? d.registry.active() ?? null
}

/** The kind of {@link servingEngine}, '' when there is none. */
export function servingEngineKind(d: Pick<Deps, 'registry' | 'manager'>): string {
  return servingEngine(d)?.kind ?? ''
}
