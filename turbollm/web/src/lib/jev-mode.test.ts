// ADR-434 (b), (i)(1): while a Jev model is loaded, Workspace IS the playground.
//
// The rules live here, pure, because the mistake they guard against is a redirect loop:
// 'unknown' must never redirect (a Turbo Link token scoped to models:use cannot read
// /status, so "I can't tell" would otherwise read as "nothing loaded" and bounce a deep
// link the user typed on purpose).
import { describe, expect, it } from 'vitest'
import {
  TEXT_CLASSIFICATION_PATH,
  hasTextClassifier,
  isWorkspaceWorkPath,
  jevPresence,
  playgroundAvailable,
  workspaceRedirect,
} from './jev-mode'
import type { JevInfo, JevStatus, ModelEntry, Status, TextClassificationStatus } from './types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

const LOADED: JevStatus = {
  key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
}

function statusWith(jev: JevStatus | null): Status {
  return { jev } as unknown as Status
}

/** A status from a daemon that predates the field, or the Turbo Link façade's. */
function statusWithoutJevField(): Status {
  return {} as unknown as Status
}

function model(fields: Partial<ModelEntry>): ModelEntry {
  return fields as ModelEntry
}

const JEV_TEXT_CLASSIFIER: TextClassificationStatus = {
  key: LOADED.key, name: LOADED.name, runtime: 'vllm', state: 'running', slot: 'primary', labels: LOADED.labels,
}
const LAYA_TEXT_CLASSIFIER: TextClassificationStatus = {
  key: 'laya|laya|1455', name: 'laya', runtime: 'laya', state: 'running', slot: 'pool', checkpoints: ['english'],
}

/** What this daemon sends: the per-runtime fields beside the one text classification field. */
function statusWithTextClassifier(textClassification: TextClassificationStatus): Status {
  return { textClassification, jev: null, laya: null } as unknown as Status
}

describe('jevPresence', () => {
  it('reads a loaded Jev model straight off status', () => {
    expect(jevPresence(statusWith(LOADED), undefined)).toBe('loaded')
  })

  it('reads an explicit null as "none", even with a stale models list saying otherwise', () => {
    expect(jevPresence(statusWith(null), [model({ jev: JEV_INFO, loaded: true })])).toBe('none')
  })

  it('falls back to the models list when status carries no jev field at all', () => {
    expect(jevPresence(statusWithoutJevField(), [model({ jev: JEV_INFO, loaded: true })])).toBe('loaded')
    expect(jevPresence(statusWithoutJevField(), [model({ jev: JEV_INFO, loaded: false })])).toBe('none')
    expect(jevPresence(statusWithoutJevField(), [model({ loaded: true })])).toBe('none')
    expect(jevPresence(statusWithoutJevField(), [])).toBe('none')
  })

  it('is "unknown" while nothing has been read yet — never guessed as "none"', () => {
    expect(jevPresence(undefined, undefined)).toBe('unknown')
    expect(jevPresence(statusWithoutJevField(), undefined)).toBe('unknown')
  })

  it('uses the models list when status has not arrived yet', () => {
    expect(jevPresence(undefined, [model({ jev: JEV_INFO, loaded: true })])).toBe('loaded')
    expect(jevPresence(undefined, [])).toBe('none')
  })
})

// ADR-444: one status field names the text classification model and its runtime. Only a model on vLLM (a Jev
// model) takes the Workspace over; a Laya model never does.
describe('jevPresence with the text classification status', () => {
  it('is "loaded" for a model on vLLM', () => {
    expect(jevPresence(statusWithTextClassifier(JEV_TEXT_CLASSIFIER), undefined)).toBe('loaded')
  })

  it('is "none" for a model on the Laya engine, even with a Jev model in a stale catalog', () => {
    expect(jevPresence(statusWithTextClassifier(LAYA_TEXT_CLASSIFIER), [model({ jev: JEV_INFO, loaded: true })])).toBe('none')
  })

  it('is "none" when nothing is loaded, even with an older field saying otherwise', () => {
    const stale = { textClassification: null, jev: LOADED } as unknown as Status
    expect(jevPresence(stale, undefined)).toBe('none')
  })
})

