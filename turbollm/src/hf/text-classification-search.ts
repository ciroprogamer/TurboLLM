// Discover's "Text classification" category (ADR-444): every repo TurboLLM can run as a classifier, whichever engine
// is active. A Laya bundle is known from its file names and library tag alone; an NLI cross-encoder only from its own
// config.json, which detectJev reads (ADR-436 (1)). The listing gives file names and the root config's architectures for free.
import { detectJev } from '../models/jev'
import { checkpointDirs } from './checkpoints'
import type { HfSortOption, RawSearchItem, RawTreeEntry } from './hf'
import { isLayaEngineRepo, isLayaRepo } from './laya-repo'

/** One row of HF's model list, with the file names and root config the category is judged from. */
export interface ListedModel extends RawSearchItem {
  siblings?: { rfilename: string }[]
  config?: { architectures?: unknown }
}

/** The engine a text-classification repo loads on: the Laya engine, or vLLM for a Jev (NLI) model. */
export type TextClassificationRuntime = 'laya' | 'vllm'

export interface TextClassificationRepo {
  model: ListedModel
  runtime: TextClassificationRuntime
}

/** How the category reads Hugging Face: one model listing by its query parameters, and one config.json. */
export interface TextClassificationHub {
  listModels(params: string): Promise<ListedModel[]>
  readConfig(repo: string, dir: string): Promise<unknown>
}

export type TextClassificationCandidate =
  | { model: ListedModel; runtime: 'laya' }
  | { model: ListedModel; runtime: 'vllm'; configDir: string }

/** How many NLI configs one search may read: each is a request against HF's rate limit while the user waits for the
 *  results. Candidates past it are dropped, never listed unverified. */
export const MAX_NLI_VERIFICATIONS = 8

/** The repos of the category's listings that TurboLLM can run, in {@link mergeListings} order. */
export async function findTextClassificationRepos(
  sort: HfSortOption,
  hub: TextClassificationHub,
): Promise<TextClassificationRepo[]> {
  const listings = await answeredListings(hub)
  const candidates = mergeListings(listings, sort).flatMap((model) => textClassificationCandidate(model) ?? [])
  return runnable(candidates, hub)
}

/** HF's text-classification tag misses the NLI models it tags zero-shot-classification, which the nli tag finds; the
 *  laya tag finds Laya bundles whatever their pipeline tag. */
const CATEGORY_LISTINGS = ['pipeline_tag=text-classification', 'filter=laya', 'filter=nli']

/** Given any expand[], HF returns only the fields asked for (checked live 2026-09-25), so every field read here or by
 *  the search row is named. The expanded config has a root config's architectures, never its id2label. */
const LISTED_FIELDS = ['siblings', 'config', 'library_name', 'downloads', 'likes', 'lastModified', 'createdAt', 'gated', 'tags']
  .map((field) => `expand[]=${field}`)
  .join('&')

/** A failed listing is left out, as searchModels leaves out a failed Laya search. Only when none answers does the
 *  search fail, with the first listing's error. */
async function answeredListings(hub: TextClassificationHub): Promise<ListedModel[][]> {
  const settled = await Promise.allSettled(
    CATEGORY_LISTINGS.map((listing) => hub.listModels(`${listing}&${LISTED_FIELDS}`)),
  )
  const answered = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  if (answered.length === 0) throw (settled[0] as PromiseRejectedResult).reason
  return answered
}

/** Pure. The category's listings as one list, each repo once where it first turned up: ranked by the sort's own
 *  field when it has one, otherwise taking turns between the listings so that none starves the others. */
export function mergeListings(listings: ListedModel[][], sort: HfSortOption): ListedModel[] {
  const rankOf = RANK_OF[sort]
  if (!rankOf) return uniqueRepos(takeTurns(listings))
  return uniqueRepos(listings.flat()).sort((a, b) => descending(rankOf(a), rankOf(b)))
}

const RANK_OF: Partial<Record<HfSortOption, (model: ListedModel) => number | string>> = {
  downloads: (model) => model.downloads ?? 0,
  likes: (model) => model.likes ?? 0,
  modified: (model) => model.lastModified ?? '',
  created: (model) => model.createdAt ?? '',
}

