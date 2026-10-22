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
  copyBackendLogs,
  isInside,
  listEntries,
  processesInside,
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
  waitForWindowVisible
} from './clarify-packaged-fixture'
import { expect, test } from './test'

const CONFIG = readPackagedConfig()

/** What desktop.log says when a commit build declines to register the OS handler (deep-link-protocol.ts). */
const REGISTRATION_SKIPPED = '[deeplink] hermes:// registration skipped (commit build)'

// The only thing the harness adds to a person's environment: software rendering on a GPU-less runner.
const HARNESS_ARGUMENTS = ['--disable-gpu', '--no-sandbox']

test.skip(
  !CONFIG.candidateDir && !CONFIG.requirePackaged,
  'no extracted candidate package (HERMES_E2E_CANDIDATE_DIR) is configured'
)

interface ConnectionBridge {
  getConnection: () => Promise<{ baseUrl?: string; gatewayEndpoint?: { api_origin?: string }; mode?: string }>
}

type Observations = Record<string, unknown>

const check = (condition: boolean, message: string): void => expect(condition, message).toBe(true)

const samePathOrNull = (value: null | string, expected: string): boolean => value !== null && samePath(value, expected)

/** A person's environment: the machine's own, minus the dev-tree decoys the launcher run proved are withheld. */
function directEnvironment(): Record<string, string> {
  const decoys = new Set(CONFIG.decoys.map(name => name.toUpperCase()))

  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [name, value] = entry

      return value !== undefined && !decoys.has(name.toUpperCase())
    })
  )
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

