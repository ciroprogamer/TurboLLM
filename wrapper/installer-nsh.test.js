// installer-nsh.test.js — wrapper/build/installer.nsh closes a running TurboLLM before the installer's
// own file operations run (GitHub #250, ADR-441). Plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const NSH_PATH = join(__dirname, 'build', 'installer.nsh')
const STUB_NSI_PATH = join(__dirname, 'test-fixtures', 'installer-stub.nsi')
const TEMPLATE_INCLUDE_DIR = join(__dirname, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include')
const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'NSIS compiles only on Windows in this repo' }

const source = readFileSync(NSH_PATH, 'utf8')
const code = stripComments(source)

test('TURBOLLM_SETTLE_POLLS is a defined, positive poll count', () => {
  const match = /^!define\s+TURBOLLM_SETTLE_POLLS\s+(\d+)\s*$/m.exec(code)
  assert.ok(match, 'installer.nsh must !define TURBOLLM_SETTLE_POLLS to a bounded integer')
  assert.ok(Number(match[1]) > 0, 'TURBOLLM_SETTLE_POLLS must be positive, or settling never re-checks')
})

test('TURBOLLM_SETTLE re-probes with TURBOLLM_IS_RUNNING instead of a second probe implementation', () => {
  const body = macroBody(code, 'TURBOLLM_SETTLE')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_SETTLE _OUT macro')
  assert.match(body, /!insertmacro TURBOLLM_IS_RUNNING \$\{_OUT\}/, 'settle must reuse the existing probe, not duplicate its logic')
  assert.match(body, /\$\{For\}/, 'settle must use a bounded For loop')
  assertNoUnboundedControlFlow(body, 'TURBOLLM_SETTLE')
})

test('TURBOLLM_CLOSE_ALL settles before trusting a close, and never loops unboundedly if settling finds something', () => {
  const body = macroBody(code, 'TURBOLLM_CLOSE_ALL')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_CLOSE_ALL _OUT macro')
  assert.match(body, /!insertmacro TURBOLLM_SETTLE \$\{_OUT\}/, 'CLOSE_ALL must call the settle step before returning')

  const settleGuardOnward = body.slice(body.indexOf('TURBOLLM_SETTLE'))
  assert.match(
    settleGuardOnward,
    /!insertmacro TURBOLLM_FORCE_CLOSE[\s\S]*!insertmacro TURBOLLM_IS_RUNNING \$\{_OUT\}/,
    'a settle probe that finds something must trigger exactly one more bounded force-close, not a fresh unbounded retry loop'
  )
  assertNoUnboundedControlFlow(body, 'TURBOLLM_CLOSE_ALL')
})

test('the settle step only runs once the close already looks successful', () => {
  const body = macroBody(code, 'TURBOLLM_CLOSE_ALL')
  const settleIndex = body.indexOf('TURBOLLM_SETTLE')
  const guardBefore = body.slice(0, settleIndex)
  const lastCondition = [...guardBefore.matchAll(/\$\{If\}\s+\$\{_OUT\}\s+==\s+0/g)].pop()
  assert.ok(lastCondition, 'TURBOLLM_SETTLE must be reached only inside a ${_OUT} == 0 branch (settle guards success, not failure)')
})

test('TURBOLLM_AUTO_RETRY_ATTEMPTS and TURBOLLM_AUTO_RETRY_BACKOFF_MS are defined, positive integers', () => {
  for (const name of ['TURBOLLM_AUTO_RETRY_ATTEMPTS', 'TURBOLLM_AUTO_RETRY_BACKOFF_MS']) {
    const match = new RegExp(`^!define\\s+${name}\\s+(\\d+)\\s*$`, 'm').exec(code)
    assert.ok(match, `installer.nsh must !define ${name} to a bounded integer`)
    assert.ok(Number(match[1]) > 0, `${name} must be positive`)
  }
})

test('TURBOLLM_CLOSE_ALL_WITH_RETRIES retries the whole close-and-settle cycle with a real backoff, bounded', () => {
  const body = macroBody(code, 'TURBOLLM_CLOSE_ALL_WITH_RETRIES')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_CLOSE_ALL_WITH_RETRIES _OUT macro')
  assert.match(body, /\$\{For\}\s+\$R\d\s+1\s+\$\{TURBOLLM_AUTO_RETRY_ATTEMPTS\}/, 'the retry count must be bounded by TURBOLLM_AUTO_RETRY_ATTEMPTS')
  assert.match(body, /!insertmacro TURBOLLM_CLOSE_ALL \$\{_OUT\}/, 'it must reuse TURBOLLM_CLOSE_ALL, not duplicate the close/settle logic')
  assert.match(body, /Sleep \$\{TURBOLLM_AUTO_RETRY_BACKOFF_MS\}/, 'a failed attempt must back off before the next one, not spin immediately')
  assert.match(body, /\$\{ExitFor\}/, 'a successful attempt must stop retrying instead of burning the whole budget')
  assertNoUnboundedControlFlow(body, 'TURBOLLM_CLOSE_ALL_WITH_RETRIES')
})

