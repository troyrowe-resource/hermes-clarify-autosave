/**
 * Direct-start smoke: the packaged candidate started WITHOUT its launcher and WITHOUT any isolation switch, which is
 * what a double-click on the executable does, with the machine's own environment.
 *
 * The launcher is the supported way to start the candidate, but nothing stops a person from running the .exe. This
 * proves that even then the build keeps to its own identity and leaves every real Hermes location alone:
 *
 *  - Electron's default user data folder derives from the app's name, so the app is named for the candidate (never
 *    "Hermes"), and its user data and Hermes home are the candidate's own suffixed folders in the real profile. A
 *    Hermes home exported in the environment (a decoy here, standing for a real home) is cleared by the baked
 *    bundle environment and never touched.
 *  - A commit build never registers the `hermes://` handler: desktop.log says so, and the workflow's registry
 *    sentinel proves the installed handler key was never created or changed.
 *  - Quitting and running the shipped Stop script leaves no process from the package, and nothing Hermes-named in the
 *    real profile except the candidate's own names: no `Hermes`, `hermes-desktop`, `hermes`, `hermes-updater`,
 *    `.hermes` (the workflow's sentinels compare before and after for those, the registry key and the per-user
 *    gateway rendezvous too). An empty candidate-named `HermesBundledCommit<sha7>` folder is expected and allowed.
 *
 * It reuses the extracted package of `clarify-drafts-packaged.spec.ts` (HERMES_E2E_CANDIDATE_DIR) and, like it, is
 * skipped only when no package is configured; the Windows pipeline sets HERMES_E2E_REQUIRE_PACKAGED=1.
 */

import fs from 'node:fs'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import {
  assertBackendOrigin,
  type BackendProcess,
  localBackendProcess,
  readInstallationCommit,
  readNativeProcesses
} from '../../../tests-js/scripts/desktop-smoke-process'

import { shot, writeObservations } from './clarify-drafts-helpers'
import {
  candidateIdentity,
  type CandidatePackage,
  copyBackendLogs,
  isInside,
  listEntries,
  type MainFacts,
  processesInside,
  readAgentCwd,
  readCandidatePackage,
  readHostRecords,
  readMainFacts,
  readPackagedConfig,
  readVersionInfo,
  redact,
  runShipped,
  samePath,
  sha256File,
  unexpectedEntries,
  type VersionInfo,
  waitForWindowVisible
} from './clarify-packaged-fixture'
import { expect, test } from './test'

const CONFIG = readPackagedConfig()

/** What desktop.log says when a commit build declines to register the OS handler (deep-link-protocol.ts). */
const REGISTRATION_SKIPPED = '[deeplink] hermes:// registration skipped (commit build)'

// The only thing the harness adds to a person's environment: software rendering on a GPU-less runner.
const HARNESS_ARGUMENTS = ['--disable-gpu', '--no-sandbox']

// The shipped Stop script finds what to end by image path inside the package, wherever the sandbox root is.
const STOP_ARGUMENTS = CONFIG.sandboxRoot ? ['-Root', CONFIG.sandboxRoot] : []

test.skip(
  !CONFIG.candidateDir && !CONFIG.requirePackaged,
  'no extracted candidate package (HERMES_E2E_CANDIDATE_DIR) is configured'
)

interface ConnectionBridge {
  getConnection: () => Promise<{ baseUrl?: string; gatewayEndpoint?: { api_origin?: string }; mode?: string }>
}

interface Connection {
  apiOrigin: null | string
  baseUrl: null | string
  mode: null | string
}

type Observations = Record<string, unknown>

/** The real profile's folders: where a direct start puts its own, and where nothing else may appear. */
interface RealProfile {
  appData: string
  localAppData: string
  userProfile: string
}

/** What one direct start needs to know, and what it records. */
interface Run {
  app: ElectronApplication | null
  commit: string
  /** The folders the candidate's identity entitles a direct start to in the real profile. */
  expected: { home: string; userData: string }
  /** The Hermes home the app itself reported. */
  home: null | string
  identity: ReturnType<typeof candidateIdentity>
  logs: string[]
  observations: Observations
  pkg: CandidatePackage
  profile: RealProfile
}

