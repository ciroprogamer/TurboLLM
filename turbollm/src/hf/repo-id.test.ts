import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repoIdOf } from './repo-id'

test('a listed repo is known by its id', () => {
  assert.equal(repoIdOf({ id: 'convaiinnovations/laya', modelId: 'old/name' }), 'convaiinnovations/laya')
})

test('a row with no id is known by its modelId', () => {
  assert.equal(repoIdOf({ modelId: 'MoritzLaurer/DeBERTa-v3-base-mnli' }), 'MoritzLaurer/DeBERTa-v3-base-mnli')
})

test('a row that names neither has an empty id', () => {
  assert.equal(repoIdOf({}), '')
})
