/**
 * Native E2E: clarify drafts when the backend runs its agent turns in a COMPUTE-HOST child
 * (`dashboard.turn_isolation: true`, the legacy sidecar's process isolation).
 *
 * The Desktop is attached by URL + token to a real `hermes serve` the TEST spawns under its own HOME and
 * HERMES_HOME (a Desktop talking to a backend on another machine). With turn isolation on, the batch `clarify`
 * request is asked by the CHILD process that runs the turn; the serving process only mirrors it. Every draft op
 * the card sends (`clarify.draft`, `clarify.drafts.discard`) must therefore be relayed to the child that owns the
 * request, under the same entitlement and the same store scope, or the card would silently fall back to
 * device-only protection while the model is told nothing. Only the LLM is scripted; the clarify wait is the
 * product's own, shortened with `agent.clarify_timeout` in the BACKEND's config.
 *
 *  1. The child really owns the turn (its pid, parent and command line); the card's drafts are saved durably in
 *     the backend's store; a cut connection and a reload with the DEVICE copy removed bring the same card back
 *     from the serving process's mirror of the child's drafts; the real timeout leaves drafts, never answers,
 *     and the model is told exactly that.
 *  2. A freshly started backend process (the old one killed, its child with it): the explicit recall reads the
 *     exact text the child wrote, with no device copy (same scope in both processes); an explicit discard
 *     removes the record from the backend's disk.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Page } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { MIXED_CLARIFY_TRIGGER, type MockServer, startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
  clearDeviceDrafts,
  deviceDraftEntries,
  interceptGatewaySocket,
  liveForms,
  MIXED_DRAFT_ROWS,
  MIXED_SERVER_DRAFTS,
  MIXED_TEXT,
  newSession,
  readAnswers,
  readDraftRows,
  readDraftStatus,
  readFormState,
  sendPrompt,
  serverDraftRecords,
  settledCards,
  shot,
  type SocketLink,
  stageMixedDraft,
  submittedDraftText,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForReconnect,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import { type CoreSandbox, createCoreSandbox } from './core/harness'
import { type RemoteBackend, remoteEnv, startRemoteBackend } from './core/remote-helpers'
import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type NoProviderFixture,
  preserveSandboxLogs,
  sandboxGatewayPid,
  waitForAppReady
} from './fixtures'
import { expect, test } from './test'

// The remote helpers pick the backend's interpreter from HERMES_E2E_PYTHON; the CI workflow exports the same
// interpreter as HERMES_DESKTOP_PYTHON.
process.env.HERMES_E2E_PYTHON ??= process.env.HERMES_DESKTOP_PYTHON

const CLARIFY_TIMEOUT_SECONDS = 60
const RECALL = /Show drafts saved on the server/
// The product's own switch: the config key a user sets (`hermes config set dashboard.turn_isolation true`).
const TURN_ISOLATION_CONFIG = 'dashboard:\n  turn_isolation: true\n'
// `HostSupervisor`'s registry of its live child, under `<HERMES_HOME>/state/`.
const COMPUTE_HOST_REGISTRY = path.join('state', 'dashboard-compute-host.json')

test.describe.configure({ mode: 'serial' })

// The compute host is POSIX process supervision (process groups, SIGKILL); the process table is read with `ps`.
test.skip(process.platform === 'win32', 'the compute-host child is not supported on Windows')

let mock: MockServer
let backendBox: CoreSandbox
let backend: RemoteBackend
let client: NoProviderFixture
let link: SocketLink
const observations: Record<string, unknown> = { timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }

interface ProcessRow {
  command: string
  pid: number
  ppid: number
}

/** One row of the process table, or null when the process is gone. */
function processRow(pid: number): null | ProcessRow {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const [ppid = '', ...command] = out.split(/\s+/)

    return out ? { command: command.join(' '), pid, ppid: Number(ppid) } : null
  } catch {
    return null
  }
}

/**
 * Open a conversation from the sidebar by the title its row carries and wait until the thread shows it. Under turn
 * isolation the backend titles the conversation by its first prompt (a plain `hermes serve` lists "Untitled
 * session", which is what the shared `openSession` helper looks for), and the row is a button named by that title.
 */
async function openTitledSession(page: Page, title: string): Promise<void> {
  await page.locator('[data-slot="sidebar"]').getByRole('button', { name: title, exact: true }).first().click()
  await expect(page.locator('[data-slot="aui_thread-viewport"]').filter({ visible: true }).first()).toContainText(
    title,
    { timeout: 30_000 }
  )
}

