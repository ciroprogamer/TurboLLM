// Custom-engine install from an uploaded .zip — the third Add-engine source, next to
// "choose a folder on disk" (scan.ts) and "build from a git repo" (build-runner.ts). A
// fork's release zip can bury the server binary and its runtime libraries at ANY depth
// (bin/Release/…, per-backend dirs, a nested dist/), and archives made on Windows lose the
// POSIX exec bit, so "unzip it yourself and point the folder scan at it" asks the user to
// do that archaeology by hand. This module searches the archive's central directory
// instead: it picks one server binary (shallowest first), then flattens everything from the
// binary's OWN directory plus this platform's shared libraries from anywhere else into ONE
// directory under {enginesRoot}/build/<slug>/ — the same root the 1-click build uses, so
// DELETE /engines/:id?purge=1 (engineInstallDir → sourceBuildDirOf) removes the files with
// no new delete path, and isManagedBuild never auto-cleans it. The flat layout is also what
// makes the result launchable everywhere: Windows' loader searches the exe's own directory,
// and probe.ts/manager.ts already point LD_LIBRARY_PATH at dirname(bin) on every non-Windows
// platform — Linux, macOS, and Android/Termux, which ships llama.cpp builds with no RPATH
// at all (GitHub #52 / ADR-390/391).
//
// Extraction is dependency-free pure Node (zlib raw-inflate over a central-directory parser
// with Zip64 support): the download pipeline's PowerShell/tar split doesn't apply here — a
// user zip arrives as .zip on every platform, and GNU tar (plain Linux, Termux) cannot read
// zip, while `unzip` is an optional package there.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { serverBinName, suggestEngineName } from './scan'
import { probe, type ProbeResult } from './probe'

/** Hard cap on an uploaded zip's compressed bytes (also enforced pre-parse via
 *  Content-Length). Real llama.cpp builds land well under this even with CUDA runtimes; the
 *  cap exists so a request can't buffer an unbounded blob into daemon memory. */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024

/** Central-directory-declared uncompressed-size guards (zip-bomb class). Checked BEFORE any
 *  inflate, so a lying directory can't get the bytes allocated first. */
const MAX_ENTRY_UNCOMPRESSED = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024
const MAX_ENTRIES = 10_000

export type ZipErrorCode =
  | 'bad_zip' // not a zip archive, or a structurally corrupt one
  | 'unsupported_compression'
  | 'zip_too_large' // declared or actual sizes over the caps above
  | 'zip_crc_mismatch' // a member failed its CRC-32 check

export class ZipError extends Error {
  constructor(
    public code: ZipErrorCode,
    msg: string,
  ) {
    super(msg)
    this.name = 'ZipError'
  }
}

/** One central-directory member. `dataOffset` is the absolute offset of the compressed
 *  bytes, resolved through the LOCAL header (whose name/extra lengths may differ from the
 *  central directory's — reading them from the CD instead mislocates the data). */
export interface ZipEntry {
  name: string // archive path, forward slashes
  isDir: boolean
  crc32: number
  method: number // 0 = stored, 8 = deflate
  compSize: number
  size: number // uncompressed
  dataOffset: number
}

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CD_ENTRY_SIG = 0x02014b50
const LOCAL_HEADER_SIG = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const UTF8_NAME_FLAG = 0x0800

