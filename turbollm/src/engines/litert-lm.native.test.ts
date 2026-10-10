// The Android app's bundled LiteRT-LM engine: a native port of `litert-lm serve` shipped in the APK's nativeLibraryDir
// as liblitertlm_server.so (TurboLLM-Android, engines/litert-lm-server). It keeps the CLI's contract, so the litert-lm
// kind applies unchanged — these tests pin down only what differs because it is not Python, plus the registration and
// routing that let the app use it with no setup.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { packagedAppGpu } from '../sysinfo/sysinfo'
import { tmpDir } from '../test-support/tmp'
import { isNativeLitertLm, LITERT_LM_NATIVE_SERVER, litertLmNativeVersion, litertLmServerCommand } from './litert-lm'
import { pyEngineEnv } from './manager'
import { engineForModel, Registry } from './registry'
import { ensureAndroidBundledEngine } from './seed'
import { resolveUpdateSource } from './update'

/** A stand-in for the native server: answers `--version` exactly as the real one does. */
function fakeNativeServer(dir: string, litertVersion = '0.18.0'): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, LITERT_LM_NATIVE_SERVER)
  writeFileSync(bin, `#!/bin/sh\necho "turbollm-litertlm-server 1.0.0 (LiteRT-LM ${litertVersion})"\n`)
  chmodSync(bin, 0o755)
  return bin
}

function engine(over: Partial<Engine>): Engine {
  return { id: 'x', name: 'x', binPath: '/x', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...over }
}

function registry(engines: Engine[], activeEngineId: string): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  store.update((c) => {
    c.engines = engines
    c.activeEngineId = activeEngineId
  })
  return new Registry(store)
}

test('isNativeLitertLm: only the bundled server file is native — a venv python is not', () => {
  assert.equal(isNativeLitertLm('/data/app/~~x/com.turbollm-y/lib/arm64/liblitertlm_server.so'), true)
  assert.equal(isNativeLitertLm('/home/u/.turbollm/engines/litert-lm/venv/bin/python'), false)
  assert.equal(isNativeLitertLm('C:\\t\\engines\\litert-lm\\venv\\Scripts\\python.exe'), false)
})

test('litertLmServerCommand: the native server takes the same serve arguments, without python -m', () => {
  const native = litertLmServerCommand('/lib/liblitertlm_server.so', '/d/config-8081.json', 8081, '127.0.0.1', ['--verbose'])
  assert.deepEqual(native, {
    cmd: '/lib/liblitertlm_server.so',
    args: ['serve', '--config', '/d/config-8081.json', '--host', '127.0.0.1', '--port', '8081', '--verbose'],
  })
  const py = litertLmServerCommand('/venv/bin/python', '/d/config-8081.json', 8081, '127.0.0.1')
  assert.deepEqual(py.args.slice(0, 3), ['-m', 'litert_lm_cli.main', 'serve'])
})

test('litertLmNativeVersion: reads the runtime version from --version, in the stored pip-style form', async () => {
  const bin = fakeNativeServer(tmpDir('tllm-litert-native-'))
  assert.equal(await litertLmNativeVersion(bin), 'litert-lm 0.18.0')
})

test('pyEngineEnv: the native server gets the native library path, not a venv environment', () => {
  const dataDir = tmpDir('tllm-litert-native-')
  const native = pyEngineEnv('litert-lm', dataDir, '/app/lib/arm64/liblitertlm_server.so')!
  assert.match(native.LD_LIBRARY_PATH ?? '', /^\/app\/lib\/arm64(:|$)/)
  assert.equal(native.HF_HUB_OFFLINE, undefined)
  const py = pyEngineEnv('litert-lm', dataDir, '/venv/bin/python')!
  assert.equal(py.HF_HUB_OFFLINE, '1')
})

test('resolveUpdateSource: the bundled server updates with the app, never from PyPI', () => {
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so', version: 'litert-lm 0.18.0' })), null)
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/venv/bin/python', version: 'litert-lm 0.18.0' }))?.source, 'pip')
})

