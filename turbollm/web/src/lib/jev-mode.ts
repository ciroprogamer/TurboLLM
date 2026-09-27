// Which Workspace the user gets (ADR-434 (b), (i)(1)): while a Jev model is loaded, Workspace
// is the text classification playground and nothing else — Chat, Code and Routines are hidden,
// not killed. A Laya model opens the same playground but never takes the Workspace over (ADR-443).
//
// Pure on purpose. The gate that calls this runs on every /workspace* render, and the one
// failure mode that matters is a redirect loop, so the rules have to be testable without a
// router, a store or a poll.
import { isSystemOneModel } from './model-kind'
import type { ModelEntry, ModelsList, Status } from './types'

export const TEXT_CLASSIFICATION_PATH = '/workspace/text-classification'

/** The playground's URL before ADR-444. Kept only so a bookmark of it still lands there. */
export const LEGACY_JEV_PATH = '/workspace/jev'

/** 'unknown' is a real answer, not a missing one: a Turbo Link token scoped to `models:use`
 *  cannot read /status at all, and guessing "none" would bounce a deep link. */
export type JevPresence = 'unknown' | 'none' | 'loaded'

export const CHAT_PATH = '/workspace/chat'

const WORK_PATHS = [CHAT_PATH, '/workspace/code', '/workspace/routines']

/** Status is the authority — its one text classification field first (ADR-444), where only a model on vLLM takes
 *  the Workspace over; then an older daemon's `jev` field. The models list is the fallback for a client that
 *  cannot read it. */
export function jevPresence(status: Status | undefined, models: ModelEntry[] | undefined): JevPresence {
  if (status && 'textClassification' in status) return status.textClassification?.runtime === 'vllm' ? 'loaded' : 'none'
  if (status && 'jev' in status) return status.jev ? 'loaded' : 'none'
  if (models) return models.some((m) => m.jev && m.loaded) ? 'loaded' : 'none'
  return 'unknown'
}

/** The three sections a loaded Jev model takes over. Exact path or a sub-route of it —
 *  '/workspace/chatter' is a different section, not a chat. */
export function isWorkspaceWorkPath(pathname: string): boolean {
  return WORK_PATHS.some((p) => isAtOrUnder(pathname, p))
}

/** Where this Workspace URL really belongs, or null to leave it alone. `notice` asks the
 *  destination to explain itself — only the trip INTO the playground needs explaining. */
export function workspaceRedirect(
  pathname: string,
  presence: JevPresence,
  playgroundIsAvailable = false,
): { to: string; notice: boolean } | null {
  if (presence === 'unknown') return null
  if (presence === 'loaded' && isWorkspaceWorkPath(pathname)) return { to: TEXT_CLASSIFICATION_PATH, notice: true }
  if (presence === 'none' && !playgroundIsAvailable && isAtOrUnder(pathname, TEXT_CLASSIFICATION_PATH)) {
    return { to: CHAT_PATH, notice: false }
  }
  return null
}

function isAtOrUnder(pathname: string, section: string): boolean {
  return pathname === section || pathname.startsWith(`${section}/`)
}

/** The library as the rules here read it, or undefined while it is not read yet. Right after a daemon restart the
 *  models list answers empty while its first scan runs: that is "not read yet", not "the library holds nothing". */
export function modelsOnceScanned(data: ModelsList | undefined): ModelEntry[] | undefined {
  if (data?.scanning && data.models.length === 0) return undefined
  return data?.models
}

/** Whether the Workspace offers its "Text classification" tab (ADR-444, amended 2026-09-25): one is loaded, or the
 *  library holds one to load. It stays after an eject, so the tab never vanishes under the user. */
export function hasTextClassifier(status: Status | undefined, models: ModelEntry[] | undefined): boolean {
  return statusReportsTextClassifier(status) || libraryHoldsTextClassifier(models)
}

/** The one field is the authority (ADR-444); an older daemon names each runtime's model in a field of its own. */
function statusReportsTextClassifier(status: Status | undefined): boolean {
  if (status && 'textClassification' in status) return !!status.textClassification
  return !!status?.jev || !!status?.laya
}

/** Whether the playground has something to offer: a text classification model loaded to run, or one in the library
 *  to load from its list (ADR-444, amended 2026-09-25). A library not read yet counts as holding one — status often
 *  answers first, and sending the page to chat then would bounce a deep link on a guess. */
export function playgroundAvailable(status: Status | undefined, models: ModelEntry[] | undefined): boolean {
  if (models === undefined) return true
  return textClassifierLoaded(status, models) || libraryHoldsTextClassifier(models)
}

function libraryHoldsTextClassifier(models: ModelEntry[] | undefined): boolean {
  return models?.some(isSystemOneModel) ?? false
}

/** The one status field is the authority (ADR-444). An older daemon's answer is whether a Laya model is loaded: a
 *  Jev model there is `jevPresence`'s to report, and the gate asks that first. */
function textClassifierLoaded(status: Status | undefined, models: ModelEntry[]): boolean {
  if (status && 'textClassification' in status) return !!status.textClassification
  return layaLoaded(status, models)
}

/** Status is the authority; the models list is the fallback for a client that cannot read it (ADR-443). */
function layaLoaded(status: Status | undefined, models: ModelEntry[]): boolean {
  if (status && 'laya' in status) return !!status.laya
  return models.some((m) => m.laya && m.loaded)
}
