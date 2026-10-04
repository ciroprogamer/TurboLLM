// LiteRT-LM engine provisioning + launch. LiteRT-LM (google-ai-edge/LiteRT-LM) is Google's on-device LLM runtime:
// it runs `.litertlm` bundles (Gemma 3n/4, Qwen3, Phi-4-mini, ...) on CPU or on the GPU through WebGPU, with an
// OpenAI-compatible server (`litert-lm serve`). A fifth Python engine kind beside MLX, vLLM and SGLang: we reuse the uv
// bootstrap (ensureUv, shared with mlx.ts/vllm.ts), create an isolated venv, `uv pip install litert-lm`, and run its
// CLI as a module. No system Python is touched.
//
// How the CLI differs from every other engine here (verified against litert-lm 0.17.1, live):
//   - `serve` takes NO model argument. It resolves the request's `model` field per call: an existing file path is used
//     as-is (Model.from_model_reference), anything else is looked up in its own import registry. We always send the
//     file path, so nothing is imported, copied or linked — the same shape as MLX-VLM's path-valued model field.
//   - The engine loads lazily on the FIRST chat request, so /v1/models answers 200 with the model not loaded. Readiness
//     therefore needs a one-token warm-up request (warmUpLitertLm), which is also where a bad model file surfaces.
//   - There is no /health route (404) and no launch-time sampling flags. Backend (cpu/gpu), context and threads come
//     from a JSON file passed with `--config`; its `default` section applies to whichever model the request names.
//   - The `model` field is `<id>[,<backend>[,<max-tokens>]]`, so a path containing a comma cannot be sent
//     (litertLmPathBlocker refuses it up front rather than letting it be misparsed).
//
// Platform reality: the native wheel (litert-lm-api) ships for Windows x64, Linux x64/arm64, macOS arm64 and Android
// (arm64-v8a, x86_64) — there is no macOS-Intel or Windows-ARM build, and the catalog gates on exactly that.
//
// Android is the odd one out. The Android wheel is `py3-none-android_23_<abi>`: a thin ctypes wrapper around one
// liblitert-lm.so (bionic, linked only against system libs), so it works in any bionic Python such as Termux's — but
// (a) `uv` publishes no Android build, so the venv comes from the device's own `python -m venv`, and (b) pip refuses a
// wheel whose platform tag it does not recognise, which Termux's Python may not, so the native wheel is fetched from
// PyPI and unpacked into the venv directly (ensureLitertLmAndroidEnv). The Android APK has no Python at all, so there
// this engine is only reachable when TurboLLM itself runs inside Termux.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

const LITERT_LM_PYTHON = '3.12'

export interface LitertLmRuntime {
  python: string
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated LiteRT-LM runtime: uv → venv (pinned python) → `uv pip install litert-lm`. The wheel bundles
 * the native runtime, so unlike vLLM/SGLang this is small (tens of MB, no torch/CUDA). Returns the venv python +
 * version. When `upgrade` is true, passes `-U`. `signal` aborts a provision in flight (the web UI's Cancel): every
 * child process here takes it in its exec options, so an abort kills uv/pip and rejects with AbortError — the route
 * maps that to a clean "user cancelled" state instead of a failure banner.
 */
export async function ensureLitertLmEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
  signal?: AbortSignal,
): Promise<LitertLmRuntime> {
  if (process.platform === 'android') return ensureLitertLmAndroidEnv(root, onProgress, upgrade, signal)
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'litert-lm', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(uv, ['venv', '--python', LITERT_LM_PYTHON, envDir], { cwd: root, signal })
  }
  onProgress?.({ phase: 'extracting', pct: -1 })
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['-U'] : []), 'litert-lm']
  await execFileP(uv, installArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024, signal })

  const version = await probeLitertLm(py, signal)
  return { python: py, version }
}

// ── Android (Termux) provisioning ────────────────────────────────────────────

const PYPI = 'https://pypi.org/pypi'

/** The ABI part of the native wheel's platform tag for this CPU, or null when Android has no build for it. */
export function androidWheelAbi(arch: string): 'arm64_v8a' | 'x86_64' | null {
  if (arch === 'arm64') return 'arm64_v8a'
  if (arch === 'x64') return 'x86_64'
  return null
}

export interface PypiFile { filename: string; url: string; digests?: { sha256?: string } }

/** Pick the Android native wheel for `abi` out of a PyPI release's file list (highest API level wins when several). */
export function pickAndroidWheel(files: PypiFile[], abi: string): PypiFile | null {
  const re = new RegExp(`-py3-none-android_(\\d+)_${abi}\\.whl$`)
  const found = files
    .map((f) => ({ f, api: Number(re.exec(f.filename)?.[1]) }))
    .filter((x) => Number.isFinite(x.api))
    .sort((a, b) => b.api - a.api)
  return found[0]?.f ?? null
}

