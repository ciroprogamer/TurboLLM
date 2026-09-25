// Jev and Laya are two runtimes behind one thing the user sees: a text classification model (ADR-444). It labels or
// scores text and cannot chat, so every "is this a decision model?" rule asks here instead of checking one flag.

export type TextClassifierRuntime = 'vllm' | 'laya'

/** What API clients and the model tools call each one (`kind: "jev"` / `kind: "laya"`). */
export type TextClassifierKind = 'jev' | 'laya'

/** Only presence matters, so the narrow twins of ModelEntry (cli-launch.ts, model-tools.ts) that type these flags
 *  as `unknown` qualify as well as the scanner's own entries. */
interface ClassifierFlags {
  jev?: unknown
  laya?: unknown
}

export function isTextClassifier(entry: ClassifierFlags): boolean {
  return textClassifierRuntime(entry) !== undefined
}

/** Does this key name a text classification model in `models`? A key the library does not hold names none. */
export function isTextClassifierKey(models: readonly (ClassifierFlags & { key: string })[], key: string): boolean {
  const entry = models.find((m) => m.key === key)
  return entry !== undefined && isTextClassifier(entry)
}

export function textClassifierRuntime(entry: ClassifierFlags): TextClassifierRuntime | undefined {
  if (entry.jev) return 'vllm'
  if (entry.laya) return 'laya'
  return undefined
}

export function textClassifierKind(entry: ClassifierFlags): TextClassifierKind | undefined {
  const runtime = textClassifierRuntime(entry)
  return runtime && KIND_OF_RUNTIME[runtime]
}

const KIND_OF_RUNTIME: Record<TextClassifierRuntime, TextClassifierKind> = { vllm: 'jev', laya: 'laya' }
