// LiteRT-LM repos (litert-community/…) publish single-file .litertlm bundles with no GGUF or safetensors, so before
// this the repo view listed nothing and the only way to get a model onto the device was a manual download — which
// the standalone Android app has no way to do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HfClient } from './hf'

interface TreeEntry { type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } }

function withTree(tree: TreeEntry[], fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const body = String(url).includes('/tree/') ? tree : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return fn().finally(() => { globalThis.fetch = real })
}

const client = () => new HfClient(() => '', '0.0.0-test')

const TREE: TreeEntry[] = [
  { type: 'file', path: 'README.md', size: 5 },
  { type: 'file', path: 'gemma3-1b-it-int4.litertlm', lfs: { oid: 'aa', size: 584_000_000 } },
  { type: 'file', path: 'gemma3-1b-it-int8-ekv4096.litertlm', lfs: { oid: 'bb', size: 1_005_000_000 } },
]

test('getRepo: a LiteRT-LM repo lists each .litertlm bundle as one single-part model file', async () => {
  await withTree(TREE, async () => {
    const d = await client().getRepo('litert-community/Gemma3-1B-IT')
    assert.deepEqual(d.files.map((f) => [f.name, f.parts, f.mmproj, f.sizeBytes, f.sha256]), [
      ['gemma3-1b-it-int4.litertlm', 1, false, 584_000_000, 'aa'],
      ['gemma3-1b-it-int8-ekv4096.litertlm', 1, false, 1_005_000_000, 'bb'],
    ])
    assert.ok(d.files.every((f) => f.url.endsWith(f.name)))
    assert.equal(d.safetensors, undefined)
  })
})

test('getRepo: a repo with GGUFs keeps listing its GGUFs even if it also carries a .litertlm', async () => {
  await withTree([...TREE, { type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'cc', size: 100 } }], async () => {
    const d = await client().getRepo('some/mixed')
    assert.deepEqual(d.files.map((f) => f.name), ['model-Q4_K_M.gguf'])
  })
})

test('expandModelFiles: a .litertlm downloads alone — no shards, no projector', async () => {
  await withTree([...TREE, { type: 'file', path: 'mmproj-F16.gguf', lfs: { oid: 'p', size: 10 } }], async () => {
    const { dir, files } = await client().expandModelFiles('litert-community/Gemma3-1B-IT', 'gemma3-1b-it-int4.litertlm')
    assert.equal(dir, '')
    assert.deepEqual(files, [{ rfilename: 'gemma3-1b-it-int4.litertlm', size: 584_000_000, sha256: 'aa', mmproj: false }])
  })
})
