import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  androidWheelAbi,
  classifyLitertLmBlocker,
  litertLmConfigPath,
  litertLmEnvFingerprint,
  litertLmLoadFailureMessage,
  litertLmPathBlocker,
  litertLmPrefillStats,
  litertLmProfileToConfig,
  litertLmServeBlocker,
  litertLmServeBlockerCached,
  litertLmServerCommand,
  pickAndroidWheel,
  warmUpLitertLm,
  writeLitertLmConfig,
} from './litert-lm'
import { tmpDir } from '../test-support/tmp'

test('litertLmProfileToConfig: GPU layers on a machine with a GPU select the gpu backend', () => {
  assert.equal(litertLmProfileToConfig({ ctx: 4096, ngl: 99, threads: 0 }, true).default.backend, 'gpu')
})

test('litertLmProfileToConfig: no GPU, or zero GPU layers, selects the cpu backend', () => {
  assert.equal(litertLmProfileToConfig({ ctx: 4096, ngl: 99, threads: 0 }, false).default.backend, 'cpu')
  assert.equal(litertLmProfileToConfig({ ctx: 4096, ngl: 0, threads: 0 }, true).default.backend, 'cpu')
})

test('litertLmProfileToConfig: ctx becomes max_num_tokens and threads becomes cpu_thread_count only when set', () => {
  assert.deepEqual(litertLmProfileToConfig({ ctx: 8192, ngl: 0, threads: 6 }, false), {
    default: { backend: 'cpu', max_num_tokens: 8192, cpu_thread_count: 6 },
  })
  const auto = litertLmProfileToConfig({ ctx: 0, ngl: 0, threads: 0 }, false)
  assert.deepEqual(auto, { default: { backend: 'cpu' } })
  assert.ok(!('cpu_thread_count' in auto.default))
  assert.ok(!('max_num_tokens' in auto.default))
})

test('litertLmPathBlocker: a comma anywhere in the path is refused, a clean path is not', () => {
  assert.match(litertLmPathBlocker('/models/a,b/model.litertlm') ?? '', /comma/)
  assert.match(litertLmPathBlocker('/models/model,v2.litertlm') ?? '', /comma/)
  assert.equal(litertLmPathBlocker('/models/my model (v2)/model.litertlm'), null)
})

test('litertLmServerCommand: runs the CLI as a module with an explicit config, host and port, extra args last', () => {
  assert.deepEqual(litertLmServerCommand('/venv/bin/python', '/data/cfg.json', 8085, '127.0.0.1', ['--verbose']), {
    cmd: '/venv/bin/python',
    args: ['-m', 'litert_lm_cli.main', 'serve', '--config', '/data/cfg.json', '--host', '127.0.0.1', '--port', '8085', '--verbose'],
  })
  assert.deepEqual(litertLmServerCommand('py', 'c.json', 1, 'h').args.slice(-2), ['--port', '1'])
})

test('the config file is per port and round-trips what was written', (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cfg-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = litertLmConfigPath(dir, 8081)
  const b = litertLmConfigPath(dir, 8082)
  assert.notEqual(a, b)
  assert.equal(a, join(dir, 'engines', 'litert-lm', 'config-8081.json'))
  writeLitertLmConfig(a, { default: { backend: 'gpu', max_num_tokens: 2048 } })
  writeLitertLmConfig(b, { default: { backend: 'cpu' } })
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), { default: { backend: 'gpu', max_num_tokens: 2048 } })
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')), { default: { backend: 'cpu' } })
  assert.ok(existsSync(a) && existsSync(b))
})

test('classifyLitertLmBlocker: an unsupported platform/arch is named as having no build', () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['freebsd', 'x64'], ['android', 'arm'], ['android', 'ia32']] as const) {
    assert.match(classifyLitertLmBlocker(platform, arch, new Error('x')), /only for Windows x64, Linux x64\/arm64, macOS on Apple Silicon and Android/)
  }
})

test('classifyLitertLmBlocker: a supported platform reports a load failure with the last stderr line, capped', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['android', 'arm64'], ['android', 'x64']] as const) {
    const msg = classifyLitertLmBlocker(platform, arch, new Error('Traceback\r\nImportError: libc too old'))
    assert.doesNotMatch(msg, /no build/)
    assert.match(msg, /ImportError: libc too old/)
    assert.match(msg, platform === 'android' ? /API 23.*Termux/ : /glibc 2\.27/)
  }
  const long = classifyLitertLmBlocker('linux', 'x64', new Error('E: ' + 'x'.repeat(5000)))
  assert.ok(long.length < 600)
})