function takeTurns(listings: ListedModel[][]): ListedModel[] {
  const rounds = Math.max(0, ...listings.map((listing) => listing.length))
  return Array.from({ length: rounds }, (_, round) => listings.flatMap((listing) => listing.slice(round, round + 1)))
    .flat()
}

function uniqueRepos(models: ListedModel[]): ListedModel[] {
  const firstById = new Map<string, ListedModel>()
  for (const model of models) if (!firstById.has(repoIdOf(model))) firstById.set(repoIdOf(model), model)
  return [...firstById.values()]
}

function descending(a: number | string, b: number | string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

/** Pure. From the listing alone: a Laya bundle, or an NLI candidate and the checkpoint folder whose config decides
 *  it. */
export function textClassificationCandidate(model: ListedModel): TextClassificationCandidate | undefined {
  if (isMlxPort(model)) return undefined
  const files = listedFiles(model)
  if (isLayaRepo(files)) return isLayaEngineRepo(model) ? { model, runtime: 'laya' } : undefined
  const configDir = classifierCheckpointDir(model, files)
  return configDir === undefined ? undefined : { model, runtime: 'vllm', configDir }
}

/** MLX weights load on neither the Laya engine (PyTorch) nor vLLM, whatever the repo's files look like. */
function isMlxPort(model: ListedModel): boolean {
  return model.library_name === 'mlx'
}

function listedFiles(model: ListedModel): RawTreeEntry[] {
  return (model.siblings ?? []).map((sibling) => ({ type: 'file', path: sibling.rfilename }))
}

/** A checkpoint (not merely a config) so that nothing is listed that Discover could not download. The root counts
 *  only when its listed config declares a classifier; a subfolder's config is not in the listing. */
function classifierCheckpointDir(model: ListedModel, files: RawTreeEntry[]): string | undefined {
  return checkpointDirs(files).find((dir) => dir !== '' || declaresSequenceClassifier(model.config))
}

/** A pre-filter that saves a fetch, never the rule: detectJev decides on the fetched config. */
function declaresSequenceClassifier(config: ListedModel['config']): boolean {
  const declared: unknown = Array.isArray(config?.architectures) ? config.architectures[0] : undefined
  return typeof declared === 'string' && declared.endsWith(SEQUENCE_CLASSIFIER_SUFFIX)
}

const SEQUENCE_CLASSIFIER_SUFFIX = 'ForSequenceClassification'

type NliCandidate = Extract<TextClassificationCandidate, { runtime: 'vllm' }>

async function runnable(
  candidates: TextClassificationCandidate[],
  hub: TextClassificationHub,
): Promise<TextClassificationRepo[]> {
  const verifiable = new Set(likelyNliFirst(candidates.filter(isNliCandidate)).slice(0, MAX_NLI_VERIFICATIONS))
  const verdicts = await Promise.all(
    candidates.map((candidate) =>
      candidate.runtime === 'laya' || (verifiable.has(candidate) && isJevCheckpoint(candidate, hub))),
  )
  return candidates.filter((_, i) => verdicts[i]).map(({ model, runtime }) => ({ model, runtime }))
}

/** The read budget is small, and a listing sorted by downloads is mostly rerankers, guards and sentiment models:
 *  the repos Hugging Face tags nli are read first, each group in its own order. */
function likelyNliFirst(candidates: NliCandidate[]): NliCandidate[] {
  const taggedNli = (candidate: NliCandidate) => candidate.model.tags?.includes('nli') === true
  return [...candidates.filter(taggedNli), ...candidates.filter((candidate) => !taggedNli(candidate))]
}

function isNliCandidate(candidate: TextClassificationCandidate): candidate is NliCandidate {
  return candidate.runtime === 'vllm'
}

/** An unreadable config is a no: a repo is never listed unverified. */
async function isJevCheckpoint(candidate: NliCandidate, hub: TextClassificationHub): Promise<boolean> {
  try {
    return detectJev(await hub.readConfig(repoIdOf(candidate.model), candidate.configDir)) !== undefined
  } catch {
    return false
  }
}

function repoIdOf(model: ListedModel): string {
  return model.id ?? model.modelId ?? ''
}