test('customCheckAppRunning gives every attempt (automatic and manual Retry) the full retry budget, not one quick shot', () => {
  const body = macroBody(code, 'customCheckAppRunning')
  assert.ok(body, 'installer.nsh must define customCheckAppRunning')
  assert.match(
    body,
    /!insertmacro TURBOLLM_CLOSE_ALL_WITH_RETRIES \$R0/,
    'customCheckAppRunning must call the retrying wrapper so a manual Retry click also gets the full budget, not a single TURBOLLM_CLOSE_ALL attempt'
  )
  assert.doesNotMatch(
    body,
    /!insertmacro TURBOLLM_CLOSE_ALL \$R0/,
    'customCheckAppRunning must not call the bare single-attempt TURBOLLM_CLOSE_ALL directly'
  )
})

test('TURBOLLM_WRITE_DIAGNOSTIC exists, is gated on PowerShell, and never throws out of the install', () => {
  const body = macroBody(code, 'TURBOLLM_WRITE_DIAGNOSTIC')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_WRITE_DIAGNOSTIC macro')
  assert.match(body, /\$\{If\}\s+\$IsPowerShellAvailable\s+==\s+0/, 'the diagnostic dump must be gated on PowerShell being available, like the other path-based checks')
  assert.match(body, /try \{[\s\S]*\} catch \{\}/, 'the PowerShell script must swallow its own errors so a broken diagnostic never blocks the install')
  assertNoUnboundedControlFlow(body, 'TURBOLLM_WRITE_DIAGNOSTIC')
})

test('the diagnostic log reports both probes TURBOLLM_IS_RUNNING actually uses, by name and by install-folder path', () => {
  const body = macroBody(code, 'TURBOLLM_WRITE_DIAGNOSTIC')
  assert.match(body, /Get-Process -Name 'TurboLLM'/, 'must report anything found by the name-based probe')
  assert.match(body, /Get-CimInstance -ClassName Win32_Process/, 'must report anything found by the install-folder path-based probe')
  assert.match(body, /\.ProcessId -ne \$turbollmSelfPid/, "must exclude the installer's own PID, matching TURBOLLM_IS_RUNNING's own filter")
})

test('customCheckAppRunning writes the diagnostic before showing the dialog, not after', () => {
  const body = macroBody(code, 'customCheckAppRunning')
  const messageBoxIndex = body.indexOf('MessageBox')
  const diagnosticIndex = body.indexOf('TURBOLLM_WRITE_DIAGNOSTIC')
  assert.ok(diagnosticIndex >= 0, 'customCheckAppRunning must call TURBOLLM_WRITE_DIAGNOSTIC')
  assert.ok(diagnosticIndex < messageBoxIndex, 'the diagnostic must be written before the Retry/Cancel dialog can be dismissed and the evidence lost')
})

test('compiles clean under makensis -WX (installer mode)', (t) => {
  if (WINDOWS_ONLY.skip) return t.skip(WINDOWS_ONLY.skip)
  runCompileCheck(t, [])
})

test('compiles clean under makensis -WX (uninstaller mode)', (t) => {
  if (WINDOWS_ONLY.skip) return t.skip(WINDOWS_ONLY.skip)
  runCompileCheck(t, ['-DBUILD_UNINSTALLER'])
})

function runCompileCheck (t, extraDefines) {
  const makensis = findMakensis()
  if (!makensis) return t.skip('no cached electron-builder NSIS toolchain found (run `npm run package` once to populate it)')

  const scratchDir = mkdtempSync(join(tmpdir(), 'turbollm-installer-nsh-'))
  try {
    const outFile = join(scratchDir, 'stub-out.exe')
    const result = spawnSync(makensis, [
      '-WX',
      '-INPUTCHARSET', 'UTF8',
      ...extraDefines,
      `-DTPL=${TEMPLATE_INCLUDE_DIR}`,
      `-DNSH=${NSH_PATH}`,
      `-DOUT=${outFile}`,
      STUB_NSI_PATH
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, `makensis -WX failed:\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

function findMakensis () {
  const cacheRoot = join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  if (!existsSync(cacheRoot)) return null

  for (const versionDir of readdirSync(cacheRoot).filter((name) => name.startsWith('nsis-'))) {
    const versionRoot = join(cacheRoot, versionDir)
    for (const hashDir of readdirSync(versionRoot)) {
      const candidate = join(versionRoot, hashDir, 'Bin', 'makensis.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*[;#]/.test(line))
    .join('\n')
}

function macroBody (text, name) {
  const match = new RegExp(`^[ \\t]*!macro[ \\t]+${name}\\b[^\\n]*\\n([\\s\\S]*?)^[ \\t]*!macroend\\b`, 'm').exec(text)
  return match ? match[1] : null
}

function assertNoUnboundedControlFlow (body, macroName) {
  assert.doesNotMatch(body, /\bGoto\b/, `${macroName} must not introduce a raw Goto`)
  assert.doesNotMatch(body, /^\s*[A-Za-z_][\w.]*:\s*$/m, `${macroName} must not introduce a raw label`)
  assert.doesNotMatch(body, /\$\{Do\}/, `${macroName} must not introduce an unbounded Do/Loop`)
}