test('litertLmLoadFailureMessage: the GPU hint names the Backend control, which is the one the LiteRT-LM panel actually offers', () => {
  // "Set GPU layers to 0" is llama.cpp advice — that slider is not rendered for LiteRT-LM
  // (PR #271 review), so the hint must point at the real recovery path: Backend → CPU.
  assert.match(litertLmLoadFailureMessage('boom', 'gpu'), /Backend setting to CPU/)
  assert.doesNotMatch(litertLmLoadFailureMessage('boom', 'gpu'), /GPU layers/)
  assert.match(litertLmLoadFailureMessage('boom', 'cpu'), /complete \.litertlm bundle/)
  assert.match(litertLmLoadFailureMessage('boom', 'cpu'), /— boom\./)
})

// ── warm-up against a local stand-in for `litert-lm serve` ───────────────────
function fakeServe(t: TestContext, status: number, statusText: string, seen: { body?: Record<string, unknown> }): Promise<number> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.body = JSON.parse(raw || '{}')
        res.statusMessage = statusText
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    t.after(() => { server.close() })
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

test('warmUpLitertLm: a 200 means the model loaded; it asks for exactly one token via max_completion_tokens', async (t) => {
  const seen: { body?: Record<string, unknown> } = {}
  const port = await fakeServe(t, 200, 'OK', seen)
  const res = await warmUpLitertLm(port, '/models/m.litertlm', AbortSignal.timeout(5000))
  assert.deepEqual(res, { ok: true })
  assert.equal(seen.body?.model, '/models/m.litertlm')
  assert.equal(seen.body?.max_completion_tokens, 1)
  assert.equal('max_tokens' in (seen.body ?? {}), false)
  assert.equal(seen.body?.stream, false)
})

test('warmUpLitertLm: a 500 returns the runtime message carried in the status text', async (t) => {
  const port = await fakeServe(t, 500, 'Failed to load engine: RuntimeError(bad bundle)', {})
  const res = await warmUpLitertLm(port, '/m.litertlm', AbortSignal.timeout(5000))
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /Failed to load engine: RuntimeError\(bad bundle\)/)
})

test('warmUpLitertLm: nothing listening is reported as a failure, not thrown', async () => {
  const res = await warmUpLitertLm(1, '/m.litertlm', AbortSignal.timeout(2000))
  assert.equal(res.ok, false)
})

test('androidWheelAbi maps Node arch names to the wheel platform tag', () => {
  assert.equal(androidWheelAbi('arm64'), 'arm64_v8a')
  assert.equal(androidWheelAbi('x64'), 'x86_64')
  assert.equal(androidWheelAbi('arm'), null)
  assert.equal(androidWheelAbi('ia32'), null)
})

test('pickAndroidWheel selects the matching Android ABI and ignores desktop wheels', () => {
  const f = (filename: string) => ({ filename, url: `https://files/${filename}` })
  const files = [
    f('litert_lm_api-0.17.1-py3-none-android_23_arm64_v8a.whl'),
    f('litert_lm_api-0.17.1-py3-none-android_23_x86_64.whl'),
    f('litert_lm_api-0.17.1-py3-none-manylinux_2_27_aarch64.whl'),
    f('litert_lm_api-0.17.1-py3-none-win_amd64.whl'),
  ]
  assert.equal(pickAndroidWheel(files, 'arm64_v8a')?.filename, 'litert_lm_api-0.17.1-py3-none-android_23_arm64_v8a.whl')
  assert.equal(pickAndroidWheel(files, 'x86_64')?.filename, 'litert_lm_api-0.17.1-py3-none-android_23_x86_64.whl')
  assert.equal(pickAndroidWheel(files.slice(2), 'arm64_v8a'), null)
})

test('pickAndroidWheel prefers the highest API level when several are published', () => {
  const f = (filename: string) => ({ filename, url: 'u' })
  const picked = pickAndroidWheel(
    [f('x-1-py3-none-android_21_arm64_v8a.whl'), f('x-1-py3-none-android_24_arm64_v8a.whl'), f('x-1-py3-none-android_9_arm64_v8a.whl')],
    'arm64_v8a',
  )
  assert.equal(picked?.filename, 'x-1-py3-none-android_24_arm64_v8a.whl')
})

// ── the native-load preflight, against a stand-in `litert_lm` package on PYTHONPATH ──────────
const HAS_PYTHON = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()

