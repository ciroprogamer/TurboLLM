// The LiteRT-LM side of the HF repo dialog: a `.litertlm` repo renders as a VARIANT
// picker (one self-contained bundle per file — gpu/web/device builds, not quants),
// explains what a bundle is, and enqueues a single repo-file download with NO subdir —
// the daemon's expansion path (not the safetensors component path) owns placing it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HfRepoContent } from './HfRepoDialog'
import type { HfRepoDetail, HfRepoFile } from '../../lib/types'

const enqueue = vi.fn()
const requestLoad = vi.fn()
const toastSuccess = vi.fn()

function bundle(name: string, quant: string, sizeBytes: number, sha256: string): HfRepoFile {
  return { name, quant, sizeBytes, parts: 1, mmproj: false, litertlm: true, sha256, url: `u/${name}` }
}

// The real litert-community/gemma-4-E2B-it-litert-lm shape (verified live): one repo,
// several device/precision variants of the same model.
const FILES = [
  bundle('gemma-4-E2B-it-gpu.litertlm', 'GPU', 2.0e9, 'sha-gpu'),
  bundle('gemma-4-E2B-it.litertlm', 'Default', 2.6e9, 'sha-base'),
  bundle('gemma-4-E2B-it_Google_Tensor_G5.litertlm', 'Google Tensor G5', 3.1e9, 'sha-g5'),
]

function repoDetail(over: Partial<HfRepoDetail> = {}): HfRepoDetail {
  return {
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    gated: false,
    license: 'apache-2.0',
    downloads: 10,
    likes: 2,
    card: '',
    files: FILES,
    litertlm: true,
    ...over,
  } as HfRepoDetail
}