/** Termux hint shared by every "no usable Python" failure. */
const ANDROID_PYTHON_HINT =
  'LiteRT-LM on Android needs Python 3.10 or newer from Termux (run `pkg install python`) with TurboLLM started ' +
  'from Termux. The standalone Android app has no Python and cannot run this engine.'

/** A python>=3.10 with the venv module on this device, or throws with the Termux instructions. */
async function findAndroidPython(): Promise<string> {
  for (const cand of ['python3', 'python']) {
    try {
      const { stdout } = await execFileP(
        cand,
        ['-c', 'import sys, venv; print("%d.%d" % sys.version_info[:2])'],
        { timeout: 30_000 },
      )
      const [maj, min] = stdout.trim().split('.').map(Number)
      if (maj > 3 || (maj === 3 && min >= 10)) return cand
    } catch { /* try the next name */ }
  }
  throw new Error(ANDROID_PYTHON_HINT)
}

async function pypiJson(url: string): Promise<{ info: { version: string }; urls: PypiFile[] }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`PyPI answered ${r.status} for ${url}`)
  return (await r.json()) as { info: { version: string }; urls: PypiFile[] }
}

async function installAndroidNativeWheel(py: string, root: string, version: string, signal?: AbortSignal): Promise<void> {
  const abi = androidWheelAbi(process.arch)
  if (!abi) throw new Error(`LiteRT-LM has no Android build for the ${process.arch} architecture.`)
  const release = await pypiJson(`${PYPI}/litert-lm-api/${version}/json`)
  const wheel = pickAndroidWheel(release.urls, abi)
  if (!wheel) throw new Error(`litert-lm-api ${version} publishes no Android ${abi} wheel.`)

  const r = await fetch(wheel.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) })
  if (!r.ok) throw new Error(`Could not download ${wheel.filename} (HTTP ${r.status}).`)
  const bytes = Buffer.from(await r.arrayBuffer())
  const want = wheel.digests?.sha256
  if (want && createHash('sha256').update(bytes).digest('hex') !== want) {
    throw new Error(`${wheel.filename} failed its SHA-256 check — the download is corrupt, try again.`)
  }

  const { stdout } = await execFileP(py, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { timeout: 30_000, signal })
  const site = stdout.trim()
  // A wheel is a zip. Drop any earlier litert_lm_api metadata first so an upgrade leaves one dist-info behind.
  for (const e of readdirSync(site)) if (/^litert_lm_api-.*\.dist-info$/.test(e)) rmSync(join(site, e), { recursive: true, force: true })
  const tmp = join(root, 'litert-lm', wheel.filename)
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, bytes)
  try {
    await execFileP(py, ['-m', 'zipfile', '-e', tmp, site], { timeout: 120_000, signal })
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Android/Termux twin of ensureLitertLmEnv (see the header comment for why it differs): device Python → venv → pip
 * installs the pure-Python packages → the native wheel is unpacked from PyPI by hand. `signal` cancels it (the web
 * UI's Cancel) — same contract as the desktop path.
 */
export async function ensureLitertLmAndroidEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
  signal?: AbortSignal,
): Promise<LitertLmRuntime> {
  const systemPython = await findAndroidPython()
  const envDir = join(root, 'litert-lm', 'venv')
  const py = venvPython(envDir)
  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(systemPython, ['-m', 'venv', envDir], { cwd: root, signal })
  }
  onProgress?.({ phase: 'extracting', pct: -1 })
  const pip = (...args: string[]) =>
    execFileP(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...(upgrade ? ['-U'] : []), ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 900_000, signal })
  // --no-deps: litert-lm pins litert-lm-api==<same version>, and pip would reject its Android-tagged wheel.
  await pip('--no-deps', 'litert-lm')
  const version = (await probeLitertLm(py, signal)).replace(/^litert-lm /, '')
  await pip(`litert-lm-builder==${version}`, 'click', 'prompt_toolkit', 'typing-extensions', 'questionary')
  onProgress?.({ phase: 'downloading', pct: -1 })
  await installAndroidNativeWheel(py, root, version, signal)

  const blocker = await litertLmServeBlocker(py, signal)
  if (blocker) throw new Error(blocker)
  return { python: py, version: `litert-lm ${version}` }
}