/** Parse every member out of a zip's central directory. Zip64 is honored when the EOCD
 *  overflows (0xFFFFFFFF offsets / 0xFFFF counts). Throws ZipError('bad_zip' |
 *  'unsupported_compression' | 'zip_too_large') on anything malformed — never returns a
 *  half-parsed list. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (buf.length < 22 || eocd === null) throw new ZipError('bad_zip', 'This file is not a zip archive.')
  let entryCount = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  // Zip64: the EOCD's 32-bit fields saturate; the real values live in the EOCD64 record a
  // back-reference (the locator) points at.
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG)
      throw new ZipError('bad_zip', 'Zip64 archive is missing its EOCD64 locator.')
    const eocd64 = readU64asNumber(buf, locator + 8)
    if (eocd64 + 56 > buf.length || buf.readUInt32LE(eocd64) !== EOCD64_SIG)
      throw new ZipError('bad_zip', 'Zip64 archive has a corrupt EOCD64 record.')
    entryCount = readU64asNumber(buf, eocd64 + 32)
    cdOffset = readU64asNumber(buf, eocd64 + 48)
  }
  if (entryCount > MAX_ENTRIES) throw new ZipError('bad_zip', `Archive lists ${entryCount} members (cap ${MAX_ENTRIES}).`)

  const entries: ZipEntry[] = []
  let p = cdOffset
  let totalUncompressed = 0
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_ENTRY_SIG)
      throw new ZipError('bad_zip', 'Central directory is truncated or corrupt.')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc32 = buf.readUInt32LE(p + 16)
    let compSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    let localOffset = buf.readUInt32LE(p + 42)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const nameEnd = p + 46 + nameLen
    if (nameEnd + extraLen + commentLen > buf.length) throw new ZipError('bad_zip', 'Central directory is truncated or corrupt.')
    // Zip64 extra field: the 64-bit replacements appear in a fixed order, each ONLY for the
    // fields whose 32-bit original is the 0xFFFFFFFF sentinel.
    const extraEnd = nameEnd + extraLen
    let q = nameEnd
    while (q + 4 <= extraEnd) {
      const id = buf.readUInt16LE(q)
      const dataSize = buf.readUInt16LE(q + 2)
      const fieldEnd = q + 4 + dataSize
      if (fieldEnd > extraEnd) break
      if (id === ZIP64_EXTRA_ID) {
        let r = q + 4
        if (size === 0xffffffff) { size = readU64asNumber(buf, r); r += 8 }
        if (compSize === 0xffffffff) { compSize = readU64asNumber(buf, r); r += 8 }
        if (localOffset === 0xffffffff) localOffset = readU64asNumber(buf, r)
      }
      q = fieldEnd
    }
    const name = buf.toString(flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1', nameEnd - nameLen, nameEnd)
    if (method !== 0 && method !== 8)
      throw new ZipError('unsupported_compression', `"${name}" uses compression method ${method} (only stored and deflate are supported).`)
    if (size > MAX_ENTRY_UNCOMPRESSED) throw new ZipError('zip_too_large', `"${name}" expands past the ${MAX_ENTRY_UNCOMPRESSED >> 30} GiB per-member cap.`)
    totalUncompressed += size
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new ZipError('zip_too_large', 'Archive expands past the total uncompressed-size cap.')

    // Resolve the data offset through the local header, whose own name/extra lengths are
    // authoritative for where the bytes start.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG)
      throw new ZipError('bad_zip', `"${name}" has a corrupt local header.`)
    const dataOffset = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataOffset + compSize > buf.length) throw new ZipError('bad_zip', `"${name}" data runs past the end of the archive.`)

    entries.push({ name, isDir: name.endsWith('/'), crc32, method, compSize, size, dataOffset })
    p = nameEnd + extraLen + commentLen
  }
  return entries
}

/** Locate the End-Of-Central-Directory record — scan backwards since a zip may carry up to
 *  64 KiB of trailing comment (or appended junk). Null when absent. */
function findEocd(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return null
}

function readU64asNumber(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off)
  if (v > Number.MAX_SAFE_INTEGER) throw new ZipError('bad_zip', 'Zip64 field exceeds a safe integer.')
  return Number(v)
}

// CRC-32 (IEEE 802.3, poly 0xEDB88320) — zlib's raw-inflate carries no CRC, so the archive's
// own per-member CRC-32 is the only corruption signal; this computes it for comparison.
let crcTable: Uint32Array | null = null
export function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A shared-library member for the given platform (the "libs it needs" half of the search):
 *  .dll beside the exe on Windows, .dylib on macOS, and .so / .so.N versioned sonames on
 *  Linux and Android/Termux (libggml.so, libcudart.so.12). */
export function isPlatformLib(fileName: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /\.dll$/i.test(fileName)
  if (platform === 'darwin') return /\.dylib$/i.test(fileName)
  return /\.so(\.\d+)*$/i.test(fileName)
}

function dirOf(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}

function baseOf(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name
}

function depthOf(name: string): number {
  return name.replace(/\\/g, '/').split('/').filter(Boolean).length - 1
}

/** A basename that can never be written as a file: path steps, empty, or containing
 *  control characters (a hostile archive member like "con", NUL, or "\n" would otherwise
 *  make writeFileSync throw mid-extraction). */
function unwritableBase(base: string): boolean {
  return base === '' || base === '.' || base === '..' || /[\x00-\x1f]/.test(base)
}

export interface ZipSelection {
  /** The chosen llama-server member (shallowest, then archive order — deterministic for
   *  multi-variant zips that ship one binary per backend folder). */
  binary: ZipEntry
  /** Members to extract, keyed by lowercased destination basename (case-insensitive
   *  dedupe: the binary's own directory always wins); the written filename is the entry's
   *  own basename. Flattening is what makes the result loadable — see the module header. */
  files: Map<string, ZipEntry>
}

/** PURE: choose what to extract. (1) every member of the binary's own directory rides
 *  along — that directory is the build's real unit (runtime DLLs/so's, plus resource files
 *  like ggml-metal.metal that must sit next to the binary); (2) shared libraries found at
 *  ANY other depth are added when their basename isn't already taken, so a zip that splits
 *  bin/ and lib/ still assembles a loadable set while a sibling variant's same-named
 *  libraries can never bleed in. Returns null when the archive holds no server binary. */
