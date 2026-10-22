/**
 * Packaged-bytes acceptance: the unsigned Windows candidate, exactly as it was zipped, keeps unsent clarify
 * choices and text as recoverable drafts through a REAL clarify timeout.
 *
 * What runs is the executable inside the EXTRACTED candidate zip (`HERMES_E2E_CANDIDATE_DIR`), started the way a
 * person starts it: through the shipped `Start-HermesClarifyCandidate.cmd`, whose `-EmitEnvironment` contract
 * (executable, `--user-data-dir`, the complete sandboxed environment) this spec launches from. Nothing here uses a
 * dev Electron, a dev backend or the repo's source tree; the only simulated part is the model, a loopback mock that
 * scripts the clarify tool call. (`clarify-drafts-packaged-direct.spec.ts` covers the start WITHOUT the launcher.)
 *
 *  1. The shipped launcher's contract is a fully isolated start of THIS executable: one sandbox for every state
 *     location (home, user data, profile, temp, the per-OS-user gateway rendezvous and the folder the assistant
 *     works in), no real Hermes location nearby, and none of the decoy variables the harness exports on purpose
 *     (a decoy HERMES_HOME, a dev checkout, a PM Python) reaches the candidate.
 *  2. It is the packaged app (`app.isPackaged`, loaded from app.asar, the exact exe whose sha256 the manifest names)
 *     under the candidate's own name (never "Hermes"), reporting the commit it was built from, with its Electron
 *     paths inside the sandbox.
 *  3. Its backend is the bundled runtime: the process serving the window is an interpreter from the package's own
 *     `agent-payload`, the canonical gateway it started stamped that commit, and that gateway published its
 *     rendezvous record inside the sandbox, so it cannot have attached to anyone else's backend. A thin app that
 *     quietly started some other Hermes would fail here, because no other Hermes has this commit's autosave.
 *  4. The scenario: a batch clarify, one pick and multiline typed text, NEVER Confirm. The card says "saved" only
 *     when the server's disk holds it; after the real timeout the settled card shows exactly those as drafts (not
 *     answers), the model is told they are unsubmitted, and "Show drafts saved on the server" recalls them.
 *  5. Teardown through the shipped Stop script leaves no process running from the package.
 *
 * Skipped only when no package is configured (a local run of the whole e2e folder). The Windows pipeline sets
 * HERMES_E2E_REQUIRE_PACKAGED=1, which turns a missing package into a failure, and refuses a skipped result.
 */

import fs from 'node:fs'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { waitForChatReady } from '../../../tests-js/scripts/desktop-chat-smoke'
import {
  assertBackendOrigin,
  type BackendProcess,
  localBackendProcess,
  readInstallationCommit,
  readNativeProcesses
} from '../../../tests-js/scripts/desktop-smoke-process'
import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import {
  BATCH_CLARIFY_QUESTIONS,
  BATCH_CLARIFY_TRIGGER,
  type MockServer,
  startMockServer
} from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
  liveForms,
  readAnswers,
  readDraftRows,
  sendPrompt,
  serverDraftRecords,
  settledCards,
  shot,
  toggleChoice,
  typeText,
  userMessages,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import {
  contractProblems,
  copyBackendLogs,
  countByImage,
  foreignHermesProcesses,
  isInside,
  type LaunchContract,
  lockDirectories,
  parseLaunchContract,
  processesInside,
  readAgentCwd,
  readCandidatePackage,
  readHostRecords,
  readMainFacts,
  readPackagedConfig,
  readVersionInfo,
  redact,
  rendezvousProblems,
  runShipped,
  samePath,
  sha256File,
  waitForWindowVisible
} from './clarify-packaged-fixture'
import { expect, installErrorBannerGuard, test } from './test'

const CONFIG = readPackagedConfig()

const CLARIFY_TIMEOUT_SECONDS = 40
const TYPED_TEXT = 'Packaged draft: line one ✓ ünï©ödé  \n  indented second line\nlast line, trailing spaces   '

