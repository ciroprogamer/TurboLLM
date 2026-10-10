// An engine error delivered inside a 200 SSE stream must reach the user, not end the turn as an empty message.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { litertLmTurnErrorMessage } from '../engines/litert-lm'
import { streamChunkError } from './chat-routes'

test('streamChunkError: reads both error shapes and ignores ordinary chunks', () => {
  assert.equal(streamChunkError({ error: 'RuntimeError: boom' }), 'RuntimeError: boom')
  assert.equal(streamChunkError({ error: { message: 'context full', code: 500 } }), 'context full')
  assert.equal(streamChunkError({ choices: [{ delta: { content: 'hi' } }] }), null)
  assert.equal(streamChunkError({ error: '' }), null)
})

test('litertLmTurnErrorMessage: explains a context-limit failure and leaves others alone', () => {
  assert.match(litertLmTurnErrorMessage('RuntimeError: Input token ids are too long. Exceeding the maximum number of tokens allowed: 15123 >= 4096'), /shorter system prompt/)
  assert.equal(litertLmTurnErrorMessage('RuntimeError: GPU lost'), 'RuntimeError: GPU lost')
})
