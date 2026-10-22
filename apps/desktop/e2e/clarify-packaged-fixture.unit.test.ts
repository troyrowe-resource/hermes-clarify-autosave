import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { NativeProcess } from '../../../tests-js/scripts/desktop-smoke-process'

import {
  candidateIdentity,
  contractProblems,
  copyBackendLogs,
  countByImage,
  foreignHermesProcesses,
  type HostRecord,
  isInside,
  type LaunchContract,
  listEntries,
  lockDirectories,
  normalizePath,
  parseLaunchContract,
  processesInside,
  readCandidatePackage,
  readHostRecords,
  readPackagedConfig,
  redact,
  rendezvousProblems,
  samePath,
  sha256File,
  unexpectedEntries
} from './clarify-packaged-fixture'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const PACKAGE_ROOT = 'C:\\hsa\\HermesClarifyCandidate-abcdef0'
const EXE = `${PACKAGE_ROOT}\\app\\hermes-abcdef0.exe`
const ROOT = 'C:\\Users\\runneradmin\\AppData\\Local\\HermesClarifyCandidate'

function contract(): LaunchContract {
  const layout = {
    gatewayLocks: `${ROOT}\\gateway-locks`,
    hermesHome: `${ROOT}\\user-data\\hermes-home`,
    local: `${ROOT}\\profile\\AppData\\Local`,
    profile: `${ROOT}\\profile`,
    roaming: `${ROOT}\\profile\\AppData\\Roaming`,
    root: ROOT,
    temp: `${ROOT}\\tmp`,
    userData: `${ROOT}\\user-data`,
    workspace: `${ROOT}\\workspace`
  }

  return {
    arguments: [`--user-data-dir=${layout.userData}`],
    commit: COMMIT,
    environment: {
      APPDATA: layout.roaming,
      HERMES_DATA_DIR_SUFFIX: '-clarify-candidate',
      HERMES_DESKTOP_APP_NAME: 'HermesClarifyCandidate-abcdef0',
      HERMES_DESKTOP_CWD: layout.workspace,
      HERMES_DESKTOP_IGNORE_EXISTING: '1',
      HERMES_DESKTOP_ISOLATED_BACKEND: '1',
      HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1',
      HERMES_DESKTOP_USER_DATA_DIR: layout.userData,
      HERMES_GATEWAY_LOCK_DIR: layout.gatewayLocks,
      HERMES_HOME: layout.hermesHome,
      HOME: layout.profile,
      LOCALAPPDATA: layout.local,
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: layout.temp,
      TMP: layout.temp,
      TMPDIR: layout.temp,
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
    [
      'the real per-user rendezvous directory',
      (value: LaunchContract) =>
        (value.environment.HERMES_GATEWAY_LOCK_DIR = 'C:\\Users\\runneradmin\\.local\\state\\hermes\\gateway-locks'),
      'HERMES_GATEWAY_LOCK_DIR='
    ],
    [
      'no rendezvous override',
      (value: LaunchContract) => delete value.environment.HERMES_GATEWAY_LOCK_DIR,
      'HERMES_GATEWAY_LOCK_DIR=(unset)'
    ],
    [
      'a rendezvous directory outside the sandbox',
      (value: LaunchContract) => (value.layout.gatewayLocks = 'C:\\locks'),
      'layout.gatewayLocks'
    ],
    [
      "the user's real home as the assistant's working directory",
      (value: LaunchContract) => (value.environment.HERMES_DESKTOP_CWD = 'C:\\Users\\runneradmin'),
      'HERMES_DESKTOP_CWD='
    ],
    [
      'no working directory for the assistant',
      (value: LaunchContract) => delete value.environment.HERMES_DESKTOP_CWD,
      'HERMES_DESKTOP_CWD=(unset)'
    ],
    [
      'a workspace outside the sandbox',
      (value: LaunchContract) => (value.layout.workspace = 'C:\\work'),
      'layout.workspace'
    ],
    [
      'an XDG state directory',
      (value: LaunchContract) => (value.environment.XDG_STATE_HOME = 'C:\\state'),
      'XDG_STATE_HOME'
    ],
    ['a Codex home', (value: LaunchContract) => (value.environment.CODEX_HOME = 'C:\\codex'), 'CODEX_HOME'],
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
    [
      'a TMPDIR outside the sandbox, which Python prefers to TEMP',
      (value: LaunchContract) => (value.environment.TMPDIR = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'),
      'TMPDIR='
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

describe('the harness configuration and a direct start', () => {
  test('is read from the environment, and a missing package is only a skip when it is not required', () => {
    expect(readPackagedConfig({})).toEqual({
      candidateDir: undefined,
      decoyHome: undefined,
      decoys: [],
      expectedCommit: undefined,
      requirePackaged: false,
      sandboxRoot: undefined
    })

    expect(
      readPackagedConfig({
        HERMES_E2E_CANDIDATE_DIR: 'C:\\hsa\\pkg',
        HERMES_E2E_DECOY_HOME: 'C:\\decoy',
        HERMES_E2E_DECOY_VARIABLES: ' A, B ,,C',
        HERMES_E2E_EXPECT_COMMIT: COMMIT,
        HERMES_E2E_REQUIRE_PACKAGED: '1'
      })
    ).toMatchObject({
      candidateDir: 'C:\\hsa\\pkg',
      decoyHome: 'C:\\decoy',
      decoys: ['A', 'B', 'C'],
      expectedCommit: COMMIT,
      requirePackaged: true
    })
  })

  test('the identity owns its own names in the real profile, never the installed app’s', () => {
    const identity = candidateIdentity(COMMIT)

    expect(identity.displayName).toBe('Hermes Agent abcdef0')
    expect(identity.userDataName).toBe('HermesBundledCommitabcdef0-clarify-candidate')
    expect(identity.homeName).toBe('hermes-clarify-candidate')

    for (const installed of ['Hermes', 'hermes', 'hermes-desktop', 'hermes-updater', '.hermes']) {
      expect([...identity.appDataNames, ...identity.localAppDataNames]).not.toContain(installed)
    }
  })

  test('only Hermes-named entries outside the allowed names are unexpected, and case does not matter on Windows', () => {
    const identity = candidateIdentity(COMMIT)
    const pattern = /^hermes/i

    expect(
      unexpectedEntries(
        ['Microsoft', 'HermesBundledCommitabcdef0', 'HERMESBUNDLEDCOMMITABCDEF0-CLARIFY-CANDIDATE'],
        pattern,
        identity.appDataNames,
        'win32'
      )
    ).toEqual([])
    expect(unexpectedEntries(['Hermes', 'hermes-desktop', 'Other'], pattern, identity.appDataNames, 'win32')).toEqual([
      'Hermes',
      'hermes-desktop'
    ])
    expect(unexpectedEntries(['HermesClarifyCandidate'], pattern, identity.appDataNames, 'linux')).toEqual([
      'HermesClarifyCandidate'
    ])
    expect(unexpectedEntries(['.hermes'], /^\.hermes/i, [], 'win32')).toEqual(['.hermes'])
  })
})

describe("the started gateway's rendezvous", () => {
  const layout = contract().layout
  const made: string[] = []

  const sandbox = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-rendezvous-'))

    made.push(directory)

    return directory
  }

  afterEach(() => {
    for (const directory of made.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  const record = (changes: Partial<HostRecord> = {}): HostRecord => ({
    dir: layout.gatewayLocks,
    file: 'host-gateway.json',
    home: layout.hermesHome,
    pid: 4242,
    port: 61000,
    role: 'gateway',
    ...changes
  })

  test('lives either under the explicit override or under the sandboxed profile', () => {
    expect(lockDirectories(layout, 'win32')).toEqual([
      layout.gatewayLocks,
      `${layout.profile}\\.local\\state\\hermes\\gateway-locks`
    ])
  })

  test('is proven by a record that names this process, inside the sandbox, for the sandbox home', () => {
    expect(rendezvousProblems([record()], layout, 4242, 'win32')).toEqual([])
    expect(
      rendezvousProblems(
        [record({ dir: `${layout.profile}\\.local\\state\\hermes\\gateway-locks` })],
        layout,
        4242,
        'win32'
      )
    ).toEqual([])
  })

  test.each([
    ['no record', [] as HostRecord[], 'names the backend process 4242'],
    ['a record for another process', [record({ pid: 1 })], 'names the backend process 4242'],
    [
      'a record outside the sandbox',
      [record({ dir: 'C:\\Users\\runneradmin\\.local\\state\\hermes\\gateway-locks' })],
      'outside the sandbox'
    ],
    [
      'a record for another home',
      [record({ home: 'C:\\Users\\runneradmin\\AppData\\Local\\hermes' })],
      'not C:\\Users'
    ],
    ['a record without a home', [record({ home: null })], 'names the home null']
  ])('is not proven by %s', (_name, records, needle) => {
    const problems = rendezvousProblems(records, layout, 4242, 'win32')

    expect(
      problems.some(problem => problem.includes(needle)),
      problems.join('\n')
    ).toBe(true)
  })

  test('records are read from the host-*.json files a gateway wrote, ignoring everything else', () => {
    const directory = sandbox()

    fs.writeFileSync(
      path.join(directory, 'host-gateway.json'),
      JSON.stringify({ home: 'H', pid: 7, port: 8, role: 'gateway' })
    )
    fs.writeFileSync(path.join(directory, 'host-serve.json'), `\uFEFF${JSON.stringify({ pid: '7', role: 3 })}`)
    fs.writeFileSync(path.join(directory, 'host-bad.json'), '{not json')
    fs.writeFileSync(path.join(directory, 'host-gateway.lock'), '')
    fs.writeFileSync(path.join(directory, 'other.json'), '{}')

    const found = readHostRecords([directory, path.join(directory, 'absent')]).sort((a, b) =>
      a.file.localeCompare(b.file)
    )

    expect(found).toEqual([
      { dir: directory, file: 'host-gateway.json', home: 'H', pid: 7, port: 8, role: 'gateway' },
      { dir: directory, file: 'host-serve.json', home: null, pid: null, port: null, role: null }
    ])
    expect(listEntries(path.join(directory, 'absent'))).toEqual([])
    expect(listEntries(undefined)).toEqual([])
  })
})
