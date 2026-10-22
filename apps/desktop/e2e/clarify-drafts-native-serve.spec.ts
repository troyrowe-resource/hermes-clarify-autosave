/**
 * Native E2E: clarify drafts against a REMOTE `hermes serve` backend (the legacy sidecar path).
 *
 * The Desktop is attached by URL + token to a real `hermes serve` the TEST spawns under its own HOME and
 * HERMES_HOME (the shape of a Desktop talking to a backend on another machine): no local backend is started
 * for the client. The sidecar always asks a clarify batch as one server request and keeps the drafts in its own
 * durable store (`<backend HERMES_HOME>/clarify_drafts/tui_gateway/**`). Only the LLM is scripted; the clarify
 * wait is the product's own, shortened with `agent.clarify_timeout` in the BACKEND's config.
 *
 *  1. A cut connection and a reload with the form open: the sidecar replays the open request with its drafts and
 *     the same card returns with the exact unsent state, unsubmitted; the real timeout then leaves drafts, never
 *     answers, and the model is told exactly that.
 *  2. A freshly started backend process (the old one killed): the explicit recall reads the exact text from the
 *     durable store with no device copy; an explicit discard removes the record from the backend's disk.
 */

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
  openSession,
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

test.describe.configure({ mode: 'serial' })

let mock: MockServer
let backendBox: CoreSandbox
let backend: RemoteBackend
let client: NoProviderFixture
let link: SocketLink
const observations: Record<string, unknown> = { timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }

test.beforeAll(async () => {
  mock = await startMockServer()
  backendBox = createCoreSandbox('serve-backend')
  writeMockProviderConfig(backendBox.hermesHome, mock.url, undefined, clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS))
  writeEnvFile(backendBox.hermesHome)
  backend = await startRemoteBackend(backendBox)

  const sandbox = createSandbox('serve-client')
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
  observations.backendLogTail = backend?.logTail()
  writeObservations('native-serve-observations.json', observations)
  await client?.app.close().catch(() => undefined)
  await backend?.kill()
  preserveSandboxLogs(backendBox)
  await mock?.close()
  client?.sandbox.cleanup()
  backendBox?.cleanup()
})

test.describe('clarify drafts (native, remote hermes serve backend)', () => {
  test('a cut connection and a reload bring the same card back with the exact unsent state; a real timeout leaves drafts, never answers', async () => {
    test.setTimeout((CLARIFY_TIMEOUT_SECONDS + 240) * 1000)
    const { page } = client
    const from = mock.receivedChatRequests.length

    // The client really talks to the remote backend and started no backend of its own.
    expect(new URL(link.urls()[0]).port).toBe(String(backend.port))
    expect(sandboxGatewayPid(client.sandbox.hermesHome)).toBeNull()

    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} serve-first`)
    const form = await waitForLiveForm(page, 3)
    const staged = await stageMixedDraft(form)
    await waitForDraftState(form, 'saved')

    // The sidecar keeps its own durable record, under its own store, in the BACKEND's home.
    const [stored] = await waitForServerRecords(backendBox.hermesHome, 1)
    expect(stored.gateway).toBe('tui_gateway')
    expect(stored.record.drafts.q2.text).toBe(MIXED_TEXT)
    await shot(page, 'native-serve-01-live-card.png')

    // A cut connection: the renderer redials and the sidecar replays the open request with its drafts.
    const opened = link.opened()
    link.drop()
    await waitForReconnect(link, opened)
    const afterDrop = await waitForLiveForm(page, 3)
    expect(await readFormState(afterDrop), 'the edits are exactly as they were before the cut').toEqual(staged)
    await expect(afterDrop.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from)).toEqual([])
    expect(serverDraftRecords(backendBox.hermesHome).map(entry => entry.record)).toEqual([stored.record])
    await shot(page, 'native-serve-02-after-drop.png')

    // A reload of the whole window with the form open.
    await page.reload()
    await waitForAppReady(client, 120_000)
    const afterReload = await waitForLiveForm(page, 3)
    expect(await readFormState(afterReload), 'the edits survive a reload exactly').toEqual(staged)
    expect([null, 'saved']).toContain((await readDraftStatus(afterReload)).state)
    await expect(afterReload.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from)).toEqual([])
    await shot(page, 'native-serve-03-after-reload.png')

    // No Confirm: the backend's real clarify wait expires.
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
    await shot(page, 'native-serve-04-settled.png')

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

    observations.cutAndReload = { modelReceived: told, rows, socketUrls: link.urls().length, staged }
  })

  test('a freshly started backend process recalls the exact text from its durable store with no device copy; an explicit discard removes it', async () => {
    test.setTimeout(300_000)
    const { page } = client
    const [stored] = serverDraftRecords(backendBox.hermesHome)
    const requestsBefore = mock.receivedChatRequests.length

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
    await openSession(page, `${MIXED_CLARIFY_TRIGGER} serve-first`)

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
    await shot(page, 'native-serve-05-fresh-backend-recalled.png')

    // Explicit discard: the record leaves the backend's disk, and nothing is ever submitted.
    await settled.getByRole('button', { name: 'Discard drafts' }).click()
    await expect(settled.locator('[data-clarify-drafts-discarded]')).toHaveText('Removed from the server.')
    await expect.poll(() => serverDraftRecords(backendBox.hermesHome), { timeout: 20_000 }).toEqual([])
    await shot(page, 'native-serve-06-discarded.png')

    expect(submittedDraftText(mock, requestsBefore, [MIXED_TEXT, 'Bravo'])).toEqual([])
    expect(clarifyToolResults(mock, 0)).toHaveLength(1)

    observations.freshBackend = { killedPid, newPid: backend.pid() }
  })
})