const state: { detail: HfRepoDetail } = { detail: repoDetail() }

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({ data: state.detail }),
  useSysInfo: () => ({ data: { gpus: [{ vramMb: 16000 }] } }),
  useStatus: () => ({ data: { engine: { kind: 'litert-lm' } } }),
  // mutate records the input AND runs the caller's onSuccess, so a download's toast
  // fires the way it does against the real mutation (the single-file path toasts there).
  useDownloadMutations: () => ({
    enqueue: {
      mutate: (input: unknown, opts?: { onSuccess?: () => void }) => {
        enqueue(input)
        opts?.onSuccess?.()
      },
      isPending: false,
      error: null,
    },
  }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
  useSettings: () => ({ query: { data: { hfTokenSet: true } } }),
}))
vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: [] }),
  useRemoteDownloadActions: () => ({ start: { mutate: vi.fn(), isPending: false } }),
}))
vi.mock('../../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad, isPending: false, pendingKey: undefined }),
}))
// Wrapped rather than passed directly: a `vi.mock` factory is hoisted above the `const`.
vi.mock('../../components/ui/sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: () => {} },
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderContent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HfRepoContent repo="litert-community/gemma-4-E2B-it-litert-lm" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** What actually got queued, as the download route sees it. */
const queued = () => enqueue.mock.calls.map((c) => c[0])

beforeEach(() => {
  enqueue.mockClear()
  requestLoad.mockClear()
  toastSuccess.mockClear()
})

describe('HfRepoContent — a .litertlm repo', () => {
  it('labels the picker "Variant", explains the bundle format, and pre-selects the largest that fits', () => {
    renderContent()

    expect(screen.getByText('Variant')).toBeInTheDocument()
    expect(screen.getByText(/LiteRT-LM model — each file is one self-contained bundle/i)).toBeInTheDocument()
    // The explainer must not claim every variant runs 'on CPU or GPU' — device builds
    // (Tensor G5, MediaTek) only run on their hardware. It points at matching instead.
    expect(screen.getByText(/Pick the variant matching your hardware/i)).toBeInTheDocument()
    // 16 GB VRAM, ~15% headroom + 1 GB baseline: the 2.6 GB Default fits, the 3.1 GB G5 too,
    // but the pre-select effect picks the LARGEST that fits (2.6 GB < 3.1 GB ≤ budget).
    expect(screen.getByRole('button', { name: /Google Tensor G5/ })).toBeInTheDocument()
  })

  it('lists every bundle as its variant label with size and fit dot', async () => {
    const user = userEvent.setup()
    renderContent()

    await user.click(screen.getByRole('button', { name: /Google Tensor G5/ }))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['GPU · 2.0 GB', 'Default · 2.6 GB', 'Google Tensor G5 · 3.1 GB']),
    )

    await user.click(screen.getByRole('menuitem', { name: /Default/ }))
    expect(screen.getByText(/2\.6 GB file · 16 GB VRAM/)).toBeInTheDocument()
  })

  it('enqueues the chosen bundle as a plain repo-file download — no subdir, size and sha carried', async () => {
    const user = userEvent.setup()
    renderContent()

    await user.click(screen.getByRole('button', { name: /Google Tensor G5/ }))
    await user.click(screen.getByRole('menuitem', { name: /^GPU/ }))
    await user.click(screen.getByRole('button', { name: /Download/ }))

    expect(queued()).toEqual([
      {
        repo: 'litert-community/gemma-4-E2B-it-litert-lm',
        rfilename: 'gemma-4-E2B-it-gpu.litertlm',
        size: 2.0e9,
        sha256: 'sha-gpu',
      },
    ])
    expect(toastSuccess).toHaveBeenCalledWith('Downloading gemma-4-E2B-it-gpu.litertlm')
  })

  it('offers Load instead of Download for a bundle already in the library', async () => {
    const user = userEvent.setup()
    state.detail = repoDetail({
      files: FILES.map((f) =>
        f.name === 'gemma-4-E2B-it.litertlm'
          ? { ...f, downloaded: true, localKey: 'gemma 4 e2b it|default|2600000000' }
          : f,
      ),
    })
    renderContent()

    await user.click(screen.getByRole('button', { name: /Google Tensor G5/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Default/ }))
    await user.click(screen.getByRole('button', { name: /^Load/ }))

    expect(requestLoad).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'gemma 4 e2b it|default|2600000000', name: 'gemma-4-E2B-it.litertlm' }),
      expect.anything(),
    )
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('HfRepoContent — a .litertlm repo with same-named bundles in different subfolders', () => {
  it('lists both full-path entries as distinct rows and enqueues the exact one picked', async () => {
    // The daemon disambiguates basename collisions by listing the full repo path as the
    // name (hf.ts litertlmFiles) — this pins the UI half: two rows stay selectable
    // (unique React keys, unique labels) and the picked one enqueues its exact path.
    state.detail = repoDetail({
      files: [
        bundle('gpu/model.litertlm', 'GPU Model', 1.0e9, 'sha-gpu'),
        bundle('web/model.litertlm', 'WEB Model', 0.8e9, 'sha-web'),
      ],
    })
    const user = userEvent.setup()
    renderContent()

    // Pre-select picks the largest that fits (1.0 GB gpu) — open the picker and choose web.
    await user.click(screen.getByRole('button', { name: /GPU Model/ }))
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['WEB Model · 800 MB', 'GPU Model · 1.0 GB']),
    )

    await user.click(screen.getByRole('menuitem', { name: /WEB Model/ }))
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(queued()).toEqual([
      {
        repo: 'litert-community/gemma-4-E2B-it-litert-lm',
        rfilename: 'web/model.litertlm',
        size: 0.8e9,
        sha256: 'sha-web',
      },
    ])
  })
})

describe('HfRepoContent — an empty repo', () => {
  it('says no downloadable model files, not "no GGUF files"', () => {
    state.detail = repoDetail({ litertlm: undefined, files: [] })
    renderContent()

    expect(screen.getByText('No downloadable model files found in this repo.')).toBeInTheDocument()
    expect(screen.queryByText(/No GGUF files/i)).not.toBeInTheDocument()
  })
})
