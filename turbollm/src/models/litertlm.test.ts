import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  hasLitertlmMagic,
  isLitertlmFileName,
  litertlmEntryFor,
  litertlmNativeCtxFromFile,
  litertlmNativeCtxFromName,
  litertlmQuantFromName,
} from './litertlm'
import { tmpDir } from '../test-support/tmp'

function scratch(t: TestContext): string {
  const dir = tmpDir('turbollm-litertlm-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('isLitertlmFileName matches the extension case-insensitively and nothing else', () => {
  assert.equal(isLitertlmFileName('gemma-3n-E2B-it-int4.litertlm'), true)
  assert.equal(isLitertlmFileName('MODEL.LITERTLM'), true)
  assert.equal(isLitertlmFileName('model.gguf'), false)
  assert.equal(isLitertlmFileName('model.litertlm.part'), false)
})

test('hasLitertlmMagic accepts the 8-byte LITERTLM header and rejects anything else', async (t) => {
  const dir = scratch(t)
  const good = join(dir, 'good.litertlm')
  const html = join(dir, 'html.litertlm')
  const short = join(dir, 'short.litertlm')
  writeFileSync(good, Buffer.concat([Buffer.from('LITERTLM'), Buffer.alloc(64)]))
  writeFileSync(html, '<html>404 not found</html>')
  writeFileSync(short, 'LITER')
  assert.equal(await hasLitertlmMagic(good), true)
  assert.equal(await hasLitertlmMagic(html), false)
  assert.equal(await hasLitertlmMagic(short), false)
  assert.equal(await hasLitertlmMagic(join(dir, 'missing.litertlm')), false)
})

test('litertlmQuantFromName reads the precision from separators and takes the last match', () => {
  assert.equal(litertlmQuantFromName('gemma-3n-E2B-it-int4.litertlm'), 'INT4')
  assert.equal(litertlmQuantFromName('Qwen3-0.6B_q8_ekv4096.litertlm'), 'Q8')
  assert.equal(litertlmQuantFromName('model-fp16.litertlm'), 'FP16')
  assert.equal(litertlmQuantFromName('int8-model-int4.litertlm'), 'INT4')
  assert.equal(litertlmQuantFromName('plain.litertlm'), '?')
  // a number-letter run inside a word is not a precision
  assert.equal(litertlmQuantFromName('print4-model.litertlm'), '?')
})

test('litertlmNativeCtxFromName reads ekvNNNN and returns 0 when absent', () => {
  assert.equal(litertlmNativeCtxFromName('Qwen3-0.6B_multi-prefill-seq_q8_ekv4096.litertlm'), 4096)
  assert.equal(litertlmNativeCtxFromName('model-ekv1280.litertlm'), 1280)
  assert.equal(litertlmNativeCtxFromName('model.litertlm'), 0)
  assert.equal(litertlmNativeCtxFromName('model-ekv12.litertlm'), 0)
})

test('litertlmEntryFor builds a single-file, text-only library entry', () => {
  const e = litertlmEntryFor('/models/gemma-3n-E2B-it-int4.litertlm', '/models', 3_000_000_000, 1_700_000_000_000)
  assert.equal(e.format, 'litertlm')
  assert.equal(e.name, 'gemma 3n E2B it int4')
  assert.equal(e.quant, 'INT4')
  assert.equal(e.path, '/models/gemma-3n-E2B-it-int4.litertlm')
  assert.equal(e.key, 'gemma 3n e2b it int4|INT4|3000000000')
  assert.equal(e.vision, false)
  assert.equal(e.audio, false)
  assert.equal(e.mmprojPath, null)
  assert.equal(e.incomplete, false)
  assert.equal(e.parseError, null)
})

test('litertlmEntryFor flags an empty file as incomplete', () => {
  assert.equal(litertlmEntryFor('/m/a.litertlm', '/m', 0, 0).incomplete, true)
})

// ── context limit from the header ──────────────────────────────────────────────────────────