const check = (condition: boolean, message: string): void => expect(condition, message).toBe(true)

const samePathOrNull = (value: null | string, expected: string): boolean => value !== null && samePath(value, expected)

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function realProfile(): RealProfile {
  const { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile } = process.env

  if (!appData || !localAppData || !userProfile) {
    throw new Error('APPDATA, LOCALAPPDATA and USERPROFILE must name the real profile')
  }

  return { appData, localAppData, userProfile }
}

/** A person's environment: the machine's own. The harness's private HERMES_E2E_* settings are not part of it. */
function directEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [name, value] = entry

      return value !== undefined && !name.toUpperCase().startsWith('HERMES_E2E_')
    })
  )
}

/** The point of the test: nothing of the launcher's reaches the candidate, and no opt-out of the OS registration. */
function recordEnvironment(run: Run, env: Record<string, string>): void {
  const names = (prefix: string): string[] =>
    Object.keys(env)
      .filter(name => name.toUpperCase().startsWith(prefix))
      .sort()

  run.observations.environment = {
    decoyHome: CONFIG.decoyHome ?? null,
    hermesHomeExported: env.HERMES_HOME ?? null,
    names: names('HERMES_')
  }
  expect(names('HERMES_DESKTOP_'), 'the harness must not hand the candidate any HERMES_DESKTOP_* switch').toEqual([])
}

/** The renderer mounted and the preload bridge answers; what it shows depends on the first-run state of a fresh home. */
async function waitForRenderer(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as { hermesDesktop?: unknown }).hermesDesktop) &&
      (document.getElementById('root')?.childElementCount ?? 0) > 0,
    undefined,
    { timeout: timeoutMs }
  )
}

/** What the renderer is connected to, or nothing yet (the backend may still be starting). */
function readConnection(page: Page): Promise<Connection> {
  return page.evaluate(async (): Promise<Connection> => {
    const bridge = (window as unknown as { hermesDesktop?: ConnectionBridge }).hermesDesktop

    try {
      const { baseUrl, gatewayEndpoint, mode } = (await bridge?.getConnection()) ?? {}

      return { apiOrigin: gatewayEndpoint?.api_origin ?? null, baseUrl: baseUrl ?? null, mode: mode ?? null }
    } catch {
      return { apiOrigin: null, baseUrl: null, mode: null }
    }
  })
}

/** Ask the app to quit; if a confirmation or a stuck window keeps it open past `graceMs`, end its process. */
async function quit(app: ElectronApplication, graceMs: number): Promise<'closed' | 'killed'> {
  const outcome = await Promise.race([
    app.close().then(
      () => 'closed' as const,
      () => 'closed' as const
    ),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), graceMs))
  ])

  if (outcome === 'closed') {
    return 'closed'
  }

  app.process().kill()

  return 'killed'
}

/** Start the executable the way a double-click does and wait for its window. */
async function launchDirect(run: Run, env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const { logs, pkg } = run
  const app = await _electron.launch({ args: HARNESS_ARGUMENTS, cwd: pkg.appDir, env, executablePath: pkg.exe })

  run.app = app

  const collect = (chunk: Buffer): void => {
    logs.push(...redact(chunk.toString('utf8')).split('\n').filter(Boolean))
    logs.splice(0, Math.max(0, logs.length - 200))
  }

  app.process().stdout?.on('data', collect)
  app.process().stderr?.on('data', collect)

  const page = await app.firstWindow().catch((error: Error) => {
    throw new Error(
      `the packaged app never opened a window: ${error.message.split('\n')[0]}\n${logs.slice(-60).join('\n')}`
    )
  })

  await waitForRenderer(page, 300_000)
  await waitForWindowVisible(app, page, 60_000)
  await shot(page, 'packaged-direct-01-first-window.png')

  return { app, page }
}