describe('isWorkspaceWorkPath', () => {
  it('matches the three work sections and their sub-routes', () => {
    for (const p of ['/workspace/chat', '/workspace/code', '/workspace/routines']) {
      expect(isWorkspaceWorkPath(p)).toBe(true)
      expect(isWorkspaceWorkPath(`${p}/abc123`)).toBe(true)
    }
  })

  it('does not match a section whose name merely starts the same way', () => {
    expect(isWorkspaceWorkPath('/workspace/chatter')).toBe(false)
    expect(isWorkspaceWorkPath('/workspace/coder')).toBe(false)
    expect(isWorkspaceWorkPath('/workspace/routiness')).toBe(false)
  })

  it('does not match the playground, bare /workspace, or anything outside it', () => {
    expect(isWorkspaceWorkPath(TEXT_CLASSIFICATION_PATH)).toBe(false)
    expect(isWorkspaceWorkPath('/workspace')).toBe(false)
    expect(isWorkspaceWorkPath('/models')).toBe(false)
    expect(isWorkspaceWorkPath('/chat/abc123')).toBe(false)
  })
})

describe('workspaceRedirect', () => {
  it('sends work routes to the playground, with the notice, while a Jev model is loaded', () => {
    expect(workspaceRedirect('/workspace/chat', 'loaded')).toEqual({ to: TEXT_CLASSIFICATION_PATH, notice: true })
    expect(workspaceRedirect('/workspace/code/abc123', 'loaded')).toEqual({ to: TEXT_CLASSIFICATION_PATH, notice: true })
    expect(workspaceRedirect('/workspace/routines/new', 'loaded')).toEqual({ to: TEXT_CLASSIFICATION_PATH, notice: true })
  })

  it('leaves the playground itself alone while one is loaded', () => {
    expect(workspaceRedirect(TEXT_CLASSIFICATION_PATH, 'loaded')).toBeNull()
    expect(workspaceRedirect(`${TEXT_CLASSIFICATION_PATH}/anything`, 'loaded')).toBeNull()
  })

  it('sends the playground back to chat, without a notice, when none is loaded', () => {
    expect(workspaceRedirect(TEXT_CLASSIFICATION_PATH, 'none')).toEqual({ to: '/workspace/chat', notice: false })
    expect(workspaceRedirect(`${TEXT_CLASSIFICATION_PATH}/anything`, 'none')).toEqual({ to: '/workspace/chat', notice: false })
  })

  it('leaves the work routes alone when none is loaded', () => {
    expect(workspaceRedirect('/workspace/chat', 'none')).toBeNull()
    expect(workspaceRedirect('/workspace/code/abc123', 'none')).toBeNull()
  })

  it('never redirects on a guess — "unknown" leaves every route where it is', () => {
    expect(workspaceRedirect('/workspace/chat', 'unknown')).toBeNull()
    expect(workspaceRedirect(TEXT_CLASSIFICATION_PATH, 'unknown')).toBeNull()
    expect(workspaceRedirect('/workspace/code/abc123', 'unknown')).toBeNull()
  })

  it('never touches a route outside Workspace, whatever is loaded', () => {
    for (const presence of ['unknown', 'none', 'loaded'] as const) {
      expect(workspaceRedirect('/models', presence)).toBeNull()
      expect(workspaceRedirect('/engines', presence)).toBeNull()
      expect(workspaceRedirect('/chat/abc123', presence)).toBeNull()
    }
  })

  it('leaves bare /workspace to the router, which already sends it to chat', () => {
    expect(workspaceRedirect('/workspace', 'loaded')).toBeNull()
    expect(workspaceRedirect('/workspace', 'none')).toBeNull()
  })
})

describe('workspaceRedirect with a Laya model loaded', () => {
  it('keeps the playground open while a Laya model is loaded and no Jev model is', () => {
    expect(workspaceRedirect(TEXT_CLASSIFICATION_PATH, 'none', true)).toBeNull()
  })

  it('never takes chat, code or routines over: a Laya model runs beside the chat model', () => {
    expect(workspaceRedirect('/workspace/chat', 'none', true)).toBeNull()
    expect(workspaceRedirect('/workspace/code/abc123', 'none', true)).toBeNull()
  })

  it('still sends the playground back to chat when neither kind is loaded', () => {
    expect(workspaceRedirect(TEXT_CLASSIFICATION_PATH, 'none', false)).toEqual({ to: '/workspace/chat', notice: false })
  })
})

const NOTHING_LOADED = { textClassification: null, jev: null, laya: null } as unknown as Status
const LIBRARY_LAYA = model({ key: 'laya|laya|1455', name: 'laya', laya: { checkpoints: ['english'] }, loaded: false })
const LIBRARY_JEV = model({ key: LOADED.key, name: LOADED.name, jev: JEV_INFO, loaded: false })
const LIBRARY_CHAT = model({ key: 'gemma-27b', name: 'Gemma 27B', loaded: true })

