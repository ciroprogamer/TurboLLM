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
// Platform reality: the native wheel (litert-lm-api) ships for Windows x64, Linux x64/arm64 and macOS arm64 only — there is
// no macOS-Intel or Windows-ARM build, and the catalog gates on exactly that.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
 * version. When `upgrade` is true, passes `-U`.
 */
export async function ensureLitertLmEnv(root: string, onProgress?: (p: ProvisionProgress) => void, upgrade = false): Promise<LitertLmRuntime> {
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'litert-lm', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(uv, ['venv', '--python', LITERT_LM_PYTHON, envDir], { cwd: root })
  }
  onProgress?.({ phase: 'extracting', pct: -1 })
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['-U'] : []), 'litert-lm']
  await execFileP(uv, installArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024 })

  const version = await probeLitertLm(py)
  return { python: py, version }
}

/** Read the installed litert-lm version (also a smoke test that the package imports). */
export async function probeLitertLm(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("litert-lm"))'],
    { timeout: 30_000 },
  )
  return `litert-lm ${stdout.trim()}`
}

/**
 * Turn a failed `import litert_lm` probe into an actionable message. The package installs anywhere pip does (the CLI is
 * pure Python), but its native library only loads where a wheel exists, so an unsupported OS/arch — or a Linux whose C
 * library predates the manylinux_2_27 wheel — fails at import with a loader error that means nothing to a user.
 */
export function classifyLitertLmBlocker(platform: NodeJS.Platform, arch: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) ?? 'the native runtime did not load'
  const supported =
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'darwin' && arch === 'arm64')
  if (!supported) {
    return 'LiteRT-LM publishes its runtime only for Windows x64, Linux x64/arm64 and macOS on Apple Silicon — ' +
      'there is no build for this operating system / architecture.'
  }
  return `LiteRT-LM's native runtime could not load on this machine (${detail}). ` +
    'On Linux it needs glibc 2.27 or newer; reinstalling the engine from Engines may also fix a half-installed environment.'
}

/** Preflight: can the LiteRT-LM runtime actually load here? Returns a clear message when blocked, or null when OK. */
export async function litertLmServeBlocker(python: string): Promise<string | null> {
  try {
    await execFileP(python, ['-c', 'import litert_lm'], { timeout: 60_000 })
    return null
  } catch (e) {
    return classifyLitertLmBlocker(process.platform, process.arch, (e as { stderr?: string })?.stderr || e)
  }
}

/** Why this model path cannot be sent to `litert-lm serve`, or null. The server splits the request's `model` on commas
 *  (`<id>,<backend>,<max-tokens>`), so a comma in a directory or file name would be misread as an override. */
export function litertLmPathBlocker(modelPath: string): string | null {
  return modelPath.includes(',')
    ? 'LiteRT-LM cannot load a model whose path contains a comma — rename the file or its folder and rescan.'
    : null
}

/** What a LiteRT-LM request must put in its `model` field: the model file's own path (see the header comment). */
export function litertLmModelRef(modelPath: string): string {
  return modelPath
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
 * Map a load profile to LiteRT-LM's config. Like KoboldCpp, the GPU-layers value is the CPU/GPU switch: LiteRT-LM has no
 * partial offload, so `ngl > 0` on a machine with a GPU means the GPU backend (WebGPU — Vulkan, Metal or D3D12, any
 * vendor) and everything else means CPU.
 *   ctx     → max_num_tokens   (the KV-cache length; a bundle exported with a shorter one still caps it)
 *   threads → cpu_thread_count (only when set; 0 = let the runtime choose)
 */
export function litertLmProfileToConfig(
  p: { ctx: number; ngl: number; threads: number },
  hasGpu: boolean,
): LitertLmConfig {
  const config: LitertLmConfig = { default: { backend: hasGpu && p.ngl > 0 ? 'gpu' : 'cpu' } }
  if (Number.isInteger(p.ctx) && p.ctx > 0) config.default.max_num_tokens = p.ctx
  if (Number.isInteger(p.threads) && p.threads > 0) config.default.cpu_thread_count = p.threads
  return config
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
  const hint = backend === 'gpu'
    ? 'If this model does not run on your GPU, set GPU layers to 0 to use the CPU backend.'
    : 'Check that the file is a complete .litertlm bundle supported by this LiteRT-LM version.'
  return `LiteRT-LM could not load this model — ${reason}. ${hint}`
}
