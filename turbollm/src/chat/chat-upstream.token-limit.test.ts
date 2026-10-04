// LiteRT-LM reads only `max_completion_tokens` (compat.ts applyEngineTokenLimit). The v1.14.5 release
// review found the rename applied to the main chat loop but NOT to the other requests that go through
// callChatUpstream — the auto-title (32 tokens), memory extraction and compaction — so on LiteRT-LM
// those ran uncapped to the context limit. callChatUpstream is the one outbound call, so the rename
// lives there, and only for the LOCAL engine: a Turbo Link host shapes the request for its own engine.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callChatUpstream, type ChatUpstream } from './chat-upstream'

const LOCAL_LITERT: ChatUpstream = { modelField: '/m/a.litertlm', modelName: 'a', ctxMax: 4096, target: 'http://engine.invalid', engineKind: 'litert-lm' }
const LOCAL_LLAMA: ChatUpstream = { ...LOCAL_LITERT, engineKind: 'llama-server' }
const REMOTE_FROM_LITERT_BOX: ChatUpstream = {
  modelField: 'qwen3-8b|Q4|123',
  modelName: 'Qwen3 8B',
  ctxMax: 8192,
  target: '',
  engineKind: 'litert-lm',
  remote: { linkId: 'lnk1', baseUrl: 'https://rig.invalid', token: 'tllm-hostsecret', modelKey: 'qwen3-8b|Q4|123' },
}

/** A fetch that records the JSON body it was sent and answers 200. */
function recordingFetch(): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, bodies }
}

test('a local LiteRT-LM request gets its cap as max_completion_tokens', async () => {
  const { fetchImpl, bodies } = recordingFetch()
  await callChatUpstream(LOCAL_LITERT, { model: 'm', max_tokens: 32, messages: [] }, undefined, fetchImpl)
  assert.equal(bodies[0].max_completion_tokens, 32)
  assert.equal('max_tokens' in bodies[0], false)
})

test("the caller's body object is not rewritten", async () => {
  const { fetchImpl } = recordingFetch()
  const body = { model: 'm', max_tokens: 32, messages: [] }
  await callChatUpstream(LOCAL_LITERT, body, undefined, fetchImpl)
  assert.equal(body.max_tokens, 32)
})

test('another local engine keeps max_tokens', async () => {
  const { fetchImpl, bodies } = recordingFetch()
  await callChatUpstream(LOCAL_LLAMA, { model: 'm', max_tokens: 32, messages: [] }, undefined, fetchImpl)
  assert.equal(bodies[0].max_tokens, 32)
  assert.equal('max_completion_tokens' in bodies[0], false)
})

test('a Turbo Link request keeps max_tokens even when the LOCAL engine is LiteRT-LM', async () => {
  const { fetchImpl, bodies } = recordingFetch()
  await callChatUpstream(REMOTE_FROM_LITERT_BOX, { model: 'm', max_tokens: 32, messages: [] }, undefined, fetchImpl)
  assert.equal(bodies[0].max_tokens, 32)
  assert.equal('max_completion_tokens' in bodies[0], false)
})