interface IdentityFacts {
  bakedHermesHomeClearActive: boolean
  commit: null | string
  execPathIsPackagedExe: boolean
  exeSha256: string
  exeSha256Matches: boolean
  expectedHome: string
  expectedUserData: string
  hermesHome: null | string
  hermesHomeIsCandidateOwn: boolean
  isPackaged: boolean
  name: string
  nameIsCandidate: boolean
  userData: string
  userDataIsCandidateOwn: boolean
  userDataSwitchPassed: boolean
}

/** The facts a direct start's identity is judged by: whose executable, name and folders it is running with. */
function identityFacts(run: Run, main: MainFacts, info: VersionInfo): IdentityFacts {
  const { expected, identity, pkg } = run
  const exeSha256 = sha256File(pkg.exe)

  return {
    bakedHermesHomeClearActive: main.env.HERMES_HOME === '',
    commit: info.commit ?? null,
    execPathIsPackagedExe: samePath(main.execPath, pkg.exe),
    exeSha256,
    exeSha256Matches: exeSha256 === pkg.exeSha256,
    expectedHome: expected.home,
    expectedUserData: expected.userData,
    hermesHome: info.hermesHome ?? null,
    hermesHomeIsCandidateOwn: samePathOrNull(info.hermesHome ?? null, expected.home),
    isPackaged: main.isPackaged,
    name: main.name,
    nameIsCandidate: main.name === identity.displayName,
    userData: main.paths.userData,
    userDataIsCandidateOwn: samePath(main.paths.userData, expected.userData),
    userDataSwitchPassed: main.argv.some(argument => argument.startsWith('--user-data-dir'))
  }
}

async function verifyIdentity(run: Run, app: ElectronApplication, page: Page): Promise<void> {
  const { commit, expected, identity, observations, pkg, profile } = run
  const main = await readMainFacts(app)
  const info = await readVersionInfo(page)
  const agentCwd = await readAgentCwd(page)
  const facts = identityFacts(run, main, info)

  run.home = info.hermesHome ?? null
  observations.identity = facts
  // Evidence, not a gate: without HERMES_DESKTOP_CWD the packaged app falls back to Electron's home, the real profile.
  observations.agentWorkingDirectory = { cwd: agentCwd, isRealProfile: samePath(agentCwd, profile.userProfile) }

  check(main.isPackaged, 'app.isPackaged: this is the packaged app')
  check(facts.execPathIsPackagedExe, `the running executable is the packaged ${pkg.exe}, not ${main.execPath}`)
  check(
    facts.exeSha256Matches,
    `the executable's sha256 ${facts.exeSha256} differs from the manifest's ${pkg.exeSha256}`
  )
  expect(info.commit, 'the app reports the commit it was built from').toBe(commit)
  check(facts.nameIsCandidate, `the app is named ${main.name}, not ${identity.displayName}`)
  check(
    facts.userDataIsCandidateOwn,
    `Electron user data is ${main.paths.userData}, not the candidate's own ${expected.userData}`
  )
  check(
    facts.hermesHomeIsCandidateOwn,
    `the Hermes home is ${info.hermesHome}, not the candidate's own ${expected.home}`
  )
  check(
    facts.bakedHermesHomeClearActive,
    `the baked bundle environment did not clear the exported HERMES_HOME (${main.env.HERMES_HOME})`
  )
  check(!facts.userDataSwitchPassed, 'the harness must not pass --user-data-dir: the build decides by itself')
}

/** The local backend came up from the package, not from anything the real profile offers. */
async function verifyBackend(run: Run, app: ElectronApplication, page: Page): Promise<void> {
  const { expected, observations, pkg } = run
  let connection = await readConnection(page)

  await expect
    .poll(
      async () => {
        connection = await readConnection(page)

        return connection.mode
      },
      { intervals: [2_000], message: 'the window talks to the local backend it started', timeout: 180_000 }
    )
    .toBe('local')

  const port = Number(new URL(connection.apiOrigin ?? connection.baseUrl ?? 'http://127.0.0.1:0').port)
  let backend: BackendProcess | undefined

  await expect
    .poll(
      () => {
        try {
          backend = localBackendProcess(port, app.process().pid!, expected.home)

          return 'found'
        } catch (error) {
          return (error as Error).message
        }
      },
      { intervals: [1_000], message: `the process listening on port ${port} is identified`, timeout: 120_000 }
    )
    .toBe('found')

  const found = backend!

  assertBackendOrigin(found, pkg.payloadRoot, 'bundled', {
    installedCommit: readInstallationCommit(pkg.payloadRoot, 'bundled')
  })
  observations.backend = {
    executable: found.executable,
    executableInsidePayload: isInside(pkg.payloadRoot, found.executable),
    ownership: found.ownership,
    pid: found.pid,
    port
  }
}

