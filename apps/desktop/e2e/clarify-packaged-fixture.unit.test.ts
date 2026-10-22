import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { NativeProcess } from '../../../tests-js/scripts/desktop-smoke-process'

import {
  contractProblems,
  copyBackendLogs,
  countByImage,
  foreignHermesProcesses,
  isInside,
  type LaunchContract,
  normalizePath,
  parseLaunchContract,
  processesInside,
  readCandidatePackage,
  redact,
  samePath,
  sha256File
} from './clarify-packaged-fixture'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const PACKAGE_ROOT = 'C:\\hsa\\HermesClarifyCandidate-abcdef0'
const EXE = `${PACKAGE_ROOT}\\app\\hermes-abcdef0.exe`
const ROOT = 'C:\\Users\\runneradmin\\AppData\\Local\\HermesClarifyCandidate'

function contract(): LaunchContract {
  const layout = {
    hermesHome: `${ROOT}\\user-data\\hermes-home`,
    local: `${ROOT}\\profile\\AppData\\Local`,
    profile: `${ROOT}\\profile`,
    roaming: `${ROOT}\\profile\\AppData\\Roaming`,
    root: ROOT,
    temp: `${ROOT}\\tmp`,
    userData: `${ROOT}\\user-data`
  }

  return {
    arguments: [`--user-data-dir=${layout.userData}`],
    commit: COMMIT,
    environment: {
      APPDATA: layout.roaming,
      HERMES_DATA_DIR_SUFFIX: '-clarify-candidate',
      HERMES_DESKTOP_APP_NAME: 'HermesClarifyCandidate-abcdef0',
      HERMES_DESKTOP_IGNORE_EXISTING: '1',
      HERMES_DESKTOP_ISOLATED_BACKEND: '1',
      HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1',
      HERMES_DESKTOP_USER_DATA_DIR: layout.userData,
      HERMES_HOME: layout.hermesHome,
      HOME: layout.profile,
      LOCALAPPDATA: layout.local,
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: layout.temp,
      TMP: layout.temp,
      USERPROFILE: layout.profile
    },
    exe: EXE,
    layout,
    packageRoot: PACKAGE_ROOT,
    refusedLocations: [
      'C:\\Users\\runneradmin\\AppData\\Local\\hermes',
      'C:\\Users\\runneradmin\\.hermes',
      'C:\\Users\\runneradmin\\AppData\\Roaming\\Hermes'
    ],
    schema: 1,
    workingDirectory: layout.temp
  }
}

const expectation = { commit: COMMIT, exe: EXE, packageRoot: PACKAGE_ROOT, platform: 'win32' as const }

const problemsFor = (change: (value: LaunchContract) => void, decoys: string[] = []): string[] => {
  const value = contract()

  change(value)

  return contractProblems(value, { ...expectation, decoys })
}

describe('paths compare the way Windows compares them', () => {
  test('case, separators and a trailing separator do not matter', () => {
    expect(samePath('C:\\Hsa\\Pkg\\', 'c:/hsa/pkg', 'win32')).toBe(true)
    expect(normalizePath('C:/a/../b/c', 'win32')).toBe('c:\\b\\c')
    expect(samePath('/a/B', '/a/b', 'linux')).toBe(false)
  })

  test('inside means the folder itself or below it, never a sibling that shares a prefix', () => {
    expect(isInside('C:\\hsa', 'C:\\HSA\\pkg\\app.exe', 'win32')).toBe(true)
    expect(isInside('C:\\hsa', 'C:\\hsa', 'win32')).toBe(true)
    expect(isInside('C:\\hsa', 'C:\\hsa-other\\x', 'win32')).toBe(false)
    expect(isInside('C:\\hsa\\pkg', 'C:\\hsa', 'win32')).toBe(false)
    expect(isInside('C:\\', 'C:\\anything', 'win32')).toBe(true)
  })
})