test('engineForModel: a .litertlm model goes to the LiteRT-LM engine while another kind is active', () => {
  const llama = engine({ id: 'llama', kind: 'llama-server' })
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const reg = registry([llama, litert], 'llama')
  assert.equal(engineForModel(reg, { laya: false, format: 'litertlm' })?.id, 'litert')
  assert.equal(engineForModel(reg, { laya: false, format: 'gguf' })?.id, 'llama')
  // No LiteRT-LM engine registered: the active one is still returned, and compat reports the mismatch as before.
  assert.equal(engineForModel(registry([llama], 'llama'), { laya: false, format: 'litertlm' })?.id, 'llama')
  // An active LiteRT-LM engine is used as-is.
  assert.equal(engineForModel(registry([llama, litert], 'litert'), { laya: false, format: 'litertlm' })?.id, 'litert')
})

test('repairBinPath: a non-llama engine is re-pointed without a llama-server probe', async () => {
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/old/liblitertlm_server.so', version: 'litert-lm 0.17.0' })
  const reg = registry([litert], 'litert')
  const out = await reg.repairBinPath('litert', '/new/liblitertlm_server.so', 'litert-lm 0.18.0')
  assert.equal(out.binPath, '/new/liblitertlm_server.so')
  assert.equal(out.version, 'litert-lm 0.18.0')
  assert.deepEqual(out.capabilities, { kvTypes: [], flags: [] })
})

test('ensureAndroidBundledEngine: registers the bundled LiteRT-LM server, then follows the APK to a new path', async (t) => {
  const prev = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  t.after(() => {
    if (prev === undefined) delete process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
    else process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = prev
  })
  t.mock.method(console, 'warn', () => {}) // the (absent) llama.cpp engine fails its probe; not under test here
  t.mock.method(console, 'log', () => {})
  const reg = registry([], '')

  const first = join(tmpDir('tllm-litert-native-'), 'lib')
  fakeNativeServer(first)
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = first
  await ensureAndroidBundledEngine(reg)
  let mine = reg.list().engines.filter((e) => e.kind === 'litert-lm')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].name, 'litert-lm-android')
  assert.equal(mine[0].binPath, join(first, LITERT_LM_NATIVE_SERVER))
  assert.equal(mine[0].version, 'litert-lm 0.18.0')
  const id = mine[0].id

  // A reinstall moves nativeLibraryDir and may ship a newer runtime: same engine, new path and version.
  const second = join(tmpDir('tllm-litert-native-'), 'lib')
  fakeNativeServer(second, '0.19.0')
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = second
  await ensureAndroidBundledEngine(reg)
  mine = reg.list().engines.filter((e) => e.kind === 'litert-lm')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].id, id)
  assert.equal(mine[0].binPath, join(second, LITERT_LM_NATIVE_SERVER))
  assert.equal(mine[0].version, 'litert-lm 0.19.0')
})

test('ensureAndroidBundledEngine: an APK built without LiteRT-LM registers no LiteRT-LM engine', async (t) => {
  const prev = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  t.after(() => {
    if (prev === undefined) delete process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
    else process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = prev
  })
  t.mock.method(console, 'warn', () => {})
  const reg = registry([], '')
  const dir = join(tmpDir('tllm-litert-native-'), 'lib')
  mkdirSync(dir, { recursive: true })
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = dir
  await ensureAndroidBundledEngine(reg)
  assert.equal(reg.list().engines.filter((e) => e.kind === 'litert-lm').length, 0)
})

test('packagedAppGpu: the app-reported GPU is a unified-memory device, and only inside the packaged app', () => {
  const app = { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/x/lib/arm64', TURBOLLM_ANDROID_GPU: 'Mali-G715' }
  const gpu = packagedAppGpu('android', app)
  assert.equal(gpu?.name, 'Mali-G715')
  assert.equal(gpu?.vendor, 'arm')
  assert.equal(gpu?.unified, true)
  assert.ok((gpu?.vramMb ?? 0) > 0)
  assert.equal(packagedAppGpu('android', { TURBOLLM_ANDROID_GPU: 'Mali-G715' }), null) // Termux: vulkaninfo decides
  assert.equal(packagedAppGpu('linux', app), null)
  assert.equal(packagedAppGpu('android', { ...app, TURBOLLM_ANDROID_GPU: '  ' }), null)
})