export function pickZipFiles(entries: ZipEntry[], platform: NodeJS.Platform = process.platform, binName = serverBinName): ZipSelection | null {
  const binKey = binName.toLowerCase()
  const candidates = entries.filter((e) => !e.isDir && baseOf(e.name).toLowerCase() === binKey)
  if (candidates.length === 0) return null
  const binary = [...candidates].sort(
    (a, b) => depthOf(a.name) - depthOf(b.name) || entries.indexOf(a) - entries.indexOf(b),
  )[0]!
  const binDir = dirOf(binary.name)

  const files = new Map<string, ZipEntry>()
  const add = (e: ZipEntry) => {
    const base = baseOf(e.name)
    if (unwritableBase(base)) return
    const key = base.toLowerCase()
    if (!files.has(key)) files.set(key, e)
  }
  for (const e of entries) if (!e.isDir && dirOf(e.name) === binDir) add(e)
  for (const e of entries) if (!e.isDir && dirOf(e.name) !== binDir && isPlatformLib(baseOf(e.name), platform)) add(e)
  return { binary, files }
}

/** The install dir slug under {enginesRoot}/build/ — the uploaded zip's filename stem,
 *  collapsed to a safe single path step. Same sanitization contract as build-runner's
 *  asDirName: a name that reduces to a path step ("..", "." — or an empty stem) becomes a
 *  constant fallback rather than escaping the build root. */
export function zipBuildDirName(fileName: string): string {
  const stem = basename(fileName.trim()).replace(/\.zip$/i, '')
  const slug = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return /^\.*$/.test(slug) ? 'zip-build' : slug
}

/** Extract a selection into destDir and return the server binary's path. Every member is
 *  CRC-32-verified before it is written, so a corrupt archive leaves nothing behind (the
 *  caller GCs destDir on any throw). On POSIX the binary gets the exec bit — zips created
 *  on Windows carry no mode bits, and execve() would fail with EACCES otherwise. */
export function extractZipFiles(buf: Buffer, selection: ZipSelection, destDir: string): string {
  mkdirSync(destDir, { recursive: true })
  for (const entry of selection.files.values()) {
    const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize)
    let data: Buffer
    try {
      data = entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
        throw new ZipError('zip_too_large', `"${entry.name}" expands past its declared size.`)
      throw new ZipError('bad_zip', `"${entry.name}" could not be decompressed — the archive is corrupt.`)
    }
    if (data.length !== entry.size) throw new ZipError('bad_zip', `"${entry.name}" does not match its declared size.`)
    if (crc32(data) !== entry.crc32) throw new ZipError('zip_crc_mismatch', `"${entry.name}" failed its CRC-32 check — the archive is corrupt.`)
    writeFileSync(join(destDir, baseOf(entry.name)), data)
  }
  const binPath = join(destDir, baseOf(selection.binary.name))
  if (process.platform !== 'win32') {
    try {
      chmodSync(binPath, 0o755)
    } catch {
      // best-effort — some filesystems reject chmod; the probe surfaces a real error then
    }
  }
  return binPath
}

export type ZipScanResult =
  | { found: false }
  | { found: true; binPath: string; version: string; capabilities: ProbeResult['capabilities']; suggestedName: string }

/** Upload → install → probe. Returns the same shape as POST /engines/scan so the
 *  Add-engine dialog's confirm step works unchanged; registration still goes through
 *  POST /engines (which records the custom-source identity). A clean start wipes a prior
 *  extraction of the same-named zip, mirroring runBuild's rebuild semantics; on ANY
 *  failure the whole dir is removed again so a half-read archive never lingers as a
 *  "build" the UI might offer to enable. */
export async function installZipEngine(
  enginesRoot: string,
  zipFileName: string,
  bytes: Buffer,
  opts: { probeFn?: (bin: string) => Promise<ProbeResult> } = {},
): Promise<ZipScanResult> {
  if (bytes.length > MAX_ZIP_BYTES)
    throw new ZipError('zip_too_large', `Engine zips are capped at ${MAX_ZIP_BYTES / (1024 * 1024 * 1024)} GiB.`)
  const entries = readZipEntries(bytes)
  const selection = pickZipFiles(entries)
  if (!selection) return { found: false }
  const destDir = join(enginesRoot, 'build', zipBuildDirName(zipFileName))
  rmSync(destDir, { recursive: true, force: true })
  try {
    const binPath = extractZipFiles(bytes, selection, destDir)
    const pr = await (opts.probeFn ?? probe)(binPath)
    return { found: true, binPath, version: pr.version, capabilities: pr.capabilities, suggestedName: suggestEngineName(binPath, pr.version) }
  } catch (e) {
    try {
      rmSync(destDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    throw e
  }
}

/** True inside the packaged Android app (nodejs-mobile), where W^X hardening forbids
 *  execve() of anything outside the APK's nativeLibraryDir — an uploaded zip would extract
 *  fine but its binary could never run. Termux (also process.platform 'android', but
 *  without MainActivity.kt's env var) can exec from its home, so uploads stay allowed
 *  there. Mirrors sysinfo's bundledEnginesOnly. */
export function packagedAndroidApp(platform: NodeJS.Platform = process.platform, env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR?: string } = process.env): boolean {
  return platform === 'android' && !!env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
}