const DRAFT_ROWS = [
  { content: ['Tea'], question: BATCH_CLARIFY_QUESTIONS[0].question },
  { content: [TYPED_TEXT], question: BATCH_CLARIFY_QUESTIONS[1].question }
]

// All the harness adds on top of the launcher's contract: software rendering on a GPU-less runner (two switches),
// and no quit-confirmation dialog for app.close() to wait on. Nothing else differs from a person's start.
const HARNESS_ARGUMENTS = ['--disable-gpu', '--no-sandbox']
const HARNESS_ENVIRONMENT = { HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1' }

test.skip(
  !CONFIG.candidateDir && !CONFIG.requirePackaged,
  'no extracted candidate package (HERMES_E2E_CANDIDATE_DIR) is configured'
)

interface DesktopBridge {
  getConnection: () => Promise<{ baseUrl: string; gatewayEndpoint?: { api_origin?: string }; mode?: string }>
}

type Observations = Record<string, unknown>

interface Run {
  app: ElectronApplication | null
  contract: LaunchContract
  expectedCommit: string
  logs: string[]
  mock: MockServer
  observations: Observations
  pkg: ReturnType<typeof readCandidatePackage>
  rootArgs: string[]
}

const check = (condition: boolean, message: string): void => expect(condition, message).toBe(true)

/** Resolve the shipped launcher's contract and prove it is an isolated start of this very executable. */
function acquireContract(run: Pick<Run, 'expectedCommit' | 'observations' | 'pkg' | 'rootArgs'>): LaunchContract {
  const { expectedCommit, observations, pkg, rootArgs } = run
  const started = runShipped(pkg.root, 'Start', ['-EmitEnvironment', ...rootArgs])

  if (started.error || started.code !== 0) {
    throw new Error(
      `Start-HermesClarifyCandidate.cmd -EmitEnvironment exited ${started.code}: ` +
        `${started.error?.message ?? ''}${started.stderr || started.stdout}`
    )
  }

  const contract = parseLaunchContract(started.stdout)

  const problems = contractProblems(contract, {
    commit: expectedCommit,
    decoys: CONFIG.decoys,
    exe: pkg.exe,
    packageRoot: pkg.root
  })

  observations.isolation = {
    contractProblems: problems.length,
    decoyVariablesWithheld: CONFIG.decoys.length,
    environmentNames: Object.keys(contract.environment).sort(),
    layout: contract.layout,
    refusedLocations: contract.refusedLocations
  }
  expect(problems, 'the shipped launcher must hand the candidate a fully isolated start of this executable').toEqual([])

  return contract
}

/** Seed the sandbox like a first run with one provider: the loopback mock, a short real clarify wait, no onboarding. */
function seedSandbox(contract: LaunchContract, mock: MockServer): void {
  const { hermesHome, userData } = contract.layout

  writeMockProviderConfig(hermesHome, mock.url, undefined, clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS))
  writeEnvFile(hermesHome)
  // The window size and zoom the rest of the suite pins, so hit-testing and screenshots are comparable.
  fs.writeFileSync(
    path.join(userData, 'window-state.json'),
    JSON.stringify({ height: 800, isMaximized: false, width: 1220, x: 0, y: 0 })
  )
  fs.writeFileSync(path.join(userData, 'zoom-state.json'), JSON.stringify({ zoomLevel: 0 }))
}

async function launchCandidate(run: Run): Promise<Page> {
  const { contract, logs, observations } = run

  observations.harness = { addedArguments: HARNESS_ARGUMENTS, addedEnvironment: Object.keys(HARNESS_ENVIRONMENT) }

  const app = await _electron.launch({
    args: [...contract.arguments, ...HARNESS_ARGUMENTS],
    cwd: contract.workingDirectory,
    env: { ...contract.environment, ...HARNESS_ENVIRONMENT },
    executablePath: contract.exe
  })

  run.app = app

  const collect = (chunk: Buffer): void => {
    logs.push(...redact(chunk.toString('utf8')).split('\n').filter(Boolean))
    logs.splice(0, Math.max(0, logs.length - 200))
  }

  app.process().stdout?.on('data', collect)
  app.process().stderr?.on('data', collect)

  // A packaged main bundle that fails to start never opens a window: fail with its own story, not a bare timeout.
  const page = await app.firstWindow().catch((error: Error) => {
    throw new Error(
      `the packaged app never opened a window: ${error.message.split('\n')[0]}\n${logs.slice(-60).join('\n')}`
    )
  })

  installErrorBannerGuard(page)
  await waitForChatReady(page, 300_000)
  await waitForWindowVisible(app, page, 60_000)

  return page
}

