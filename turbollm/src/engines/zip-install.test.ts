// zip-install.ts unit tests. Fixtures come from the shared in-memory zip writer in
// test-support/zip-archive.ts, so no platform's `zip` binary is needed and hostile inputs
// (lying sizes, wrong CRCs, path-traversal names) can be crafted precisely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive, type ZipMember } from '../test-support/zip-archive'
import {
  crc32,
  extractZipFiles,
  installZipEngine,
  isPlatformLib,
  packagedAndroidApp,
  pickZipFiles,
  readZipEntries,
  zipBuildDirName,
  ZipError,
} from './zip-install'
import type { ProbeResult } from './probe'
import { sourceBuildDirOf } from './build-runner'

function member(name: string, data = `content of ${name}`): ZipMember {
  return { name, data: Buffer.from(data) }
}

function assertZipError(fn: () => unknown, code: string, message: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ZipError, `expected ZipError, got ${e}`)
    assert.equal(e.code, code)
    assert.match(e.message, new RegExp(message))
    return true
  })
}

// ── reader ───────────────────────────────────────────────────────────────────

test('crc32: known answer (IEEE 802.3 check value)', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('readZipEntries: round-trips members, both compression methods, nested paths', () => {
  const zip = buildZipArchive([
    member('llama-server', 'bin-bytes'),
    member('lib/libggml.so', 'so-bytes'),
    { name: 'stored.txt', data: Buffer.from('raw'), method: 0 },
  ])
  const entries = readZipEntries(zip)
  assert.deepEqual(
    entries.map((e) => e.name),
    ['llama-server', 'lib/libggml.so', 'stored.txt'],
  )
  const bin = entries[0]!
  assert.equal(bin.isDir, false)
  assert.equal(bin.method, 8)
  assert.equal(bin.size, 'bin-bytes'.length)
  // The data offset must land on the real bytes for every member, deflate and stored alike.
  assert.equal(inflateRawSync(zip.subarray(bin.dataOffset, bin.dataOffset + bin.compSize)).toString(), 'bin-bytes')
  assert.equal(zip.subarray(entries[2]!.dataOffset, entries[2]!.dataOffset + entries[2]!.compSize).toString(), 'raw')
  assert.equal(crc32(Buffer.from('bin-bytes')), bin.crc32)
})

test('readZipEntries: zip64 EOCD (saturated EOCD fields) parses identically', () => {
  const zip = buildZipArchive([member('llama-server'), member('libggml.so')], { zip64: true })
  const entries = readZipEntries(zip)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.name, 'llama-server')
})

test('readZipEntries: rejects non-zip bytes', () => {
  assertZipError(() => readZipEntries(Buffer.from('this is not a zip at all')), 'bad_zip', 'not a zip archive')
})

test('readZipEntries: rejects a truncated central directory', () => {
  const zip = Buffer.from(buildZipArchive([member('llama-server')]))
  zip.writeUInt32LE(zip.length, zip.length - 22 + 16) // EOCD's cdOffset → past the end
  assertZipError(() => readZipEntries(zip), 'bad_zip', 'truncated or corrupt')
})

test('readZipEntries: rejects an unsupported compression method', () => {
  assertZipError(() => readZipEntries(buildZipArchive([{ name: 'x', method: 12 }])), 'unsupported_compression', 'method 12')
})

test('readZipEntries: per-member declared-size cap (zip-bomb guard)', () => {
  assertZipError(
    () => readZipEntries(buildZipArchive([{ name: 'bomb.bin', lieSize: 3 * 1024 * 1024 * 1024 }])),
    'zip_too_large',
    'per-member cap',
  )
})

// ── selection (PURE) ─────────────────────────────────────────────────────────

test('isPlatformLib: dll on Windows, dylib on macOS, so/so.N on Linux/Android', () => {
  assert.equal(isPlatformLib('ggml.dll', 'win32'), true)
  assert.equal(isPlatformLib('libggml.so', 'win32'), false)
  assert.equal(isPlatformLib('libcudart.so.12', 'linux'), true)
  assert.equal(isPlatformLib('libggml-cuda.so', 'linux'), true)
  assert.equal(isPlatformLib('ggml.dll', 'linux'), false)
  assert.equal(isPlatformLib('ggml-metal.metal', 'darwin'), false)
  assert.equal(isPlatformLib('libllama.dylib', 'darwin'), true)
})

test('pickZipFiles: binary at any depth; same-dir files + platform libs anywhere ride along', () => {
  const entries = readZipEntries(
    buildZipArchive([
      member('dist/bin/llama-server'),
      member('dist/bin/libggml.so'),
      member('dist/bin/README.txt'), // same-dir non-lib resource — extracted
      member('runtime/cuda/libcudart.so.12'), // lib at another depth — extracted
      member('assets/logo.png'), // non-lib elsewhere — skipped
      member('src/main.cpp'), // non-lib elsewhere — skipped
    ]),
  )
  const sel = pickZipFiles(entries, 'linux')
  assert.ok(sel)
  assert.equal(sel.binary.name, 'dist/bin/llama-server')
  assert.deepEqual(
    [...sel.files.keys()].sort(),
    ['libcudart.so.12', 'libggml.so', 'llama-server', 'readme.txt'],
  )
})

