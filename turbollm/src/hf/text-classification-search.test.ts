// Discover's "Text classification" category (ADR-444) lists only what TurboLLM can run as a classifier: Laya
// bundles and Jev (NLI cross-encoder) checkpoints. HF's own text-classification tag is mostly sentiment and toxicity
// models nothing here can load, so every listed NLI repo is verified by detectJev first. No network: HF is faked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HfClient } from './hf'
import { mergeListings, textClassificationCandidate, type ListedModel } from './text-classification-search'

function listed(id: string, files: string[], architectures?: string[], library_name?: string): ListedModel {
  return {
    id,
    siblings: files.map((rfilename) => ({ rfilename })),
    config: architectures ? { architectures } : {},
    ...(library_name ? { library_name } : {}),
  }
}

const LAYA_FILES = ['README.md', 'rl_agent_config.json', 'model.safetensors', 'encoder/config.json', 'tokenizer/tokenizer.json']
const ROOT_CHECKPOINT = ['config.json', 'model.safetensors', 'tokenizer.json']
const OPENJEV_FILES = [
  'README.md',
  'code/train.py',
  'qwen3.5-0.8b-nli-v2s-long/config.json',
  'qwen3.5-0.8b-nli-v2s-long/model.safetensors',
  'qwen3.5-0.8b-nli-v2s-long/tokenizer.json',
  'qwen3.5-2b-nli-v5/config.json',
  'qwen3.5-2b-nli-v5/model.safetensors',
  'qwen3.5-2b-nli-v5/tokenizer.json',
]

test('a repo with the Laya decision-head config and weights at its root is a Laya candidate, from its file names alone', () => {
  const laya = listed('convaiinnovations/laya', LAYA_FILES, undefined, 'transformers')

  assert.deepEqual(textClassificationCandidate(laya), { model: laya, runtime: 'laya' })
})

test('a Laya repo published with its own library tag is a Laya candidate too', () => {
  const native = listed('telepatia-ai/laya-pt-es-typed', LAYA_FILES, undefined, 'laya')

  assert.deepEqual(textClassificationCandidate(native), { model: native, runtime: 'laya' })
})

// The same rule as the engine-adapted search (ADR-443 (8)): a Laya-shaped folder in another library, such as the MLX
// port, has the right file names and cannot be run by the PyTorch Laya engine.
test('a Laya-shaped MLX port is no candidate: the Laya engine cannot load it', () => {
  const mlxPort = listed('aac6fef/laya-mlx', [...LAYA_FILES, 'mlx_config.json'], undefined, 'mlx')

  assert.equal(textClassificationCandidate(mlxPort), undefined)
})

test('a Laya-shaped repo that names no library is no candidate', () => {
  assert.equal(textClassificationCandidate(listed('someone/laya-finetune', LAYA_FILES)), undefined)
})

test('a root sequence classifier is an NLI candidate whose own root config gets checked', () => {
  const nli = listed('tasksource/ModernBERT-base-nli', ROOT_CHECKPOINT, ['ModernBertForSequenceClassification'])

  assert.deepEqual(textClassificationCandidate(nli), { model: nli, runtime: 'vllm', configDir: '' })
})

test('a repo whose checkpoints live in subfolders is checked through its first checkpoint folder', () => {
  const openjev = listed('AlexWortega/openjev', OPENJEV_FILES)

  assert.deepEqual(textClassificationCandidate(openjev), { model: openjev, runtime: 'vllm', configDir: 'qwen3.5-0.8b-nli-v2s-long' })
})

test('a root declared as some other architecture is skipped in favour of a subfolder checkpoint', () => {
  const eightBit = ['8bit/config.json', '8bit/model.safetensors', '8bit/tokenizer.json']
  const variants = listed('someone/model-mlx', [...ROOT_CHECKPOINT, ...eightBit], ['Qwen3ForCausalLM'])

  assert.deepEqual(textClassificationCandidate(variants), { model: variants, runtime: 'vllm', configDir: '8bit' })
})