// ADR-444, amended 2026-09-25: the Workspace's "Text classification" tab is there whenever the user has such a model
// to use — loaded, or waiting in the library — and stays after an eject.
describe('hasTextClassifier', () => {
  it('is true while one is loaded, even before the library has been read', () => {
    expect(hasTextClassifier(statusWithTextClassifier(LAYA_TEXT_CLASSIFIER), undefined)).toBe(true)
    expect(hasTextClassifier(statusWithTextClassifier(JEV_TEXT_CLASSIFIER), undefined)).toBe(true)
  })

  it('is true when the library holds one and nothing is loaded, whichever runtime serves it', () => {
    expect(hasTextClassifier(NOTHING_LOADED, [LIBRARY_CHAT, LIBRARY_LAYA])).toBe(true)
    expect(hasTextClassifier(NOTHING_LOADED, [LIBRARY_JEV])).toBe(true)
  })

  it('is false when the library holds only chat models and nothing is loaded', () => {
    expect(hasTextClassifier(NOTHING_LOADED, [LIBRARY_CHAT])).toBe(false)
    expect(hasTextClassifier(NOTHING_LOADED, [])).toBe(false)
  })

  it('is false while nothing has been read yet', () => {
    expect(hasTextClassifier(undefined, undefined)).toBe(false)
  })

  it('reads the library for an older daemon that has no text classification field', () => {
    expect(hasTextClassifier(statusWith(null), [LIBRARY_LAYA])).toBe(true)
    expect(hasTextClassifier(statusWith(null), [LIBRARY_CHAT])).toBe(false)
  })
})

describe('playgroundAvailable', () => {
  const LAYA_STATUS = { key: 'laya|laya|1455', name: 'laya', checkpoints: ['english'], state: 'running' as const }

  it('is true for a text classification model on either runtime', () => {
    expect(playgroundAvailable(statusWithTextClassifier(JEV_TEXT_CLASSIFIER), [])).toBe(true)
    expect(playgroundAvailable(statusWithTextClassifier(LAYA_TEXT_CLASSIFIER), [])).toBe(true)
  })

  it('is true with nothing loaded while the library holds one to load', () => {
    expect(playgroundAvailable(NOTHING_LOADED, [LIBRARY_CHAT, LIBRARY_LAYA])).toBe(true)
    expect(playgroundAvailable(NOTHING_LOADED, [LIBRARY_JEV])).toBe(true)
  })

  it('is false with nothing loaded and none in the library', () => {
    expect(playgroundAvailable(NOTHING_LOADED, [LIBRARY_CHAT])).toBe(false)
    expect(playgroundAvailable(NOTHING_LOADED, [])).toBe(false)
  })

  it('counts a library it has not read yet as holding one: a guess must not bounce the page to chat', () => {
    expect(playgroundAvailable(NOTHING_LOADED, undefined)).toBe(true)
  })

  it('reads an older daemon\'s laya field', () => {
    expect(playgroundAvailable({ laya: LAYA_STATUS } as unknown as Status, [])).toBe(true)
    expect(playgroundAvailable({ laya: null } as unknown as Status, [LIBRARY_CHAT])).toBe(false)
  })

  it('falls back to the catalog when the status cannot be read', () => {
    expect(playgroundAvailable(undefined, [{ ...LIBRARY_LAYA, loaded: true }])).toBe(true)
    expect(playgroundAvailable(undefined, [LIBRARY_CHAT])).toBe(false)
  })
})

// What the Workspace gate composes: the playground's own URL with nothing loaded.
describe('the playground with nothing loaded', () => {
  function redirectOf(status: Status | undefined, models: ModelEntry[] | undefined) {
    return workspaceRedirect(TEXT_CLASSIFICATION_PATH, jevPresence(status, models), playgroundAvailable(status, models))
  }

  it('stays open when the library holds a text classification model', () => {
    expect(redirectOf(NOTHING_LOADED, [LIBRARY_CHAT, LIBRARY_LAYA])).toBeNull()
  })

  it('goes back to chat when the library holds none', () => {
    expect(redirectOf(NOTHING_LOADED, [LIBRARY_CHAT])).toEqual({ to: '/workspace/chat', notice: false })
  })

  it('never redirects while nothing has been read', () => {
    expect(redirectOf(undefined, undefined)).toBeNull()
  })
})