test('pickZipFiles: multiple binaries → shallowest wins, deterministically', () => {
  const entries = readZipEntries(
    buildZipArchive([member('deep/nested/dir/llama-server'), member('cuda/llama-server'), member('cuda/ggml.so')]),
  )
  const sel = pickZipFiles(entries, 'linux')
  assert.ok(sel)
  assert.equal(sel.binary.name, 'cuda/llama-server')
  assert.deepEqual([...sel.files.keys()].sort(), ['ggml.so', 'llama-server'])
})

test('pickZipFiles: platform filter — a Windows zip finds nothing on Linux and vice versa', () => {
  const entries = readZipEntries(
    buildZipArchive([member('win/llama-server.exe'), member('win/ggml.dll'), member('linux/llama-server'), member('linux/libggml.so')]),
  )
  const win = pickZipFiles(entries, 'win32', 'llama-server.exe')
  assert.ok(win)
  assert.equal(win.binary.name, 'win/llama-server.exe')
  assert.ok([...win.files.keys()].includes('ggml.dll'))
  const linux = pickZipFiles(entries, 'linux')
  assert.ok(linux)
  assert.equal(linux.binary.name, 'linux/llama-server')
  assert.deepEqual([...linux.files.keys()].sort(), ['libggml.so', 'llama-server'])
})

test('pickZipFiles: the binary directory wins basename collisions (no cross-variant bleed)', () => {
  const entries = readZipEntries(
    buildZipArchive([member('cuda/llama-server.exe'), member('cuda/ggml.dll'), member('vulkan/ggml.dll'), member('vulkan/ggml-vulkan.dll')]),
  )
  const sel = pickZipFiles(entries, 'win32', 'llama-server.exe')
  assert.ok(sel)
  // 'ggml.dll' resolves to the CUDA one; the Vulkan variant's uniquely-named lib still
  // rides along (harmless — never loaded), but its same-named lib must NOT win.
  assert.equal(sel.files.get('ggml.dll')!.name, 'cuda/ggml.dll')
  assert.ok([...sel.files.keys()].includes('ggml-vulkan.dll'))
})

test('pickZipFiles: null when the archive has no server binary for this platform', () => {
  assert.equal(pickZipFiles(readZipEntries(buildZipArchive([member('docs/readme.txt')]))), null)
  assert.equal(pickZipFiles(readZipEntries(buildZipArchive([member('llama-server.exe')])), 'linux'), null)
})

// ── slug ─────────────────────────────────────────────────────────────────────

test('zipBuildDirName: stem of the zip name, collapsed to one safe path step', () => {
  assert.equal(zipBuildDirName('llama-b9744-bin-win-cuda-x64.zip'), 'llama-b9744-bin-win-cuda-x64')
  assert.equal(zipBuildDirName('my fork (cuda).zip'), 'my-fork-cuda')
  assert.equal(zipBuildDirName('ik_llama.cpp.zip'), 'ik_llama.cpp')
  assert.equal(zipBuildDirName('../../etc/passwd.zip'), 'passwd') // basename first — no traversal
  assert.equal(zipBuildDirName('..'), 'zip-build') // path-step guard
  assert.equal(zipBuildDirName(''), 'zip-build')
  assert.equal(zipBuildDirName('---.zip'), 'zip-build')
})

// ── extraction ───────────────────────────────────────────────────────────────

