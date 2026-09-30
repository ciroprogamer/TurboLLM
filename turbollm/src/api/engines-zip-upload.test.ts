// Route-level tests for POST /api/v1/engines/zip — the .zip-upload source of the Add-engine
// flow. Same "real Hono app, minimal Deps double" discipline as keys-network.test.ts: the
// route's guards (auth, W^X, busy, running-engine replacement) and error envelope are only
// reachable through a real request Context. The happy path with a probed binary is covered
// by zip-install.test.ts against an injectable probe — here the "binary" is deliberately
// garbage, which exercises the real probe's clean probe_failed failure instead.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { serverBinName } from '../engines/scan'

interface FakeOverrides {
  lanBind?: boolean
  requireApiKey?: boolean
  /** 'download' | 'build' — an engine work phase in flight. */
  busy?: 'download' | 'build'
  /** A live registered engine whose binary lives under the upload's target dir. */
  runningEngine?: { name: string; binPath: string }
}

function zipApp(o: FakeOverrides, dataDir: string): Hono {
  const cfg = {
    daemon: { lanBind: o.lanBind ?? false, requireApiKey: o.requireApiKey ?? false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, dir: () => dataDir },
    manager: { status: () => ({ state: o.runningEngine ? 'running' : 'stopped', err: null, port: 0, pid: 0, model: null }) },
    provision: { get: () => ({ active: o.busy === 'download' }) },
    build: { isActive: () => o.busy === 'build' },
    registry: {
      active: () => (o.runningEngine ? { id: 'e1', name: o.runningEngine.name, binPath: o.runningEngine.binPath, kind: 'llama-server' } : undefined),
      list: () => ({ engines: [], activeEngineId: '' }),
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

async function postZip(app: Hono, bytes: Buffer, fileName = 'myfork.zip'): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([bytes], fileName))
  return app.request('/api/v1/engines/zip', { method: 'POST', body: form })
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.startsWith('application/json'), true)
  return ((await res.json()) as { error: { code: string; message: string } }).error
}

test('POST /api/v1/engines/zip: 403 for a non-host caller on an open, keyless LAN', async () => {
  // app.request() carries no TCP connection, so isLoopback fails closed to null — exactly
  // the "non-host viewer" case (see keys-network.test.ts for the same trick).
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({ lanBind: true, requireApiKey: false }, dir), Buffer.from('x'))
    assert.equal(res.status, 403)
    assert.equal((await errorBody(res)).code, 'forbidden')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 400 when the form has no "file" field', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await zipApp({}, dir).request('/api/v1/engines/zip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'somewhere' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'invalid_config_value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 400 bad_zip for a non-zip upload', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({}, dir), Buffer.from('definitely not a zip archive'))
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'bad_zip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: no server binary → {found:false}, and nothing is written to disk', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({}, dir), buildZipArchive([{ name: 'docs/readme.txt', data: Buffer.from('hi') }]))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { found: false })
    assert.equal(existsSync(join(dir, 'engines', 'build')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: an unrunnable binary fails the probe with 400 and cleans the extraction', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    // Real probe, garbage bytes: detectFormat passes (unknown), execution fails on every
    // OS → ProbeError('probe_failed') — and the half-installed dir must be gone.
    const zip = buildZipArchive([{ name: `bin/${serverBinName}`, data: Buffer.from('garbage — not an executable') }])
    const res = await postZip(zipApp({}, dir), zip)
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'probe_failed')
    assert.equal(existsSync(join(dir, 'engines', 'build', 'myfork')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 while an engine download is in flight', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({ busy: 'download' }, dir), Buffer.from('x'))
    assert.equal(res.status, 409)
    assert.equal((await errorBody(res)).code, 'engine_already_running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 when the upload would replace the RUNNING engine\'s build dir', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const running = { name: 'My Fork', binPath: join(dir, 'engines', 'build', 'myfork', serverBinName) }
    const res = await postZip(zipApp({ runningEngine: running }, dir), Buffer.from('x'))
    assert.equal(res.status, 409)
    const e = await errorBody(res)
    assert.equal(e.code, 'engine_in_use')
    assert.match(e.message, /My Fork/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