async function verifyIdentity(run: Run, app: ElectronApplication, page: Page): Promise<void> {
  const { contract, expectedCommit, observations, pkg } = run
  const { layout } = contract
  const exeSha256 = sha256File(pkg.exe)
  const main = await readMainFacts(app)
  const info = await readVersionInfo(page)
  const agentCwd = await readAgentCwd(page)

  const facts = {
    appPathIsAsar: samePath(main.appPath, path.join(pkg.resources, 'app.asar')),
    // The baked bundle environment clears an exported or registry HERMES_HOME before any path is resolved.
    bakedHermesHomeClearActive: main.env.HERMES_HOME === '',
    commit: info.commit ?? null,
    dirty: info.dirty ?? null,
    execPathIsPackagedExe: samePath(main.execPath, pkg.exe),
    exeSha256,
    exeSha256Matches: exeSha256 === pkg.exeSha256,
    hermesHome: info.hermesHome ?? null,
    // The update root, derived from the Hermes home: not where the bundled runtime lives (that is the backend check).
    hermesRoot: info.hermesRoot ?? null,
    hermesRuntime: info.hermesRuntime ?? null,
    isPackaged: main.isPackaged,
    mainProcessEnvironment: main.env,
    name: main.name,
    // Electron derives its default user data folder from this name: it must be the candidate's, never "Hermes".
    nameIsCandidate: main.name.toLowerCase() !== 'hermes' && main.name.includes(expectedCommit.slice(0, 7)),
    payload: info.payload ?? null,
    source: info.source ?? null,
    updateMechanism: info.updateMechanism ?? null,
    userDataSwitchPassed: main.argv.includes(`--user-data-dir=${layout.userData}`),
    version: main.version
  }

  const sandboxed = {
    // Where the assistant works when a session names no folder; Electron's own fallback is the REAL home on Windows.
    agentWorkingDirectory: agentCwd,
    agentWorkingDirectoryIsWorkspace: samePath(agentCwd, layout.workspace),
    appDataInsideSandbox: isInside(layout.root, main.paths.appData),
    hermesHomeIsSandbox: info.hermesHome !== undefined && samePath(info.hermesHome, layout.hermesHome),
    hermesRootInsideSandbox: info.hermesRoot !== undefined && isInside(layout.root, info.hermesRoot),
    homeInsideSandbox: isInside(layout.root, main.paths.home),
    logsInsideSandbox: isInside(layout.root, main.paths.logs),
    paths: main.paths,
    sessionDataInsideSandbox: isInside(layout.root, main.paths.sessionData),
    tempIsSandbox: isInside(layout.root, main.paths.temp),
    userDataIsSandbox: samePath(main.paths.userData, layout.userData)
  }

  observations.identity = facts
  observations.isolation = { ...(observations.isolation as object), ...sandboxed }
  test.info().annotations.push({ description: `${pkg.manifest.package} ${expectedCommit}`, type: 'candidate' })

  check(facts.isPackaged, 'app.isPackaged: this is the packaged app, not a dev tree')
  check(facts.appPathIsAsar, `the app loads from ${path.join(pkg.resources, 'app.asar')}, not ${main.appPath}`)
  check(facts.execPathIsPackagedExe, `the running executable is the packaged ${pkg.exe}, not ${main.execPath}`)
  check(facts.exeSha256Matches, `the executable's sha256 ${exeSha256} differs from the manifest's ${pkg.exeSha256}`)
  check(facts.nameIsCandidate, `the app is named ${main.name}: it must be the candidate's own name, not Hermes`)
  expect(info.commit, 'the app reports the commit it was built from').toBe(expectedCommit)
  expect(info.payload, 'the build stamp says the runtime is bundled').toBe('bundled')
  expect(info.hermesRuntime?.type, 'the app runs the runtime it carries').toBe('embedded')
  expect(info.source, 'a one-commit build').toBe('commit-build')
  expect(info.updateMechanism, 'its updater is external, so it refuses to update itself').toBe('external')
  expect(info.dirty, 'built from a clean checkout').toBe(false)
  check(sandboxed.hermesRootInsideSandbox, `the update root ${info.hermesRoot} is outside the sandbox ${layout.root}`)
  check(facts.userDataSwitchPassed, 'Electron got --user-data-dir, so its default user data was never created')
  check(
    facts.bakedHermesHomeClearActive,
    `the baked bundle environment did not clear HERMES_HOME (${main.env.HERMES_HOME})`
  )
  check(sandboxed.userDataIsSandbox, `Electron userData is ${main.paths.userData}, not ${layout.userData}`)
  check(sandboxed.hermesHomeIsSandbox, `the Hermes home is ${info.hermesHome}, not ${layout.hermesHome}`)
  check(
    sandboxed.sessionDataInsideSandbox && sandboxed.logsInsideSandbox,
    'Electron session data and logs are in the sandbox'
  )
  check(sandboxed.tempIsSandbox, `the temp directory ${main.paths.temp} is outside the sandbox`)
  check(
    sandboxed.agentWorkingDirectoryIsWorkspace,
    `the assistant would work in ${agentCwd}, not the sandbox workspace ${layout.workspace}`
  )
}