/** A commit build declines to register the OS handler, and says so in desktop.log (written shortly after boot). */
async function verifyRegistrationSkipped(run: Run, page: Page): Promise<void> {
  const logPath = path.join(run.expected.home, 'logs', 'desktop.log')

  await expect
    .poll(() => readText(logPath).includes(REGISTRATION_SKIPPED), {
      intervals: [1_000],
      message: `${logPath} says: ${REGISTRATION_SKIPPED}`,
      timeout: 90_000
    })
    .toBe(true)

  const log = readText(logPath)

  run.observations.deeplink = {
    handlerRegisteredLineAbsent: !log.includes('registered hermes:// handler'),
    logPath,
    registrationSkippedForCommitBuild: log.includes(REGISTRATION_SKIPPED)
  }
  check(
    !log.includes('registered hermes:// handler'),
    'desktop.log says a hermes:// handler was registered, which a commit build must never do'
  )
  await shot(page, 'packaged-direct-02-before-quit.png')
}

/**
 * A commit build keeps its gateway rendezvous inside its own home (`<home>/gateway-locks`, set by the app for
 * commit builds: electron/backend-spawn-env.ts), so the per-OS-user rendezvous in the real profile must hold no
 * record. Both are read while the gateway still runs; the workflow's strict sentinel also fails a run that
 * created the per-user folder.
 */
function recordRendezvous(run: Run): void {
  const own = path.join(run.expected.home, 'gateway-locks')
  const perUser = path.join(run.profile.userProfile, '.local', 'state', 'hermes', 'gateway-locks')
  const ownRecords = readHostRecords([own])
  const perUserRecords = readHostRecords([perUser])

  run.observations.rendezvous = {
    dir: own,
    files: listEntries(own),
    perUserDir: perUser,
    perUserFiles: listEntries(perUser),
    perUserRecordCount: perUserRecords.length,
    recordsNameCandidateHome:
      ownRecords.length > 0 && ownRecords.every(record => samePathOrNull(record.home, run.expected.home)),
    records: ownRecords.map(({ file, home, pid, port, role }) => ({ file, home, pid, port, role }))
  }
  check(perUserRecords.length === 0, `the per-user gateway rendezvous ${perUser} holds a record from a direct start`)
}

/** Quit, then stop what the app left behind (its gateway outlives it): nothing may still run from the package. */
async function stopDirect(run: Run, app: ElectronApplication): Promise<void> {
  const { observations, pkg } = run

  observations.quit = await quit(app, 45_000)
  run.app = null

  const stop = runShipped(pkg.root, 'Stop', STOP_ARGUMENTS)
  const left = processesInside(readNativeProcesses(), pkg.root)

  observations.teardown = {
    processesLeft: left.length,
    stopExitCode: stop.code,
    stopOutput: redact(stop.stdout).split(/\r?\n/).filter(Boolean)
  }
  expect(stop.code, `Stop-HermesClarifyCandidate.cmd: ${stop.stdout}${stop.stderr}`).toBe(0)
  expect(
    left.map(entry => `${entry.pid} ${entry.executable}`),
    'no process still runs from the package'
  ).toEqual([])
}

