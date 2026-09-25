// Jev and Laya are two runtimes behind one thing the user sees: a text classification model (ADR-444). It labels or
// scores text and cannot chat, so every "is this a decision model?" rule asks here instead of checking one flag.

export type TextClassifierRuntime = 'vllm' | 'laya'

/** Only presence matters, so the narrow twins of ModelEntry (cli-launch.ts, model-tools.ts) that type these flags
 *  as `unknown` qualify as well as the scanner's own entries. */
interface ClassifierFlags {
  jev?: unknown
  laya?: unknown
}

export function isTextClassifier(entry: ClassifierFlags): boolean {
  return textClassifierRuntime(entry) !== undefined
}

export function textClassifierRuntime(entry: ClassifierFlags): TextClassifierRuntime | undefined {
  if (entry.jev) return 'vllm'
  if (entry.laya) return 'laya'
  return undefined
}