async function verifyBackend(run: Run, app: ElectronApplication, page: Page): Promise<void> {
  const { contract, expectedCommit, observations, pkg } = run

  const connection = await page.evaluate(async () => {
    const bridge = (window as unknown as { hermesDesktop?: DesktopBridge }).hermesDesktop

    if (!bridge) {
      throw new Error('the desktop connection bridge is unavailable')
    }

    const { baseUrl, gatewayEndpoint, mode } = await bridge.getConnection()

    return { apiOrigin: gatewayEndpoint?.api_origin ?? null, baseUrl, mode: mode ?? null }
  })

  expect(connection.mode, 'the window talks to the LOCAL backend it started, not a remote connection').toBe('local')
  const port = Number(new URL(connection.apiOrigin ?? connection.baseUrl).port)
  let backend: BackendProcess | undefined

  await expect
    .poll(
      () => {
        try {
          backend = localBackendProcess(port, app.process().pid!, contract.layout.hermesHome)

          return 'found'
        } catch (error) {
          return (error as Error).message
        }
      },
      { intervals: [1_000], message: `the process listening on port ${port} is identified`, timeout: 60_000 }
    )
    .toBe('found')

  const found = backend!
  const installedCommit = readInstallationCommit(pkg.payloadRoot, 'bundled')

  assertBackendOrigin(found, pkg.payloadRoot, 'bundled', { installedCommit })

  const everything = readNativeProcesses()
  const own = processesInside(everything, pkg.root)
  const foreign = foreignHermesProcesses(everything, pkg.root)

  // The gateways of one OS user find each other through a rendezvous directory: the one this gateway published its
  // record in must be inside the sandbox, so it can neither have attached to, nor been found by, a real backend.
  const rendezvous = rendezvousProblems(readHostRecords(lockDirectories(contract.layout)), contract.layout, found.pid)

  observations.backend = {
    codeSha: found.codeSha ?? null,
    command: redact(found.command),
    executable: found.executable,
    executableInsidePackage: isInside(pkg.root, found.executable),
    executableInsidePayload: isInside(pkg.payloadRoot, found.executable),
    foreignProcesses: foreign.length,
    installedCommit,
    ownership: found.ownership,
    pid: found.pid,
    port,
    processesFromPackage: countByImage(own),
    rendezvousInsideSandbox: rendezvous.length === 0,
    rendezvousProblems: rendezvous
  }

  expect(installedCommit, 'the install stamp inside the package names the commit under test').toBe(expectedCommit)
  check(
    isInside(pkg.payloadRoot, found.executable),
    `the backend interpreter ${found.executable} is outside ${pkg.payloadRoot}`
  )
  expect(
    foreign.map(entry => `${entry.pid} ${entry.executable}`),
    'no Hermes or Python process runs from anywhere else'
  ).toEqual([])
  expect(rendezvous, "the started gateway's rendezvous is the sandbox's own").toEqual([])

  if (found.ownership === 'host-gateway') {
    expect(found.codeSha, 'the canonical gateway stamped the commit under test into its own state').toBe(expectedCommit)
  }
}