/** Every Hermes-named entry of the real profile is one the candidate's identity owns, and the decoy home was never used. */
function verifyFootprint(run: Run): void {
  const { identity, observations, profile } = run

  const named = (directory: string, pattern: RegExp = /^hermes/i): string[] =>
    listEntries(directory).filter(name => pattern.test(name))

  const footprint = {
    appData: named(profile.appData),
    localAppData: named(profile.localAppData),
    localState: named(path.join(profile.userProfile, '.local', 'state')),
    userProfile: named(profile.userProfile, /^\.hermes/i)
  }

  const unexpected = [
    ...unexpectedEntries(footprint.appData, /^hermes/i, identity.appDataNames).map(name => `%APPDATA%\\${name}`),
    ...unexpectedEntries(footprint.localAppData, /^hermes/i, identity.localAppDataNames).map(
      name => `%LOCALAPPDATA%\\${name}`
    ),
    ...unexpectedEntries(footprint.userProfile, /^\.hermes/i, []).map(name => `%USERPROFILE%\\${name}`)
  ]

  observations.isolation = {
    decoyHomeUntouched: CONFIG.decoyHome ? !fs.existsSync(CONFIG.decoyHome) : null,
    realProfileFootprint: footprint,
    unexpectedRealProfileEntries: unexpected.length,
    unexpectedRealProfileNames: unexpected
  }
  expect(unexpected, 'nothing Hermes-named in the real profile but the candidate’s own names').toEqual([])

  if (CONFIG.decoyHome) {
    check(
      !fs.existsSync(CONFIG.decoyHome),
      `the decoy Hermes home ${CONFIG.decoyHome} was created: the exported HERMES_HOME was used`
    )
  }
}

/** Leave the runner clean and the evidence complete, pass or fail. */
async function cleanUp(run: Run): Promise<void> {
  const { observations, pkg } = run

  if (run.app) {
    await quit(run.app, 20_000)
    runShipped(pkg.root, 'Stop', STOP_ARGUMENTS)
  }

  observations.mainProcessLogTail = run.logs.slice(-40)

  if (process.env.HERMES_E2E_EVIDENCE_DIR) {
    copyBackendLogs(
      run.home ?? run.expected.home,
      path.join(process.env.HERMES_E2E_EVIDENCE_DIR, 'backend-logs', 'packaged-direct')
    )
  }

  writeObservations('packaged-direct-observations.json', observations)
}

test.describe('clarify drafts (packaged candidate, started directly)', () => {
  test('started directly, without its launcher, the candidate keeps to its own identity and leaves every real Hermes location alone', async () => {
    test.setTimeout(900_000)

    if (!CONFIG.candidateDir) {
      throw new Error('HERMES_E2E_REQUIRE_PACKAGED=1 but HERMES_E2E_CANDIDATE_DIR names no extracted candidate package')
    }

    const pkg = readCandidatePackage(CONFIG.candidateDir)
    const commit = CONFIG.expectedCommit || pkg.manifest.source.commit
    const profile = realProfile()
    const identity = candidateIdentity(commit)

    const run: Run = {
      app: null,
      commit,
      expected: {
        home: path.join(profile.localAppData, identity.homeName),
        userData: path.join(profile.appData, identity.userDataName)
      },
      home: null,
      identity,
      logs: [],
      observations: { completed: false, package: { name: pkg.manifest.package, root: pkg.root } },
      pkg,
      profile
    }

    const env = directEnvironment()

    try {
      expect(pkg.manifest.source.commit, 'the package manifest names the commit under test').toBe(commit)
      recordEnvironment(run, env)

      const { app, page } = await test.step('start the executable directly, as a double-click does', () =>
        launchDirect(run, env))

      await test.step('it is the packaged app, under its own name and in its own folders', () =>
        verifyIdentity(run, app, page))
      await test.step('its backend is the bundled runtime from the package', () => verifyBackend(run, app, page))
      await test.step('a commit build never registers the hermes:// handler', () =>
        verifyRegistrationSkipped(run, page))
      recordRendezvous(run)
      await test.step('quit and stop leave nothing running from the package', () => stopDirect(run, app))
      await test.step('the real profile holds nothing Hermes-named but the candidate’s own names', () =>
        verifyFootprint(run))
      run.observations.completed = true
    } finally {
      await cleanUp(run)
    }
  })
})