/** Read the installed litert-lm version (also a smoke test that the package imports). */
export async function probeLitertLm(python: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("litert-lm"))'],
    { timeout: 30_000, signal },
  )
  return `litert-lm ${stdout.trim()}`
}

/**
 * Turn a failed native-load probe into an actionable message. The package installs anywhere pip does (the CLI is pure
 * Python), but its native library only loads where a wheel exists, so an unsupported OS/arch — or a Linux whose C
 * library predates the manylinux_2_27 wheel — fails with a loader error that means nothing to a user.
 */
export function classifyLitertLmBlocker(platform: NodeJS.Platform, arch: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) ?? 'the native runtime did not load'
  const supported =
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'android' && androidWheelAbi(arch) !== null)
  if (!supported) {
    return 'LiteRT-LM publishes its runtime only for Windows x64, Linux x64/arm64, macOS on Apple Silicon and Android ' +
      '(arm64 / x86_64) — there is no build for this operating system / architecture.'
  }
  const need = platform === 'android'
    ? 'On Android it needs Android 6.0 (API 23) or newer and the Python from Termux; reinstalling the engine from Engines may also fix a half-installed environment.'
    : 'On Linux it needs glibc 2.27 or newer; reinstalling the engine from Engines may also fix a half-installed environment.'
  return `LiteRT-LM's native runtime could not load on this machine (${detail}). ${need}`
}

/**
 * Python that proves the native runtime loads, not just the package. `import litert_lm` alone proves nothing: the
 * wrapper dlopens liblitert-lm.so lazily on first use (`_ffi._get_lib`, verified on litert-lm-api 0.17.1), so a wrong-arch
 * or unloadable library would otherwise only surface mid-request. `_get_lib` is private, so if a future version renames
 * it the probe degrades to the plain import instead of reporting a false failure.
 */
const NATIVE_LOAD_PROBE = [
  'import importlib, litert_lm',
  "ffi = importlib.import_module('litert_lm._ffi')",
  "load = getattr(ffi, '_get_lib', None)",
  'load() if callable(load) else None',
].join('\n')

/** The serve probe's wall-clock budget: 60 s in production — a venv's first import can be slow on a
 *  phone — and injectably shorter in tests so the timeout path can be exercised without a
 *  minute-long test. */
export const LITERT_LM_PROBE_TIMEOUT_MS = 60_000

/** Why a failed probe answered nothing about the environment: execFile's `timeout` SIGTERMs the
 *  child (`killed` set), any other kill leaves `signal` set, and a killed spawn can surface as
 *  ETIMEDOUT. Unlike a loader error, a kill is not a property of the venv — a busy phone can make
 *  the very probe that times out now pass a minute later — so it must not be treated as a settled
 *  verdict (PR #271 review). A plain non-zero exit is conclusive: that is the loader error the
 *  probe exists to catch. */
export function isLitertLmProbeInconclusive(e: unknown): boolean {
  const err = e as { killed?: boolean; signal?: unknown; code?: unknown }
  return Boolean(err?.killed || err?.signal || err?.code === 'ETIMEDOUT')
}

/** The probe's verdict: `blocker` is the user-facing message (null = the runtime loads), and
 *  `conclusive` says whether the environment was actually measured. An inconclusive probe
 *  (killed / timed out) still yields a best-effort blocker for THIS load, but the cache must not
 *  keep it. */
interface ServeProbeResult {
  blocker: string | null
  conclusive: boolean
}

async function runServeProbe(python: string, timeoutMs: number, signal?: AbortSignal): Promise<ServeProbeResult> {
  try {
    await execFileP(python, ['-c', NATIVE_LOAD_PROBE], { timeout: timeoutMs, signal })
    return { blocker: null, conclusive: true }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    if (isLitertLmProbeInconclusive(e)) {
      return {
        blocker:
          `LiteRT-LM's native-runtime check did not finish — the machine was too busy to answer within ` +
          `${Math.max(1, Math.round(timeoutMs / 1000))} s. Nothing is known about the runtime; try loading again.`,
        conclusive: false,
      }
    }
    return { blocker: classifyLitertLmBlocker(process.platform, process.arch, (e as { stderr?: string })?.stderr || e), conclusive: true }
  }
}

/** Preflight: can the LiteRT-LM runtime actually load here? Returns a clear message when blocked, or null when OK. */
export async function litertLmServeBlocker(
  python: string,
  signal?: AbortSignal,
  timeoutMs: number = LITERT_LM_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  return (await runServeProbe(python, timeoutMs, signal)).blocker
}

/** Why this model path cannot be sent to `litert-lm serve`, or null. The server splits the request's `model` on commas
 *  (`<id>,<backend>,<max-tokens>`), so a comma in a directory or file name would be misread as an override. */