async function blockerWithFfi(t: TestContext, ffiSource: string): Promise<string | null> {
  const dir = tmpDir('turbollm-litert-probe-')
  const before = process.env.PYTHONPATH
  t.after(() => {
    if (before === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = before
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, 'litert_lm'))
  writeFileSync(join(dir, 'litert_lm', '__init__.py'), '')
  writeFileSync(join(dir, 'litert_lm', '_ffi.py'), ffiSource)
  process.env.PYTHONPATH = dir
  return litertLmServeBlocker('python3')
}

test('litertLmServeBlocker: passes when the native library loads', { skip: !HAS_PYTHON }, async (t) => {
  assert.equal(await blockerWithFfi(t, 'def _get_lib():\n    return object()\n'), null)
})

test('litertLmServeBlocker: reports a native library that will not load, which a bare import would miss', { skip: !HAS_PYTHON }, async (t) => {
  const msg = await blockerWithFfi(t, 'def _get_lib():\n    raise OSError("liblitert-lm.so: wrong ELF class")\n')
  assert.match(msg ?? '', /native runtime could not load/)
  assert.match(msg ?? '', /wrong ELF class/)
})

test('litertLmServeBlocker: a future version without _get_lib degrades to the plain import, not a false failure', { skip: !HAS_PYTHON }, async (t) => {
  assert.equal(await blockerWithFfi(t, '# no _get_lib here\n'), null)
})

// ── the cached serve preflight (PR #271 review: the probe spawns a Python process and dlopens
// the native library on EVERY load/auto-resume — noticeable on a phone — so it is cached per
// interpreter + installed-package mtime and only re-run after the environment changes) ──

test('litertLmEnvFingerprint: stable for an unchanged venv, invalidated by a reinstall', (t: TestContext) => {
  const env = tmpDir('turbollm-litert-fp-')
  t.after(() => rmSync(env, { recursive: true, force: true }))
  const py = join(env, 'bin', 'python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, '')
  const pkg = join(env, 'lib', 'python3.12', 'site-packages', 'litert_lm')
  mkdirSync(pkg, { recursive: true })

  const before = litertLmEnvFingerprint(py)
  assert.ok(before, 'a real path yields a fingerprint')
  assert.equal(litertLmEnvFingerprint(py), before, 'unchanged environment → the same fingerprint')

  // A reinstall rewrites the package dir (pip replaces it wholesale) → new fingerprint.
  const later = new Date(Date.now() + 2000)
  utimesSync(pkg, later, later)
  assert.notEqual(litertLmEnvFingerprint(py), before, 'a touched package dir must invalidate the cache key')

  assert.equal(litertLmEnvFingerprint(join(env, 'bin', 'no-such-python')), null, 'a missing interpreter cannot be fingerprinted')
})

test('litertLmServeBlockerCached: one probe per environment, re-probed after the environment changes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cache-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A failing stand-in interpreter that records each run — the probe classifies the failure
  // (non-null blocker), which is exactly the slow path worth caching.
  const runs = join(dir, 'runs')
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, `#!/bin/sh\necho run >> "${runs}"\nexit 1\n`)
  chmodSync(py, 0o755)

  const first = await litertLmServeBlockerCached(py)
  const second = await litertLmServeBlockerCached(py)
  assert.ok(first, 'the failing interpreter must yield a blocker message')
  assert.equal(second, first, 'a cached answer is the same answer')
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run', 'the probe must run exactly once for an unchanged environment')

  // Touching the interpreter changes the fingerprint → the probe re-runs.
  const later = new Date(Date.now() + 2000)
  utimesSync(py, later, later)
  await litertLmServeBlockerCached(py)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'a changed environment must re-probe')
})

test('litertLmPrefillStats: prompt tokens over time-to-first-token, rounded to one decimal', () => {
  assert.deepEqual(litertLmPrefillStats(300, 1500), { promptMs: 1500, promptTps: 200 })
  assert.deepEqual(litertLmPrefillStats(100, 3000), { promptMs: 3000, promptTps: 33.3 })
})

test('litertLmPrefillStats: no usage or no TTFT yields nothing rather than a made-up number', () => {
  assert.equal(litertLmPrefillStats(undefined, 1000), null)
  assert.equal(litertLmPrefillStats(0, 1000), null)
  assert.equal(litertLmPrefillStats(100, 0), null)
  assert.equal(litertLmPrefillStats(100, Number.NaN), null)
})

test('litertLmProfileToConfig: an explicit backend overrides GPU detection and layers', () => {
  const p = (backend: 'auto' | 'cpu' | 'gpu', ngl: number) => ({ ctx: 4096, ngl, threads: 0, litertLm: { backend } })
  assert.equal(litertLmProfileToConfig(p('gpu', 0), false).default.backend, 'gpu', 'forced GPU with none detected (Android)')
  assert.equal(litertLmProfileToConfig(p('cpu', 99), true).default.backend, 'cpu', 'forced CPU on a GPU machine')
  assert.equal(litertLmProfileToConfig(p('auto', 99), true).default.backend, 'gpu')
  assert.equal(litertLmProfileToConfig(p('auto', 99), false).default.backend, 'cpu')
})