describe('the launch contract', () => {
  test('is the last line the launcher prints, and only a complete one', () => {
    const line = JSON.stringify(contract())

    expect(parseLaunchContract(`warning text\r\n${line}\r\n`).commit).toBe(COMMIT)
    expect(() => parseLaunchContract('')).toThrow('printed no launch contract')
    expect(() => parseLaunchContract('not json')).toThrow('not JSON')
    expect(() => parseLaunchContract(JSON.stringify({ ...contract(), schema: 2 }))).toThrow('wrong shape')
    expect(() => parseLaunchContract(JSON.stringify({ ...contract(), commit: 'abc' }))).toThrow('wrong shape')
  })

  test('a start that is isolated, of this executable, has no problems', () => {
    expect(contractProblems(contract(), expectation)).toEqual([])
  })

  test.each([
    ['another executable', (value: LaunchContract) => (value.exe = 'C:\\elsewhere\\hermes-abcdef0.exe'), 'would start'],
    ['another commit', (value: LaunchContract) => (value.commit = '1'.repeat(40)), 'names commit'],
    [
      'a user data directory outside the sandbox',
      (value: LaunchContract) => (value.layout.userData = 'C:\\Users\\x'),
      'layout.userData'
    ],
    [
      'a Hermes home that is not derived from user data',
      (value: LaunchContract) => (value.layout.hermesHome = `${ROOT}\\other`),
      'hermes-home'
    ],
    [
      'HERMES_HOME elsewhere',
      (value: LaunchContract) => (value.environment.HERMES_HOME = 'C:\\Users\\x\\.hermes'),
      'HERMES_HOME='
    ],
    ['no user-data switch', (value: LaunchContract) => (value.arguments = []), '--user-data-dir='],
    [
      'a missing isolation flag',
      (value: LaunchContract) => delete value.environment.HERMES_DESKTOP_ISOLATED_BACKEND,
      'ISOLATED_BACKEND'
    ],
    [
      'protocol registration left on',
      (value: LaunchContract) => (value.environment.HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION = '0'),
      'SKIP_PROTOCOL_REGISTRATION'
    ],
    [
      'another data directory suffix',
      (value: LaunchContract) => (value.environment.HERMES_DATA_DIR_SUFFIX = '-x'),
      'HERMES_DATA_DIR_SUFFIX'
    ],
    [
      'the real profile as APPDATA',
      (value: LaunchContract) => (value.environment.APPDATA = 'C:\\Users\\runneradmin\\AppData\\Roaming'),
      'APPDATA='
    ],
    ['a leaked Python path', (value: LaunchContract) => (value.environment.PYTHONPATH = 'D:\\repo'), 'PYTHONPATH'],
    [
      'a leaked credential',
      (value: LaunchContract) => (value.environment.OPENAI_API_KEY = 'sk-x'),
      'credential-shaped'
    ],
    [
      'an inherited Hermes variable',
      (value: LaunchContract) => (value.environment.HERMES_DESKTOP_HERMES_ROOT = 'D:\\repo'),
      'must not pass on'
    ],
    ['no PATH', (value: LaunchContract) => delete value.environment.PATH, 'PATH is missing'],
    [
      'a sandbox that contains a real home',
      (value: LaunchContract) => value.refusedLocations.push(`${ROOT}\\user-data`),
      'overlaps the real location'
    ],
    [
      'a real location in the environment',
      (value: LaunchContract) => (value.environment.SOMETHING = value.refusedLocations[0]),
      'is in the candidate'
    ]
  ])('refuses %s', (_name, change, needle) => {
    const problems = problemsFor(change)

    expect(
      problems.some(problem => problem.includes(needle)),
      problems.join('\n')
    ).toBe(true)
  })

  test('a decoy the harness exported is named as such when it reaches the candidate', () => {
    const problems = problemsFor(value => (value.environment.PYTHONPATH = 'D:\\repo'), ['pythonpath'])

    expect(problems).toEqual(['PYTHONPATH was exported by the harness as a decoy and reached the candidate'])
  })
})