test('extractZipFiles: CRC-verified flat extraction; the binary and libs land in ONE dir (the LD_LIBRARY_PATH dir), with the exec bit on POSIX', () => {
  const buf = buildZipArchive([
    member('bin/llama-server', 'elf-bytes'),
    member('bin/libggml.so', 'so-bytes'),
    member('bin/libllama.so.1', 'so1-bytes'),
    member('runtime/cuda/libcudart.so.12', 'cudart-bytes'),
  ])
  const entries = readZipEntries(buf)
  const sel = pickZipFiles(entries, 'linux')!
  const dir = tmpDir('tllm-zip-')
  try {
    const binPath = extractZipFiles(buf, sel, dir)
    assert.equal(binPath, join(dir, 'llama-server'))
    assert.equal(existsSync(join(dir, 'libggml.so')), true)
    assert.equal(existsSync(join(dir, 'libllama.so.1')), true)
    assert.equal(existsSync(join(dir, 'libcudart.so.12')), true)
    if (process.platform !== 'win32') {
      assert.notEqual(statSync(binPath).mode & 0o111, 0, 'binary must be executable after extraction')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractZipFiles: a CRC mismatch leaves no partial output behind', () => {
  const buf = buildZipArchive([member('llama-server', 'abc'), { name: 'libggml.so', crc: 0xdeadbeef }])
  const sel = pickZipFiles(readZipEntries(buf), 'linux')!
  const dir = tmpDir('tllm-zip-')
  try {
    assertZipError(() => extractZipFiles(buf, sel, dir), 'zip_crc_mismatch', 'libggml.so')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractZipFiles: actual size differing from the declared size is a corrupt archive', () => {
  const buf = buildZipArchive([member('llama-server', 'abc'), { name: 'libggml.so', lieSize: 99 }])
  const sel = pickZipFiles(readZipEntries(buf), 'linux')!
  const dir = tmpDir('tllm-zip-')
  try {
    assertZipError(() => extractZipFiles(buf, sel, dir), 'bad_zip', 'declared size')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractZipFiles: hostile member names cannot escape the destination', () => {
  // \x00 and path-step basenames are dropped; absolute/traversal names never match the
  // binary's directory and are not libs, so they are never extracted at all.
  const buf = buildZipArchive([member('llama-server', 'abc'), member('evil\0name.txt'), member('../evil.txt'), member('/etc/passwd')])
  const sel = pickZipFiles(readZipEntries(buf), 'linux')!
  const dir = tmpDir('tllm-zip-')
  try {
    extractZipFiles(buf, sel, dir)
    assert.equal(existsSync(join(dir, 'llama-server')), true)
    // The dir holds ONLY the binary — nothing else was selected.
    assert.deepEqual(readdirSync(dir), ['llama-server'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── orchestrator ─────────────────────────────────────────────────────────────

/** The delete-button contract: a zip install must live where the EXISTING purge rule
 *  (DELETE /engines/:id?purge=1 → engineInstallDir → sourceBuildDirOf) already cleans,
 *  so removing the engine in the app removes the extracted files with no new path. */
test('the install layout matches the purge rule: sourceBuildDirOf resolves the zip build dir', () => {
  const enginesRoot = join('x', 'data', 'engines')
  const binPath = join(enginesRoot, 'build', 'myfork', 'llama-server')
  assert.equal(sourceBuildDirOf(binPath, enginesRoot), join(enginesRoot, 'build', 'myfork'))
})

const STUB_PROBE: (bin: string) => Promise<ProbeResult> = async (bin) => {
  assert.equal(existsSync(bin), true)
  return { version: 'b4242 (0deadbe)', capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] } }
}

test('installZipEngine: upload → extract under engines/build/<slug>/ → probe → scan-shaped result', async () => {
  const root = tmpDir('tllm-zip-')
  try {
    const buf = buildZipArchive([
      member('dist/bin/llama-server', 'elf'),
      member('dist/bin/libggml.so', 'so'),
      member('runtime/libcudart.so.12', 'cudart'),
    ])
    const res = await installZipEngine(root, 'myfork.zip', buf, { probeFn: STUB_PROBE })
    assert.ok(res.found)
    assert.equal(res.binPath, join(root, 'build', 'myfork', 'llama-server'))
    assert.equal(res.version, 'b4242 (0deadbe)')
    assert.equal(res.suggestedName, 'myfork (b4242)')
    assert.equal(existsSync(join(root, 'build', 'myfork', 'libggml.so')), true)
    assert.equal(existsSync(join(root, 'build', 'myfork', 'libcudart.so.12')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installZipEngine: a probe failure removes the whole extraction (no half-installed build)', async () => {
  const root = tmpDir('tllm-zip-')
  try {
    const buf = buildZipArchive([member('llama-server', 'elf')])
    await assert.rejects(
      installZipEngine(root, 'myfork.zip', buf, { probeFn: async () => { throw new Error('probe_failed: wrong OS') } }),
      /wrong OS/,
    )
    assert.equal(existsSync(join(root, 'build', 'myfork')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installZipEngine: no server binary → found:false and nothing written to disk', async () => {
  const root = tmpDir('tllm-zip-')
  try {
    const res = await installZipEngine(root, 'empty.zip', buildZipArchive([member('readme.txt')]), { probeFn: STUB_PROBE })
    assert.deepEqual(res, { found: false })
    assert.equal(existsSync(join(root, 'build')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installZipEngine: a same-named zip replaces a prior extraction in place (rebuild semantics)', async () => {
  const root = tmpDir('tllm-zip-')
  try {
    const stale = join(root, 'build', 'myfork', 'stale-file.txt')
    mkdirSync(join(root, 'build', 'myfork'), { recursive: true })
    writeFileSync(stale, 'junk from an earlier extraction')
    const res = await installZipEngine(root, 'myfork.zip', buildZipArchive([member('llama-server', 'elf')]), { probeFn: STUB_PROBE })
    assert.ok(res.found)
    assert.equal(existsSync(stale), false, 'the clean-start wipe must remove the old extraction')
    assert.equal(existsSync(res.binPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── platform guard ───────────────────────────────────────────────────────────

test('packagedAndroidApp: W^X guard is exactly the packaged app, not Termux', () => {
  assert.equal(packagedAndroidApp('android', { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/…/lib' }), true)
  assert.equal(packagedAndroidApp('android', {}), false) // Termux — exec from home works
  assert.equal(packagedAndroidApp('linux', { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/x' }), false)
})