export function litertLmPathBlocker(modelPath: string): string | null {
  return modelPath.includes(',')
    ? 'LiteRT-LM cannot load a model whose path contains a comma — rename the file or its folder and rescan.'
    : null
}

// ── serve preflight, cached per venv ─────────────────────────────────────────────

/** A cheap fingerprint of a LiteRT-LM interpreter's environment: its own mtime plus the
 *  installed `litert_lm` package dir's mtime ('absent' when there is no recognizable venv
 *  layout — the interpreter's own mtime still keys the cache). The serve preflight
 *  (litertLmServeBlocker) spawns a fresh Python process that dlopens the native library —
 *  up to 60 s, noticeable on a phone — and the Manager runs it on EVERY load and
 *  auto-resume. The result is stable for an unchanged environment, so the cache is keyed on
 *  this fingerprint: a reinstall touches the package dir (pip rewrites it wholesale), a
 *  rebuilt venv touches the interpreter, and either invalidates the cached answer.
 *  null → the interpreter itself cannot be stat'd (missing, or a bare command name the
 *  filesystem can't resolve); the caller just runs the probe uncached. */
export function litertLmEnvFingerprint(python: string): string | null {
  try {
    const pyStat = statSync(python)
    const envDir = dirname(dirname(python)) // <env>/bin/python (POSIX) / <env>/Scripts/python.exe (Windows)
    const siteDir = process.platform === 'win32'
      ? join(envDir, 'Lib', 'site-packages')
      : (() => {
          const lib = join(envDir, 'lib')
          if (!existsSync(lib)) return null
          const ver = readdirSync(lib, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith('python'))
          return ver ? join(lib, ver.name, 'site-packages') : null
        })()
    const pkg = siteDir ? join(siteDir, 'litert_lm') : null
    const pkgStat = pkg && existsSync(pkg) ? statSync(pkg) : null
    return `${python}|${pyStat.mtimeMs}|${pkgStat ? pkgStat.mtimeMs : 'absent'}`
  } catch {
    return null
  }
}

/** The in-flight/cached result of the serve preflight per fingerprint. The PROMISE is cached
 *  (concurrent loads share one probe), and an abort is neither cached nor returned — it
 *  propagates so the caller can treat the load as cancelled, not as pass/fail. */
const serveBlockerCache = new Map<string, Promise<string | null>>()

/** Cached litertLmServeBlocker for the Manager's per-load preflight (see
 *  litertLmEnvFingerprint for why the probe is worth caching). Install-time callers
 *  (ensureLitertLmAndroidEnv) use the plain uncached litertLmServeBlocker on purpose: they
 *  have just written the environment and must see what they built. */
export function litertLmServeBlockerCached(
  python: string,
  signal?: AbortSignal,
  timeoutMs: number = LITERT_LM_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const key = litertLmEnvFingerprint(python)
  if (!key) return litertLmServeBlocker(python, signal, timeoutMs)
  const hit = serveBlockerCache.get(key)
  if (hit) return hit
  const answer = runServeProbe(python, timeoutMs, signal).then((r) => {
    // An inconclusive probe (killed / timed out) answered nothing about the environment — one
    // slow probe on a busy phone must not become "native runtime could not load" for every later
    // load (PR #271 review). THIS load keeps the best-effort blocker, but the entry is dropped so
    // the next load re-runs the probe. Only a measured verdict — null (OK) or a loader error —
    // stays cached.
    if (!r.conclusive && serveBlockerCache.get(key) === answer) serveBlockerCache.delete(key)
    return r.blocker
  })
  serveBlockerCache.set(key, answer)
  // A rejection (runServeProbe re-throws an abort; a spawn failure rejects) also answered
  // nothing — drop it so a later load re-runs the probe instead of a cached rejection.
  answer.catch(() => {
    if (serveBlockerCache.get(key) === answer) serveBlockerCache.delete(key)
  })
  return answer
}

/** The settings TurboLLM drives through LiteRT-LM's `--config` file. Every key is one the 0.17 schema accepts. */
export interface LitertLmConfig {
  default: {
    backend: 'cpu' | 'gpu'
    max_num_tokens?: number
    cpu_thread_count?: number
  }
}

/**
 * Map a load profile to LiteRT-LM's config. LiteRT-LM has no partial offload, so the profile's `litertLm.backend` picks
 * cpu or gpu outright; `auto` (the default) follows the KoboldCpp convention: `ngl > 0` on a machine with a GPU means
 * the GPU backend and everything else means CPU.
 *   ctx     → max_num_tokens   (the KV-cache length; a bundle exported with a shorter one still caps it)
 *   threads → cpu_thread_count (only when set; 0 = let the runtime choose)
 */