/** The compute-host child `hermes serve` spawned for turn isolation: its pid from the supervisor's registry. */
function computeHostChild(hermesHome: string): null | ProcessRow {
  const registry = path.join(hermesHome, COMPUTE_HOST_REGISTRY)

  if (!fs.existsSync(registry)) {
    return null
  }

  const pid = Number(JSON.parse(fs.readFileSync(registry, 'utf8')).host_pid)

  return Number.isInteger(pid) && pid > 0 ? processRow(pid) : null
}

/** True when `ancestor` is `row`'s parent or an ancestor of it (a launcher may sit between them). */
function descendsFrom(row: ProcessRow, ancestor: number): boolean {
  let current: null | ProcessRow = row

  for (let hops = 0; current && hops < 8; hops += 1) {
    if (current.ppid === ancestor) {
      return true
    }

    current = current.ppid > 1 ? processRow(current.ppid) : null
  }

  return false
}

test.beforeAll(async () => {
  // Booting the app and a backend with a compute-host child on a cold runner outlasts the 90 s default.
  test.setTimeout(300_000)
  mock = await startMockServer()
  backendBox = createCoreSandbox('compute-host-backend')

  writeMockProviderConfig(
    backendBox.hermesHome,
    mock.url,
    undefined,
    `${clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS)}${TURN_ISOLATION_CONFIG}`
  )
  writeEnvFile(backendBox.hermesHome)
  backend = await startRemoteBackend(backendBox)

  const sandbox = createSandbox('compute-host-client')
  const { app, page } = await launchDesktop(buildAppEnv(sandbox, remoteEnv(backend)))
  client = { app, cleanup: async () => sandbox.cleanup(), page, sandbox }
  await waitForAppReady(client, 120_000)

  // Only sockets opened after the route exists are routed: reload once so the renderer's connection is one.
  link = await interceptGatewaySocket(page)
  await page.reload()
  await waitForAppReady(client, 120_000)
  await expect.poll(() => link.opened(), { timeout: 60_000 }).toBeGreaterThan(0)
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  observations.backendLogTail = backend?.logTail()
  writeObservations('native-compute-host-observations.json', observations)
  await client?.app.close().catch(() => undefined)
  await backend?.kill()
  preserveSandboxLogs(backendBox)
  await mock?.close()
  client?.sandbox.cleanup()
  backendBox?.cleanup()
})