/** The core scenario, driven in the packaged window. Fills `observations.scenario`. */
async function runClarifyScenario(run: Run, page: Page): Promise<void> {
  const { contract, mock, observations } = run
  const { hermesHome } = contract.layout
  const from = mock.receivedChatRequests.length

  await sendPrompt(page, BATCH_CLARIFY_TRIGGER)
  const form = await waitForLiveForm(page, BATCH_CLARIFY_QUESTIONS.length, 180_000)

  // Q1: pick Tea. Q2: type multiline Unicode text. Confirm is never pressed.
  await toggleChoice(form, 0, 'Tea')
  await typeText(form, 1, TYPED_TEXT)

  // The card says "saved" only when the server's disk holds the newest revision of every draft.
  await waitForDraftState(form, 'saved', 60_000)
  const [stored] = await waitForServerRecords(hermesHome, 1, 60_000)

  const storedDrafts = Object.fromEntries(
    Object.entries(stored.record.drafts).map(([qid, draft]) => [qid, { choices: draft.choices, text: draft.text }])
  )

  expect(storedDrafts, "the packaged backend's disk holds exactly the unsent pick and text").toEqual({
    q0: { choices: ['Tea'], text: '' },
    q1: { choices: [], text: TYPED_TEXT }
  })
  expect(stored.record.outcome).toBeNull()
  await expect(form.locator('button[type="submit"]')).toBeEnabled()
  expect(clarifyToolResults(mock, from), 'nothing was submitted: the model has received no tool result').toEqual([])
  await shot(page, 'packaged-01-live-card.png')

  // The real clarify wait expires (no Confirm was pressed).
  const settled = settledCards(page).filter({ visible: true })

  await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 120) * 1000 })
  await expect(liveForms(page)).toHaveCount(0)
  await waitForFinalSettled(settled, BATCH_CLARIFY_QUESTIONS.length)

  const answers = await readAnswers(settled)

  expect(answers, 'nothing is an answer: every confirmed-answer row is empty').toHaveLength(
    BATCH_CLARIFY_QUESTIONS.length
  )
  answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))

  const rows = await readDraftRows(settled)

  expect(rows.map(({ content, question }) => ({ content, question }))).toEqual(DRAFT_ROWS)
  rows.forEach(row => expect(row.transcript).toBe('received'))
  await shot(page, 'packaged-02-settled-card.png')

  // Explicit durable recall: a real `clarify.drafts` read against the packaged backend.
  await settled.getByRole('button', { name: /Show drafts saved on the server/ }).click()
  const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')

  await recovered.waitFor({ state: 'visible', timeout: 30_000 })
  const recalled = await readDraftRows(recovered)

  expect(recalled.map(({ content, question }) => ({ content, question }))).toEqual(DRAFT_ROWS)
  await shot(page, 'packaged-03-recalled.png')

  // What the model actually received: drafts beside, never inside, the responses; flagged unsubmitted.
  await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 60_000 }).toBe(1)
  const [told] = clarifyToolResults(mock, from)

  expect(told.outcome).toBe('timed_out')
  expect(told.responses.map(response => [response.status, response.user_response])).toEqual([
    ['unanswered', null],
    ['unanswered', null]
  ])
  expect(told.drafts_submitted).toBe(false)
  expect(told.drafts_durable).toBe(true)
  expect(
    userMessages(mock, from).filter(text => text.includes(TYPED_TEXT)),
    'the unsent text was never sent as the person’s own words'
  ).toEqual([])

  observations.scenario = {
    draftsAreNotAnswers: true,
    modelToldUnsubmitted: told.drafts_submitted === false && told.outcome === 'timed_out',
    modelReceived: told,
    recalledFromServer: true,
    rows,
    serverConfirmedSave: true,
    serverGateway: stored.gateway,
    serverRecord: stored.record,
    timeoutSeconds: CLARIFY_TIMEOUT_SECONDS
  }
}