export function litertLmProfileToConfig(
  p: { ctx: number; ngl: number; threads: number; litertLm?: { backend?: 'auto' | 'cpu' | 'gpu' } },
  hasGpu: boolean,
): LitertLmConfig {
  // An explicit choice wins over detection: Android/Termux cannot report a GPU, so `auto` would pin it to CPU.
  const choice = p.litertLm?.backend ?? 'auto'
  const backend: 'cpu' | 'gpu' = choice === 'auto' ? (hasGpu && p.ngl > 0 ? 'gpu' : 'cpu') : choice
  const config: LitertLmConfig = { default: { backend } }
  if (Number.isInteger(p.ctx) && p.ctx > 0) config.default.max_num_tokens = p.ctx
  if (Number.isInteger(p.threads) && p.threads > 0) config.default.cpu_thread_count = p.threads
  return config
}

/**
 * Prefill speed for a LiteRT-LM turn. Its OpenAI server reports only token counts (`usage`), never llama.cpp-style
 * `timings`, even though the runtime measures prefill internally — so the speed is derived: prompt tokens over the time
 * to the first streamed token. That time also contains the first decode step, so this slightly UNDER-states true
 * prefill, which is the honest direction for an approximation. Null when either input is missing, so nothing is faked.
 */
export function litertLmPrefillStats(promptTokens: number | undefined, ttftMs: number): { promptMs: number; promptTps: number } | null {
  if (!promptTokens || promptTokens <= 0 || !(ttftMs > 0)) return null
  return { promptMs: ttftMs, promptTps: Math.round((promptTokens / ttftMs) * 1000 * 10) / 10 }
}

/** Where the config for the engine on `port` lives. Per port, not shared: two engines can run side by side and a
 *  shared file would let the second start rewrite the first's settings. */
export function litertLmConfigPath(dataDir: string, port: number): string {
  return join(dataDir, 'engines', 'litert-lm', `config-${port}.json`)
}

/** Write the config file `litert-lm serve --config` reads. */
export function writeLitertLmConfig(path: string, config: LitertLmConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

/**
 * Command + args to launch the LiteRT-LM OpenAI-compatible server. We invoke the CLI as a module (`python -m
 * litert_lm_cli.main`) rather than the venv's console script, the same way SGLang is launched: one path on every OS,
 * no `.exe` shim to locate. `serve` defaults to 0.0.0.0:9379, so host and port are always passed explicitly.
 *
 * `extraArgs` are the user's own `serve` flags (--verbose, --cors-origin, ...) and go last.
 */
export function litertLmServerCommand(
  python: string,
  configPath: string,
  port: number,
  host: string,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  return {
    cmd: python,
    args: ['-m', 'litert_lm_cli.main', 'serve', '--config', configPath, '--host', host, '--port', String(port), ...extraArgs],
  }
}

export type LitertLmWarmUp = { ok: true } | { ok: false; message: string }

/**
 * Load the model by asking it for one token. `serve` binds its socket before any model is loaded and loads on the first
 * chat request, so this is the only moment a bad bundle, an unsupported architecture or a GPU that cannot be initialised
 * becomes visible — as an HTTP 500 whose status text carries the runtime's own message. Returns that message.
 */
export async function warmUpLitertLm(port: number, modelRef: string, signal: AbortSignal): Promise<LitertLmWarmUp> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelRef,
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
        stream: false,
      }),
      signal,
    })
    if (r.ok) return { ok: true }
    // The runtime's message rides in the status line ("500 Failed to load engine: RuntimeError(...)").
    const reason = r.statusText.trim() || `HTTP ${r.status}`
    return { ok: false, message: reason.slice(0, 300) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** The user-facing text for a failed warm-up: the runtime's message plus the two causes that account for most of them. */
export function litertLmLoadFailureMessage(reason: string, backend: 'cpu' | 'gpu'): string {
  // The GPU hint must name a control the LiteRT-LM panel actually offers: "set GPU layers to
  // 0" is llama.cpp advice — the GPU-layers slider is not rendered for LiteRT-LM, whose
  // backend is chosen outright on the model's load panel.
  const hint = backend === 'gpu'
    ? 'If this model does not run on your GPU, switch the Backend setting to CPU on the model\'s load panel and load it again.'
    : 'Check that the file is a complete .litertlm bundle supported by this LiteRT-LM version.'
  return `LiteRT-LM could not load this model — ${reason}. ${hint}`
}
