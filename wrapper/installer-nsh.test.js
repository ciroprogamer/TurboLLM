// installer-nsh.test.js — wrapper/build/installer.nsh closes a running TurboLLM before the installer's
// own file operations run (GitHub #250, ADR-441). Plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

const NSH_PATH = join(__dirname, 'build', 'installer.nsh')
const STUB_NSI_PATH = join(__dirname, 'test-fixtures', 'installer-stub.nsi')
const CLEAR_LONG_PATHS_STUB_PATH = join(__dirname, 'test-fixtures', 'clear-long-paths-stub.nsi')
const MAX_PATH = 260
// The deepest file the desktop package actually ships (a nested copy pi-coding-agent needs, on zod 3).
const DEEPEST_PACKAGED_RELATIVE_PATH = [
  'resources', 'daemon', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@mistralai',
  'mistralai', 'esm', 'models', 'operations',
  'getchatcompletionfieldoptionscountsv1observabilitychatcompletionfieldsfieldnameoptionscountspost.js'
]
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

test('TURBOLLM_WRITE_DIAGNOSTIC dumps the full task list unconditionally, not gated on PowerShell', () => {
  const body = macroBody(code, 'TURBOLLM_WRITE_DIAGNOSTIC')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_WRITE_DIAGNOSTIC macro')

  const beforeFirstGate = body.slice(0, body.search(/\$\{If\}/))
  assert.match(
    beforeFirstGate,
    /"\$CmdPath" \/C tasklist \/V/,
    'a plain cmd.exe tasklist dump must run unconditionally, before any ${If} gate - a diagnostic gated on the same ' +
    'PowerShell-availability check the real probe depends on could go silent for exactly the failures most worth seeing'
  )
  assertNoUnboundedControlFlow(body, 'TURBOLLM_WRITE_DIAGNOSTIC')
})