/** Close the window, run the shipped Stop script, and prove nothing from the package is still running. */
async function stopCandidate(run: Run): Promise<void> {
  const { observations, pkg, rootArgs } = run

  await run.app?.close().catch(() => undefined)
  run.app = null

  const stop = runShipped(pkg.root, 'Stop', rootArgs)
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

test.describe('clarify drafts (packaged candidate)', () => {
  test('the packaged Windows candidate keeps unsent choices and text as recoverable drafts through a real clarify timeout', async () => {
    test.setTimeout(1_200_000)

    if (!CONFIG.candidateDir) {
      throw new Error('HERMES_E2E_REQUIRE_PACKAGED=1 but HERMES_E2E_CANDIDATE_DIR names no extracted candidate package')
    }

    const pkg = readCandidatePackage(CONFIG.candidateDir)
    const expectedCommit = CONFIG.expectedCommit || pkg.manifest.source.commit
    const observations: Observations = { completed: false, package: { name: pkg.manifest.package, root: pkg.root } }
    const rootArgs = CONFIG.sandboxRoot ? ['-Root', CONFIG.sandboxRoot] : []
    const mock = await startMockServer()
    let run: Run | null = null

    try {
      expect(pkg.manifest.source.commit, 'the package manifest names the commit under test').toBe(expectedCommit)
      check(fs.existsSync(pkg.exe), `${pkg.exe} is missing from the extracted package`)

      const contract = await test.step('the shipped launcher hands over an isolated launch contract', () =>
        acquireContract({ expectedCommit, observations, pkg, rootArgs }))

      const active: Run = { app: null, contract, expectedCommit, logs: [], mock, observations, pkg, rootArgs }

      run = active
      seedSandbox(contract, mock)

      const page = await test.step('start the packaged executable with that contract', () => launchCandidate(active))
      const app = active.app!

      await shot(page, 'packaged-00-booted.png')

      await test.step('it is the packaged app, built from this commit, isolated', () =>
        verifyIdentity(active, app, page))
      await test.step('its backend is the bundled runtime from the package', () => verifyBackend(active, app, page))
      await test.step('a clarify left unconfirmed through a real timeout survives as drafts', () =>
        runClarifyScenario(active, page))
      await test.step('stop leaves nothing running from the package', () => stopCandidate(active))

      if (CONFIG.decoyHome) {
        check(
          !fs.existsSync(CONFIG.decoyHome),
          `the decoy Hermes home ${CONFIG.decoyHome} was created: something used the exported HERMES_HOME`
        )
      }

      observations.isolation = {
        ...(observations.isolation as object),
        decoyHomeUntouched: CONFIG.decoyHome ? true : null
      }
      observations.completed = true
    } finally {
      // Always leave the runner clean and the evidence complete, pass or fail.
      if (run) {
        await run.app?.close().catch(() => undefined)
        run.app = null

        if (!(observations.teardown as { stopExitCode?: number } | undefined)) {
          runShipped(pkg.root, 'Stop', rootArgs)
        }

        observations.mainProcessLogTail = run.logs.slice(-40)

        if (process.env.HERMES_E2E_EVIDENCE_DIR) {
          copyBackendLogs(
            run.contract.layout.hermesHome,
            path.join(process.env.HERMES_E2E_EVIDENCE_DIR, 'backend-logs', 'packaged')
          )
        }
      }

      await mock.close().catch(() => undefined)
      observations.serverRecordsOnDisk = run ? serverDraftRecords(run.contract.layout.hermesHome).length : 0
      writeObservations('packaged-observations.json', observations)
    }
  })
})