interface Connection {
  apiOrigin: null | string
  baseUrl: null | string
  mode: null | string
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

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
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

test.describe('clarify drafts (packaged candidate, started directly)', () => {
  test('started directly, without its launcher, the candidate keeps to its own identity and leaves every real Hermes location alone', async () => {
    test.setTimeout(900_000)

    if (!CONFIG.candidateDir) {
      throw new Error('HERMES_E2E_REQUIRE_PACKAGED=1 but HERMES_E2E_CANDIDATE_DIR names no extracted candidate package')
    }

    const pkg = readCandidatePackage(CONFIG.candidateDir)
    const commit = CONFIG.expectedCommit || pkg.manifest.source.commit
    const identity = candidateIdentity(commit)
    const { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile } = process.env
    const observations: Observations = { completed: false, package: { name: pkg.manifest.package, root: pkg.root } }
    const logs: string[] = []
    const env = directEnvironment()
    let app: ElectronApplication | null = null
    let home: null | string = null

    try {
      check(
        Boolean(appData && localAppData && userProfile),
        'APPDATA, LOCALAPPDATA and USERPROFILE name the real profile'
      )
      expect(pkg.manifest.source.commit, 'the package manifest names the commit under test').toBe(commit)

      // The point of the test: nothing of the launcher's, and no opt-out of the OS handler registration.
      const desktopVariables = Object.keys(env).filter(name => name.toUpperCase().startsWith('HERMES_DESKTOP_'))

      expect(desktopVariables, 'the harness must not hand the candidate any HERMES_DESKTOP_* switch').toEqual([])

      const expectedUserData = path.join(appData!, identity.userDataName)
      const expectedHome = path.join(localAppData!, identity.homeName)

      observations.environment = {
        decoyHome: CONFIG.decoyHome ?? null,
        hermesHomeExported: env.HERMES_HOME ?? null,
        names: Object.keys(env)
          .filter(name => name.toUpperCase().startsWith('HERMES_'))
          .sort()
      }

      app = await test.step('start the executable directly, as a double-click does', () =>
        _electron.launch({ args: HARNESS_ARGUMENTS, cwd: pkg.appDir, env, executablePath: pkg.exe }))

      const started = app

      const collect = (chunk: Buffer): void => {
        logs.push(...redact(chunk.toString('utf8')).split('\n').filter(Boolean))
        logs.splice(0, Math.max(0, logs.length - 200))
      }

      started.process().stdout?.on('data', collect)
      started.process().stderr?.on('data', collect)

      const page = await started.firstWindow().catch((error: Error) => {
        throw new Error(
          `the packaged app never opened a window: ${error.message.split('\n')[0]}\n${logs.slice(-60).join('\n')}`
        )
      })

      await waitForRenderer(page, 300_000)
      await waitForWindowVisible(started, page, 60_000)
      await shot(page, 'packaged-direct-01-first-window.png')

      const main = await readMainFacts(started)
      const info = await readVersionInfo(page)
      const exeSha256 = sha256File(pkg.exe)
      home = info.hermesHome ?? null

      const facts = {
        bakedHermesHomeClearActive: main.env.HERMES_HOME === '',
        commit: info.commit ?? null,
        execPathIsPackagedExe: samePath(main.execPath, pkg.exe),
        exeSha256Matches: exeSha256 === pkg.exeSha256,
        expectedHome,
        expectedUserData,
        hermesHome: info.hermesHome ?? null,
        hermesHomeIsCandidateOwn: info.hermesHome !== undefined && samePath(info.hermesHome, expectedHome),
        isPackaged: main.isPackaged,
        name: main.name,
        nameIsCandidate: main.name === identity.displayName,
        userData: main.paths.userData,
        userDataIsCandidateOwn: samePath(main.paths.userData, expectedUserData),
        userDataSwitchPassed: main.argv.some(argument => argument.startsWith('--user-data-dir'))
      }

      observations.identity = facts

      check(facts.isPackaged, 'app.isPackaged: this is the packaged app')
      check(facts.execPathIsPackagedExe, `the running executable is the packaged ${pkg.exe}, not ${main.execPath}`)
      check(facts.exeSha256Matches, `the executable's sha256 ${exeSha256} differs from the manifest's ${pkg.exeSha256}`)
      expect(info.commit, 'the app reports the commit it was built from').toBe(commit)
      check(facts.nameIsCandidate, `the app is named ${main.name}, not ${identity.displayName}`)
      check(
        facts.userDataIsCandidateOwn,
        `Electron user data is ${main.paths.userData}, not the candidate's own ${expectedUserData}`
      )
      check(
        facts.hermesHomeIsCandidateOwn,
        `the Hermes home is ${info.hermesHome}, not the candidate's own ${expectedHome}`
      )
      check(
        facts.bakedHermesHomeClearActive,
        `the baked bundle environment did not clear the exported HERMES_HOME (${main.env.HERMES_HOME})`
      )
      check(!facts.userDataSwitchPassed, 'the harness must not pass --user-data-dir: the build decides by itself')

      // The local backend came up from the package, not from anything the real profile offers.
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
              backend = localBackendProcess(port, started.process().pid!, expectedHome)

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

      // A commit build declines to register the OS handler, and says so in desktop.log (written shortly after boot).
      const logPath = path.join(expectedHome, 'logs', 'desktop.log')

      await expect
        .poll(() => readText(logPath).includes(REGISTRATION_SKIPPED), {
          intervals: [1_000],
          message: `${logPath} says: ${REGISTRATION_SKIPPED}`,
          timeout: 90_000
        })
        .toBe(true)

      const log = readText(logPath)

      observations.deeplink = {
        handlerRegisteredLineAbsent: !log.includes('registered hermes:// handler'),
        logPath,
        registrationSkippedForCommitBuild: log.includes(REGISTRATION_SKIPPED)
      }
      check(
        !log.includes('registered hermes:// handler'),
        'desktop.log says a hermes:// handler was registered, which a commit build must never do'
      )
      await shot(page, 'packaged-direct-02-before-quit.png')

      // The per-OS-user rendezvous is read from the real profile: the gateway is still running, so its record is
      // there. Evidence only; the workflow's strict sentinel is what fails a run that created it.
      const rendezvousDir = path.join(userProfile!, '.local', 'state', 'hermes', 'gateway-locks')
      const records = readHostRecords([rendezvousDir])

      observations.rendezvous = {
        dir: rendezvousDir,
        files: listEntries(rendezvousDir),
        recordsNameCandidateHome:
          records.length > 0 && records.every(record => samePathOrNull(record.home, expectedHome)),
        records: records.map(({ file, home, pid, port: recordPort, role }) => ({
          file,
          home,
          pid,
          port: recordPort,
          role
        }))
      }

      observations.quit = await quit(started, 45_000)
      app = null

      // Stop what the app left behind (its gateway outlives it); the shipped script kills what runs from the package.
      const stop = runShipped(pkg.root, 'Stop', CONFIG.sandboxRoot ? ['-Root', CONFIG.sandboxRoot] : [])
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

      // Every Hermes-named entry of the real profile is one the candidate's identity owns.
      const footprint = {
        appData: listEntries(appData).filter(name => /^hermes/i.test(name)),
        localAppData: listEntries(localAppData).filter(name => /^hermes/i.test(name)),
        localState: listEntries(path.join(userProfile!, '.local', 'state')).filter(name => /^hermes/i.test(name)),
        userProfile: listEntries(userProfile).filter(name => /^\.hermes/i.test(name))
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

      observations.completed = true
    } finally {
      // Leave the runner clean and the evidence complete, pass or fail.
      if (app) {
        await quit(app, 20_000)
        runShipped(pkg.root, 'Stop', CONFIG.sandboxRoot ? ['-Root', CONFIG.sandboxRoot] : [])
      }

      observations.mainProcessLogTail = logs.slice(-40)

      if (home && process.env.HERMES_E2E_EVIDENCE_DIR) {
        copyBackendLogs(home, path.join(process.env.HERMES_E2E_EVIDENCE_DIR, 'backend-logs', 'packaged-direct'))
      }

      writeObservations('packaged-direct-observations.json', observations)
    }
  })
})