test('TURBOLLM_WRITE_DIAGNOSTIC also reports the install-folder path probe when PowerShell is available, and never throws out of the install', () => {
  const body = macroBody(code, 'TURBOLLM_WRITE_DIAGNOSTIC')
  assert.match(body, /\$\{If\}\s+\$IsPowerShellAvailable\s+==\s+0/, 'the path-based enrichment must be gated on PowerShell being available, like TURBOLLM_IS_RUNNING itself')
  assert.match(body, /try \{[\s\S]*\} catch \{\}/, 'the PowerShell script must swallow its own errors so a broken diagnostic never blocks the install')
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

test('TURBOLLM_CLEAR_LONG_PATHS deletes the daemon tree through a \\\\?\\ path, so files over MAX_PATH go too', () => {
  const body = macroBody(code, 'TURBOLLM_CLEAR_LONG_PATHS')
  assert.ok(body, 'installer.nsh must define a TURBOLLM_CLEAR_LONG_PATHS macro')
  assert.match(
    body,
    /"\$CmdPath" \/C rd \/s \/q "\\\\\?\\\$INSTDIR\\resources\\daemon"/,
    'rd needs the \\\\?\\ prefix: without it, it stops at the first path over MAX_PATH, which is the whole problem'
  )
  assertNoUnboundedControlFlow(body, 'TURBOLLM_CLEAR_LONG_PATHS')
})

test('TURBOLLM_CLEAR_LONG_PATHS only deletes a folder that is provably a TurboLLM install', () => {
  const body = macroBody(code, 'TURBOLLM_CLEAR_LONG_PATHS')
  const beforeDelete = body.slice(0, body.indexOf(' rd /s /q'))
  assert.match(
    beforeDelete,
    /\$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/,
    'the delete must be guarded by TurboLLM.exe being present, so a mistyped or shared install folder is never touched'
  )
  assert.match(beforeDelete, /\$\{FileExists\} "\$INSTDIR\\resources\\daemon\\\*\.\*"/, 'nothing to delete on a fresh install')
})

test('customCheckAppRunning clears long paths in the installer only, after closing TurboLLM, before the stock cleanup runs', () => {
  const body = macroBody(code, 'customCheckAppRunning')
  const clearIndex = body.indexOf('TURBOLLM_CLEAR_LONG_PATHS')
  assert.ok(clearIndex >= 0, 'customCheckAppRunning must call TURBOLLM_CLEAR_LONG_PATHS')
  assert.ok(clearIndex > body.indexOf('TURBOLLM_CLOSE_ALL_WITH_RETRIES'), 'processes must be closed first, or their files are still open')
  assert.ok(clearIndex < body.lastIndexOf('TURBOLLM_CLEAR_INSTDIR'), 'must run inside the hook, before control returns to the stock install section')
  const guardIndex = body.lastIndexOf('!ifndef BUILD_UNINSTALLER', clearIndex)
  assert.ok(guardIndex >= 0, 'must sit inside !ifndef BUILD_UNINSTALLER')
  assert.doesNotMatch(
    body.slice(guardIndex, clearIndex),
    /!endif/,
    'installer compile only: the uninstaller never runs the stock old-version cleanup this is clearing the way for'
  )
})

// With LongPathsEnabled=1 (common on dev boxes) rd copes even without \\?\, so the prefix is pinned by the static test above.
test('running TURBOLLM_CLEAR_LONG_PATHS deletes a daemon tree holding a file over MAX_PATH, and nothing else', (t) => {
  if (WINDOWS_ONLY.skip) return t.skip(WINDOWS_ONLY.skip)
  const makensis = findMakensis()
  if (!makensis) return t.skip('no cached electron-builder NSIS toolchain found (run `npm run package` once to populate it)')

  const scratchDir = mkdtempSync(join(tmpdir(), 'turbollm-clear-long-paths-'))
  try {
    const installDir = join(scratchDir, 'install')
    const overLimitFile = join(installDir, ...DEEPEST_PACKAGED_RELATIVE_PATH)
    writeFiles([join(installDir, 'TurboLLM.exe'), join(installDir, 'resources', 'app.asar'), overLimitFile])
    assert.ok(overLimitFile.length > MAX_PATH, `fixture must exceed MAX_PATH to prove anything (${overLimitFile.length} chars)`)

    const stub = compileStub(makensis, CLEAR_LONG_PATHS_STUB_PATH, join(scratchDir, 'stub.exe'))
    runStubAgainst(stub, installDir)

    assert.equal(existsSync(join(installDir, 'resources', 'daemon')), false, 'the daemon tree must be gone, over-MAX_PATH file included')
    assert.ok(existsSync(join(installDir, 'TurboLLM.exe')), 'files outside resources\\daemon must be left for the old uninstaller')
    assert.ok(existsSync(join(installDir, 'resources', 'app.asar')), 'siblings of resources\\daemon must be left alone')
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
})

test('running TURBOLLM_CLEAR_LONG_PATHS leaves a folder alone when it holds no TurboLLM.exe', (t) => {
  if (WINDOWS_ONLY.skip) return t.skip(WINDOWS_ONLY.skip)
  const makensis = findMakensis()
  if (!makensis) return t.skip('no cached electron-builder NSIS toolchain found (run `npm run package` once to populate it)')

  const scratchDir = mkdtempSync(join(tmpdir(), 'turbollm-clear-long-paths-'))
  try {
    const unrelatedDir = join(scratchDir, 'not-turbollm')
    const unrelatedFile = join(unrelatedDir, 'resources', 'daemon', 'keep.txt')
    writeFiles([unrelatedFile])

    const stub = compileStub(makensis, CLEAR_LONG_PATHS_STUB_PATH, join(scratchDir, 'stub.exe'))
    runStubAgainst(stub, unrelatedDir)

    assert.ok(existsSync(unrelatedFile), 'a mistyped or shared install folder must never be deleted from')
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
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

function compileStub (makensis, stubPath, outFile) {
  const result = spawnSync(makensis, [
    '-WX',
    '-INPUTCHARSET', 'UTF8',
    `-DTPL=${TEMPLATE_INCLUDE_DIR}`,
    `-DNSH=${NSH_PATH}`,
    `-DOUT=${outFile}`,
    stubPath
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, `makensis -WX failed:\n${result.stdout}\n${result.stderr}`)
  return outFile
}

// NSIS reads /D= raw to the end of the command line, so it must not be quoted.
function runStubAgainst (stub, installDir) {
  const result = spawnSync(stub, [`/D=${installDir}`], { windowsVerbatimArguments: true, timeout: 60_000 })
  assert.equal(result.status, 0, `the stub installer exited ${result.status}`)
}

function writeFiles (paths) {
  for (const filePath of paths) {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'x')
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
