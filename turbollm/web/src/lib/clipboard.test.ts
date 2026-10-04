// Opened over the LAN (http://192.168.x.x:6996) or an http tunnel, the page is NOT a secure
// context, so `navigator.clipboard` is undefined and Copy buttons silently did nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from './clipboard'

const writeText = vi.fn()
const execCommand = vi.fn()

function setClipboardApi(available: boolean) {
  Object.defineProperty(navigator, 'clipboard', {
    value: available ? { writeText } : undefined,
    configurable: true,
  })
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  execCommand.mockReset().mockReturnValue(true)
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('copyToClipboard', () => {
  it('uses the async clipboard API in a secure context', async () => {
    setClipboardApi(true)
    await copyToClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to selecting a hidden field over plain http (LAN)', async () => {
    setClipboardApi(false)
    let selectedText = ''
    execCommand.mockImplementation(() => {
      const field = document.activeElement as HTMLTextAreaElement
      selectedText = field.value.slice(field.selectionStart, field.selectionEnd)
      return true
    })
    await copyToClipboard('lan text')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(selectedText).toBe('lan text')
  })

  it('selects the full range explicitly, since iOS Safari ignores select() on a read-only field', async () => {
    setClipboardApi(false)
    const setRange = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    await copyToClipboard('lan text')
    expect(setRange).toHaveBeenCalledWith(0, 'lan text'.length)
    setRange.mockRestore()
  })

  it('falls back when the async API rejects', async () => {
    setClipboardApi(true)
    writeText.mockRejectedValue(new Error('NotAllowedError'))
    await copyToClipboard('x')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('removes the hidden field and restores focus', async () => {
    setClipboardApi(false)
    document.body.innerHTML = '<div><button id="b">copy</button></div>'
    const button = document.getElementById('b') as HTMLButtonElement
    button.focus()
    await copyToClipboard('x')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('rejects when no copy path works', async () => {
    setClipboardApi(false)
    execCommand.mockReturnValue(false)
    await expect(copyToClipboard('x')).rejects.toThrow('Clipboard is not available')
  })
})