test.describe('clarify drafts (native, remote hermes serve backend with turn isolation)', () => {
  test('the child that owns the request saves the drafts; a cut connection and a reload bring the card back from the mirror alone; a real timeout leaves drafts, never answers', async () => {
    test.setTimeout((CLARIFY_TIMEOUT_SECONDS + 240) * 1000)
    const { page } = client
    const from = mock.receivedChatRequests.length

    // The client really talks to the remote backend and started no backend of its own.
    expect(new URL(link.urls()[0]).port).toBe(String(backend.port))
    expect(sandboxGatewayPid(client.sandbox.hermesHome)).toBeNull()

    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} compute-host-first`)
    const form = await waitForLiveForm(page, 3)

    // The turn (and so the clarify request) belongs to a real child process of the backend, not to the backend.
    const child = computeHostChild(backendBox.hermesHome)
    expect(child, 'the supervisor registered a live compute-host child').not.toBeNull()
    expect(child!.command).toContain('tui_gateway.compute_host')
    expect(descendsFrom(child!, backend.pid()), 'the child belongs to this backend').toBe(true)
    expect(child!.pid).not.toBe(backend.pid())

    const staged = await stageMixedDraft(form)
    await waitForDraftState(form, 'saved')

    // The record is in the BACKEND's home under the sidecar's own store: the child wrote it under the scope the
    // serving process derives for the same session.
    const [stored] = await waitForServerRecords(backendBox.hermesHome, 1)
    expect(stored.gateway).toBe('tui_gateway')
    expect(stored.record.drafts.q2.text).toBe(MIXED_TEXT)
    await shot(page, 'native-compute-host-01-live-card.png')

    // A cut connection: the renderer redials and the serving process replays the open request WITH the drafts
    // its mirror holds (the child pushed them after each save).
    const opened = link.opened()
    link.drop()
    await waitForReconnect(link, opened)
    const afterDrop = await waitForLiveForm(page, 3)
    expect(await readFormState(afterDrop), 'the edits are exactly as they were before the cut').toEqual(staged)
    await expect(afterDrop.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from)).toEqual([])
    expect(serverDraftRecords(backendBox.hermesHome).map(entry => entry.record)).toEqual([stored.record])
    await shot(page, 'native-compute-host-02-after-drop.png')

    // A reload of the whole window with the device copy removed: the replay is the only source of the edits.
    await clearDeviceDrafts(page)
    expect(await deviceDraftEntries(page)).toEqual([])
    await page.reload()
    await waitForAppReady(client, 120_000)
    const afterReload = await waitForLiveForm(page, 3)
    expect(await readFormState(afterReload), 'the edits survive a reload with no device copy').toEqual(staged)
    expect([null, 'saved']).toContain((await readDraftStatus(afterReload)).state)
    await expect(afterReload.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from)).toEqual([])
    await shot(page, 'native-compute-host-03-after-reload.png')

    // No Confirm: the child's real clarify wait expires.
    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await expect(liveForms(page)).toHaveCount(0)
    await expect(settled).toHaveCount(1)
    await waitForFinalSettled(settled, 3)

    const answers = await readAnswers(settled)
    expect(answers).toHaveLength(3)
    answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))
    const rows = await readDraftRows(settled)
    expect(rows.map(({ content, question }) => ({ content, question }))).toEqual(MIXED_DRAFT_ROWS)
    await shot(page, 'native-compute-host-04-settled.png')

    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('timed_out')
    expect(told.drafts_submitted).toBe(false)
    expect(told.responses.every(response => response.status === 'unanswered' && response.user_response === null)).toBe(true)
    expect(
      Object.fromEntries(
        (told.drafts ?? []).map(({ question_id, selected_choices, typed_text }) => [
          question_id,
          { choices: selected_choices, text: typed_text }
        ])
      )
    ).toEqual(MIXED_SERVER_DRAFTS)
    expect(submittedDraftText(mock, from, [MIXED_TEXT, 'Bravo'])).toEqual([])

    observations.cutAndReload = { child, modelReceived: told, rows, socketUrls: link.urls().length, staged }
  })

  test('a freshly started backend recalls the exact text its child wrote from the durable store with no device copy; an explicit discard removes it', async () => {
    test.setTimeout(300_000)
    const { page } = client
    const [stored] = serverDraftRecords(backendBox.hermesHome)
    const requestsBefore = mock.receivedChatRequests.length
    const oldChild = computeHostChild(backendBox.hermesHome)

    // The backend dies and a new process takes the same port and home.
    const killedPid = backend.pid()
    const opened = link.opened()
    await backend.restart()
    expect(backend.pid(), 'a new backend process').not.toBe(killedPid)
    await waitForReconnect(link, opened)
    await page.reload()
    await waitForAppReady(client, 120_000)

    // No device copy either: the backend's record is all that is left to read from.
    await clearDeviceDrafts(page)
    expect(await deviceDraftEntries(page)).toEqual([])
    await newSession(page)
    await openTitledSession(page, `${MIXED_CLARIFY_TRIGGER} compute-host-first`)

    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect(settled).toHaveCount(1)
    await waitForFinalSettled(settled, 3)
    expect((await readDraftRows(settled)).map(({ content, question }) => ({ content, question }))).toEqual(MIXED_DRAFT_ROWS)

    await settled.getByRole('button', { name: RECALL }).click()
    const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')
    await recovered.waitFor({ state: 'visible', timeout: 20_000 })
    expect((await readDraftRows(recovered)).map(({ content, question }) => ({ content, question }))).toEqual(MIXED_DRAFT_ROWS)
    expect(serverDraftRecords(backendBox.hermesHome).map(entry => entry.requestId)).toEqual([stored.requestId])
    await shot(page, 'native-compute-host-05-fresh-backend-recalled.png')

    // Explicit discard: the record leaves the backend's disk, and nothing is ever submitted.
    await settled.getByRole('button', { name: 'Discard drafts' }).click()
    await expect(settled.locator('[data-clarify-drafts-discarded]')).toHaveText('Removed from the server.')
    await expect.poll(() => serverDraftRecords(backendBox.hermesHome), { timeout: 20_000 }).toEqual([])
    await shot(page, 'native-compute-host-06-discarded.png')

    expect(submittedDraftText(mock, requestsBefore, [MIXED_TEXT, 'Bravo'])).toEqual([])
    expect(clarifyToolResults(mock, 0)).toHaveLength(1)

    observations.freshBackend = { killedPid, newPid: backend.pid(), oldChild: oldChild?.pid ?? null }
  })
})
