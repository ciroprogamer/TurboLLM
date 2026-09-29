import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'tllm.thinkingBlock.height'

export const MIN_THINKING_BLOCK_HEIGHT = 48

const listeners = new Set<() => void>()

export function saveThinkingBlockHeight(height: number): void {
  if (!isUsableHeight(height)) return
  try {
    localStorage.setItem(STORAGE_KEY, String(height))
  } catch {
    return
  }
  listeners.forEach((notify) => notify())
}

export function useThinkingBlockHeight(): number | null {
  return useSyncExternalStore(subscribe, readSavedHeight, () => null)
}

function readSavedHeight(): number | null {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    return isUsableHeight(saved) ? saved : null
  } catch {
    return null
  }
}

function isUsableHeight(height: number): boolean {
  return Number.isFinite(height) && height >= MIN_THINKING_BLOCK_HEIGHT
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