test('an ordinary language model with no subfolder checkpoint is no candidate', () => {
  assert.equal(textClassificationCandidate(listed('Qwen/Qwen3-4B', ROOT_CHECKPOINT, ['Qwen3ForCausalLM'])), undefined)
})

test('a sequence classifier with no safetensors weights is no candidate: Discover could not download it', () => {
  const binOnly = listed('MoritzLaurer/old-nli', ['config.json', 'pytorch_model.bin', 'tokenizer.json'], ['DebertaV2ForSequenceClassification'])

  assert.equal(textClassificationCandidate(binOnly), undefined)
})

test('a listing without file names is no candidate', () => {
  assert.equal(textClassificationCandidate({ id: 'a/b', config: { architectures: ['BertForSequenceClassification'] } }), undefined)
})

const ids = (models: ListedModel[]) => models.map((m) => m.id)

test('trending and best match take turns between the listings, so none starves the others', () => {
  const listings = [[{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], [{ id: 'b1' }], [{ id: 'c1' }, { id: 'c2' }]]

  assert.deepEqual(ids(mergeListings(listings, 'trending')), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3'])
  assert.deepEqual(ids(mergeListings(listings, 'best-match')), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3'])
})

test('a repo found by several listings appears once, where it first turned up', () => {
  const listings = [[{ id: 'a1' }, { id: 'shared' }], [{ id: 'shared' }, { id: 'b2' }]]

  assert.deepEqual(ids(mergeListings(listings, 'trending')), ['a1', 'shared', 'b2'])
  assert.deepEqual(ids(mergeListings(listings, 'downloads')), ['a1', 'shared', 'b2'])
})

test('sorting by downloads orders the merged listings by downloads, most first, ties in listing order', () => {
  const listings = [
    [{ id: 'few', downloads: 5 }, { id: 'tie-first', downloads: 50 }],
    [{ id: 'most', downloads: 900 }, { id: 'tie-second', downloads: 50 }],
  ]

  assert.deepEqual(ids(mergeListings(listings, 'downloads')), ['most', 'tie-first', 'tie-second', 'few'])
})

test('sorting by likes, last modified or creation date orders by that field, newest or most first', () => {
  const listings = [
    [{ id: 'old', likes: 1, lastModified: '2024-01-01T00:00:00.000Z', createdAt: '2023-01-01T00:00:00.000Z' }],
    [{ id: 'new', likes: 9, lastModified: '2026-09-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
  ]

  assert.deepEqual(ids(mergeListings(listings, 'likes')), ['new', 'old'])
  assert.deepEqual(ids(mergeListings(listings, 'modified')), ['new', 'old'])
  assert.deepEqual(ids(mergeListings(listings, 'created')), ['new', 'old'])
})

/** What the fake HF answers: each listing's rows (or an HTTP status to fail with), and each repo's config.json by
 *  `<repo>/<dir>/config.json`. A config it does not hold is a 404. */
interface FakeHf {
  textClassification?: ListedModel[] | number
  laya?: ListedModel[] | number
  nli?: ListedModel[] | number
  configs?: Record<string, unknown>
}

function withHf(hf: FakeHf, run: (urls: string[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    return u.includes('/resolve/main/') ? configAnswer(hf, u) : listingAnswer(hf, u)
  }) as typeof fetch
  return run(urls).finally(() => { globalThis.fetch = real })
}

function listingAnswer(hf: FakeHf, url: string): Response {
  const rows = url.includes('filter=laya') ? hf.laya : url.includes('filter=nli') ? hf.nli : hf.textClassification
  return typeof rows === 'number' ? new Response('nope', { status: rows }) : json(rows ?? [])
}

function configAnswer(hf: FakeHf, url: string): Response {
  const key = url.replace('https://huggingface.co/', '').replace('/resolve/main/', '/')
  return key in (hf.configs ?? {}) ? json(hf.configs?.[key]) : new Response('missing', { status: 404 })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const client = () => new HfClient(() => '', '0.0.0-test')
const configFetches = (urls: string[]) => urls.filter((u) => u.endsWith('config.json'))
const listingUrls = (urls: string[]) => urls.filter((u) => u.includes('/api/models?'))

const NLI_LABELS = { 0: 'entailment', 1: 'neutral', 2: 'contradiction' }
const nliConfig = (architecture = 'DebertaV2ForSequenceClassification') => ({ architectures: [architecture], id2label: NLI_LABELS })
const SENTIMENT_CONFIG = { architectures: ['RobertaForSequenceClassification'], id2label: { 0: 'negative', 1: 'neutral', 2: 'positive' } }

const LAYA = listed('convaiinnovations/laya', LAYA_FILES, undefined, 'transformers')
const OPENJEV = listed('AlexWortega/openjev', OPENJEV_FILES)
const rootClassifier = (id: string, extra: Partial<ListedModel> = {}) =>
  ({ ...listed(id, ROOT_CHECKPOINT, ['DebertaV2ForSequenceClassification']), ...extra })

test('a Laya bundle is listed from its file names, without fetching any config', async () => {
  await withHf({ laya: [LAYA] }, async (urls) => {
    const found = await client().searchTextClassification('laya')

    assert.deepEqual(found.map((r) => [r.repo, r.textClassification?.runtime]), [['convaiinnovations/laya', 'laya']])
    assert.deepEqual(configFetches(urls), [])
  })
})

test('an NLI model is listed as a vLLM classifier once detectJev accepts its own config', async () => {
  const nli = rootClassifier('tasksource/deberta-nli', {
    downloads: 7, likes: 3, lastModified: '2026-09-01T00:00:00.000Z', gated: false, tags: ['nli'],
  })
  await withHf({ textClassification: [nli], configs: { 'tasksource/deberta-nli/config.json': nliConfig() } }, async () => {
    const found = await client().searchTextClassification('deberta')

    assert.deepEqual(found, [{
      repo: 'tasksource/deberta-nli',
      downloads: 7,
      likes: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      gated: false,
      tags: ['nli'],
      textClassification: { runtime: 'vllm' },
    }])
  })
})

test('a sentiment model with three labels of its own is not listed', async () => {
  const sentiment = rootClassifier('cardiffnlp/sentiment')
  await withHf({ textClassification: [sentiment], configs: { 'cardiffnlp/sentiment/config.json': SENTIMENT_CONFIG } }, async () => {
    assert.deepEqual(await client().searchTextClassification(''), [])
  })
})

test('a repo keeping its checkpoints in subfolders is verified through its first checkpoint config', async () => {
  const configs = { 'AlexWortega/openjev/qwen3.5-0.8b-nli-v2s-long/config.json': nliConfig('Qwen3_5ForSequenceClassification') }
  await withHf({ nli: [OPENJEV], configs }, async (urls) => {
    const found = await client().searchTextClassification('openjev')

    assert.deepEqual(found.map((r) => r.repo), ['AlexWortega/openjev'])
    assert.deepEqual(configFetches(urls), [
      'https://huggingface.co/AlexWortega/openjev/resolve/main/qwen3.5-0.8b-nli-v2s-long/config.json',
    ])
  })
})

test('an NLI model HF tags zero-shot-classification is found through the nli tag listing', async () => {
  const zeroShot = rootClassifier('MoritzLaurer/mDeBERTa-v3-base-mnli-xnli', { tags: ['zero-shot-classification', 'nli'] })
  await withHf({ nli: [zeroShot], configs: { 'MoritzLaurer/mDeBERTa-v3-base-mnli-xnli/config.json': nliConfig() } }, async () => {
    const found = await client().searchTextClassification('mdeberta')

    assert.deepEqual(found.map((r) => r.repo), ['MoritzLaurer/mDeBERTa-v3-base-mnli-xnli'])
  })
})

test('the three listings share the query and sort, and ask for the file names and root config', async () => {
  await withHf({}, async (urls) => {
    await client().searchTextClassification('  deberta ', 'downloads')

    const listings = listingUrls(urls)
    assert.equal(listings.length, 3)
    for (const tag of ['pipeline_tag=text-classification', 'filter=laya', 'filter=nli']) {
      assert.equal(listings.filter((u) => u.includes(tag)).length, 1, `no ${tag} listing`)
    }
    for (const u of listings) {
      assert.match(u, /search=deberta&/)
      assert.match(u, /sort=downloads&direction=-1/)
      assert.match(u, /limit=30/)
      assert.ok(u.includes('expand[]=siblings') && u.includes('expand[]=config'), u)
    }
  })
})

test('an NLI candidate whose config cannot be read is dropped, never listed unverified', async () => {
  const unreadable = rootClassifier('someone/private-nli')
  const readable = rootClassifier('tasksource/deberta-nli')
  await withHf({ nli: [unreadable, readable], configs: { 'tasksource/deberta-nli/config.json': nliConfig() } }, async () => {
    const found = await client().searchTextClassification('nli')

    assert.deepEqual(found.map((r) => r.repo), ['tasksource/deberta-nli'])
  })
})

test('one search reads at most 8 configs, for the first candidates in order; later ones are dropped, Laya still listed', async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => rootClassifier(`nli/model-${i}`))
  const configs = Object.fromEntries(candidates.map((c) => [`${c.id}/config.json`, nliConfig()]))
  await withHf({ nli: [...candidates, LAYA], configs }, async (urls) => {
    const found = await client().searchTextClassification('')

    assert.equal(configFetches(urls).length, 8)
    assert.deepEqual(found.map((r) => r.repo), [...candidates.slice(0, 8).map((c) => c.id), 'convaiinnovations/laya'])
  })
})

test('a failed listing leaves the others to answer', async () => {
  await withHf({ textClassification: 500, nli: 429, laya: [LAYA] }, async () => {
    const found = await client().searchTextClassification('laya')

    assert.deepEqual(found.map((r) => r.repo), ['convaiinnovations/laya'])
  })
})

test('when every listing fails the search fails, as searchModels does', async () => {
  await withHf({ textClassification: 500, nli: 500, laya: 500 }, async () => {
    await assert.rejects(client().searchTextClassification('laya'), { name: 'HfError', code: 'hf_unreachable' })
  })
})

test('a repo found by several listings is listed once, and its config read once', async () => {
  const nli = rootClassifier('MoritzLaurer/DeBERTa-v3-base-mnli')
  const configs = { 'MoritzLaurer/DeBERTa-v3-base-mnli/config.json': nliConfig() }
  await withHf({ textClassification: [nli], nli: [nli], configs }, async (urls) => {
    const found = await client().searchTextClassification('deberta')

    assert.deepEqual(found.map((r) => r.repo), ['MoritzLaurer/DeBERTa-v3-base-mnli'])
    assert.equal(configFetches(urls).length, 1)
  })
})

test('sorted by downloads, the rows from every listing are ordered by downloads, most first', async () => {
  const nli = rootClassifier('tasksource/deberta-nli', { downloads: 500 })
  const laya = { ...LAYA, downloads: 90 }
  const openjev = { ...OPENJEV, downloads: 9000 }
  const configs = {
    'tasksource/deberta-nli/config.json': nliConfig(),
    'AlexWortega/openjev/qwen3.5-0.8b-nli-v2s-long/config.json': nliConfig('Qwen3_5ForSequenceClassification'),
  }
  await withHf({ textClassification: [laya], laya: [laya], nli: [nli, openjev], configs }, async () => {
    const found = await client().searchTextClassification('', 'downloads')

    assert.deepEqual(found.map((r) => [r.repo, r.downloads]), [
      ['AlexWortega/openjev', 9000],
      ['tasksource/deberta-nli', 500],
      ['convaiinnovations/laya', 90],
    ])
  })
})

test('an empty query browses the whole category', async () => {
  await withHf({ laya: [LAYA] }, async (urls) => {
    const found = await client().searchTextClassification('')

    assert.deepEqual(found.map((r) => r.repo), ['convaiinnovations/laya'])
    assert.ok(listingUrls(urls).every((u) => u.includes('search=&')))
  })
})