function varint(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}
const pVarint = (field: number, v: number) => [...varint(field * 8), ...varint(v)]
const pBytes = (field: number, b: number[]) => [...varint(field * 8 + 2), ...varint(b.length), ...b]

/** A minimal .litertlm: the real prefix, a hand-built section FlatBuffer, and the two metadata protos. */
function fakeBundle(llmMax: number, kvLens: number[]): Buffer {
  const llm = Buffer.from(pVarint(5, llmMax))
  const states = kvLens.flatMap((n) => pBytes(2, [...pBytes(1, [...Buffer.from('kv_cache_k_0')]), ...pVarint(9, n)]))
  const exec = Buffer.from(pBytes(1, states))
  const hdr = Buffer.alloc(108)
  hdr.writeUInt32LE(12, 0) // root table
  hdr.writeUInt16LE(8, 4); hdr.writeUInt16LE(8, 6); hdr.writeUInt16LE(0, 8); hdr.writeUInt16LE(4, 10) // root vtable
  hdr.writeInt32LE(8, 12); hdr.writeUInt32LE(28 - 16, 16) // root → section_metadata
  hdr.writeUInt16LE(6, 20); hdr.writeUInt16LE(8, 22); hdr.writeUInt16LE(4, 24) // section_metadata vtable
  hdr.writeInt32LE(8, 28); hdr.writeUInt32LE(36 - 32, 32) // → objects vector
  hdr.writeUInt32LE(2, 36); hdr.writeUInt32LE(60 - 40, 40); hdr.writeUInt32LE(84 - 44, 44)
  hdr.writeUInt16LE(12, 48); hdr.writeUInt16LE(24, 50); hdr.writeUInt16LE(0, 52); hdr.writeUInt16LE(4, 54); hdr.writeUInt16LE(12, 56); hdr.writeUInt16LE(20, 58) // object vtable
  hdr.writeInt32LE(60 - 48, 60); hdr.writeBigUInt64LE(256n, 64); hdr.writeBigUInt64LE(BigInt(256 + llm.length), 72); hdr.writeUInt8(5, 80)
  hdr.writeInt32LE(84 - 48, 84); hdr.writeBigUInt64LE(512n, 88); hdr.writeBigUInt64LE(BigInt(512 + exec.length), 96); hdr.writeUInt8(9, 104)
  const file = Buffer.alloc(512 + exec.length)
  file.write('LITERTLM', 0, 'latin1')
  file.writeUInt32LE(1, 8); file.writeUInt32LE(6, 12)
  file.writeBigUInt64LE(BigInt(32 + hdr.length), 24)
  hdr.copy(file, 32)
  llm.copy(file, 256)
  exec.copy(file, 512)
  return file
}

test('litertlmNativeCtxFromFile: the KV caches\' maximum_sequence_length is the limit, the smallest one winning', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'LFM2.5-230M_int8.litertlm')
  writeFileSync(p, fakeBundle(4096, [8192, 4096]))
  assert.equal(await litertlmNativeCtxFromFile(p), 4096)
})

test('litertlmNativeCtxFromFile: LlmMetadata max_num_tokens when no KV cache declares a length', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'm.litertlm')
  writeFileSync(p, fakeBundle(32768, []))
  assert.equal(await litertlmNativeCtxFromFile(p), 32768)
})

test('litertlmNativeCtxFromFile: 0 for anything it cannot read', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'bad.litertlm')
  writeFileSync(p, Buffer.from('LITERTLM garbage that is not a header'))
  assert.equal(await litertlmNativeCtxFromFile(p), 0)
  assert.equal(await litertlmNativeCtxFromFile(join(dir, 'missing.litertlm')), 0)
})

test('litertlmEntryFor: the header limit wins over the name tag, which stays the fallback', () => {
  assert.equal(litertlmEntryFor('/m/x_ekv8192.litertlm', '/m', 10, 0, 4096).nativeCtx, 4096)
  assert.equal(litertlmEntryFor('/m/x_ekv8192.litertlm', '/m', 10, 0).nativeCtx, 8192)
})