describe('processes', () => {
  const proc = (pid: number, executable: string, command = ''): NativeProcess => ({
    command,
    executable,
    parentPid: 1,
    pid
  })

  const everything = [
    proc(1, `${PACKAGE_ROOT}\\app\\hermes-abcdef0.exe`),
    proc(
      2,
      `${PACKAGE_ROOT}\\app\\resources\\agent-payload\\tools\\python\\python.exe`,
      'python -m hermes_cli.main gateway run'
    ),
    proc(3, 'C:\\hostedtoolcache\\python\\python.exe', 'python scripts\\x.py'),
    proc(4, 'D:\\a\\repo\\venv\\Scripts\\python.exe', 'python -m hermes_cli.main gateway run'),
    proc(5, 'C:\\Windows\\System32\\svchost.exe'),
    proc(6, '')
  ]

  test('those running from the package, and Hermes processes running from anywhere else', () => {
    expect(processesInside(everything, PACKAGE_ROOT, 'win32').map(entry => entry.pid)).toEqual([1, 2])
    expect(foreignHermesProcesses(everything, PACKAGE_ROOT, 'win32').map(entry => entry.pid)).toEqual([4])
    expect(countByImage(everything.slice(0, 3))).toEqual({ 'hermes-abcdef0.exe': 1, 'python.exe': 2 })
  })
})

describe('evidence hygiene', () => {
  test('redact removes tokens and credential-shaped values from log text', () => {
    const redacted = redact('ws://127.0.0.1:1/ws?token=abc123&x=1 Authorization: Bearer s3cret api_key=zzz ok')

    for (const secret of ['abc123', 's3cret', 'zzz']) {
      expect(redacted).not.toContain(secret)
    }

    expect(redacted).toContain('[redacted]')
    expect(redacted.endsWith(' ok')).toBe(true)
  })

  const made: string[] = []

  const temp = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-fixture-'))

    made.push(directory)

    return directory
  }

  afterEach(() => {
    for (const directory of made.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  test('the candidate package is read from its manifest, and refused without one', () => {
    const root = temp()

    expect(() => readCandidatePackage(root)).toThrow('must be an extracted candidate package')
    fs.writeFileSync(
      path.join(root, 'MANIFEST.json'),
      `\uFEFF${JSON.stringify({ app: { exe: 'app/hermes-abcdef0.exe', exe_sha256: 'a'.repeat(64) }, package: 'P', source: { commit: COMMIT } })}`
    )
    const found = readCandidatePackage(root)

    expect(found.exe).toBe(path.join(root, 'app', 'hermes-abcdef0.exe'))
    expect(found.payloadRoot).toBe(path.join(root, 'app', 'resources', 'agent-payload'))
    expect(found.manifest.source.commit).toBe(COMMIT)
  })

  test('sha256File digests a whole file, whatever its size', () => {
    const file = path.join(temp(), 'f.bin')
    const content = Buffer.alloc(3 * (1 << 20) + 5, 7)

    fs.writeFileSync(file, content)

    expect(sha256File(file)).toBe(crypto.createHash('sha256').update(content).digest('hex'))
  })

  test('backend logs are copied redacted and capped, and a missing log folder is not an error', () => {
    const home = temp()
    const destination = path.join(temp(), 'out')

    expect(copyBackendLogs(home, destination)).toEqual([])
    fs.mkdirSync(path.join(home, 'logs'))
    fs.writeFileSync(path.join(home, 'logs', 'gateway.log'), `${'x'.repeat(50)}\nGET /ws?ticket=SECRET\n`)
    fs.writeFileSync(path.join(home, 'logs', 'state.db'), 'binary')

    expect(copyBackendLogs(home, destination, 30)).toEqual(['gateway.log'])
    const copied = fs.readFileSync(path.join(destination, 'gateway.log'), 'utf8')

    expect(copied).toContain('ticket=[redacted]')
    expect(copied).not.toContain('SECRET')
    expect(copied.length).toBeLessThanOrEqual(40)
  })
})
