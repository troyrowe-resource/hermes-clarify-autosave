/**
 * Native E2E: an app restart, a FRESH backend process, and an explicit discard after a real clarify timeout.
 *
 * Real chain as in `clarify-drafts-native-mixed.spec.ts`; `agent.clarify_timeout` is a short real wait. The
 * drafts of a form that timed out live in three places: the backend's durable store
 * (`<HERMES_HOME>/clarify_drafts/**`), this device's localStorage, and the transcript (what the assistant was
 * told). The app is quit and relaunched on the same sandbox (same HERMES_HOME, same Electron user data); for the
 * fresh-backend scenarios the sandbox's gateway daemon is stopped in between, so the next launch starts a NEW
 * backend process.
 *
 *  1. App restart (same backend): the session reopens with the drafts as drafts, never answers; the device copy,
 *     the transcript and the explicit recall all give back the exact text; nothing was submitted.
 *  2. Fresh backend process and no device copy: the explicit recall still gives back the exact text from the
 *     backend's durable store.
 *  3. Explicit discard: only that request's server record and device copy are removed; after another fresh
 *     backend the recall finds nothing, and nothing was ever submitted.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { MIXED_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
  clearDeviceDrafts,
  deviceDraftEntries,
  liveForms,
  MIXED_DRAFT_ROWS,
  MIXED_NOTE,
  MIXED_SERVER_DRAFTS,
  MIXED_TEXT,
  newSession,
  openSession,
  readAnswers,
  readDraftRows,
  sendPrompt,
  serverDraftRecords,
  settledCards,
  shot,
  stageMixedDraft,
  submittedDraftText,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import { type MockBackendFixture, relaunchDesktop, sandboxGatewayPid, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const CLARIFY_TIMEOUT_SECONDS = 40
const RECALL = /Show drafts saved on the server/
const DRAFT_NEEDLES = [MIXED_TEXT, MIXED_NOTE, 'Bravo']

test.describe.configure({ mode: 'serial' })

let fixture: MockBackendFixture | null = null
const observations: Record<string, unknown> = { timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }

/** The first conversation's request id, left on disk by the first test for the others to find again. */
let firstRequestId = ''

test.beforeAll(async () => {
  // Booting the app on a cold CI runner outlasts the 90 s default test timeout.
  test.setTimeout(300_000)
  fixture = await setupMockBackend({ extraConfig: clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS) })
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  writeObservations('native-restart-observations.json', observations)
  await fixture?.cleanup()
  fixture = null
})

/** Stage the mixed form, never confirm it, and wait for the real timeout to settle the card to its final state. */
async function timeOutMixedForm(label: string, expectedRecords: number) {
  const { mock, page, sandbox } = fixture!
  const from = mock.receivedChatRequests.length

  await newSession(page)
  await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} ${label}`)
  const form = await waitForLiveForm(page, 3)
  await stageMixedDraft(form)
  await waitForDraftState(form, 'saved')

  const records = await waitForServerRecords(sandbox.hermesHome, expectedRecords)
  const settled = settledCards(page).filter({ visible: true })
  await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
  await expect(liveForms(page)).toHaveCount(0)
  await waitForFinalSettled(settled, 3)
  await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)

  return { from, records }
}

/** The settled card on screen now: one card, three draft rows holding exactly what the assistant was told. */
async function expectSettledDrafts(page: MockBackendFixture['page']) {
  const settled = settledCards(page).filter({ visible: true })
  await settled.first().waitFor({ state: 'visible', timeout: 60_000 })
  await expect(settled).toHaveCount(1)
  await expect(liveForms(page)).toHaveCount(0)
  await waitForFinalSettled(settled, 3)

  const answers = await readAnswers(settled)
  expect(answers).toHaveLength(3)
  answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))

  const rows = await readDraftRows(settled)
  expect(rows.map(({ content, question }) => ({ content, question }))).toEqual(MIXED_DRAFT_ROWS)
  rows.forEach(row => expect(row.transcript).toBe('received'))

  return { rows, settled }
}

/** Press the explicit recall and return the rows the backend's durable store gave back. */
async function recallRows(settled: ReturnType<typeof settledCards>) {
  await settled.getByRole('button', { name: RECALL }).click()
  const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')
  await recovered.waitFor({ state: 'visible', timeout: 20_000 })

  return (await readDraftRows(recovered)).map(({ content, question }) => ({ content, question }))
}

test.describe('clarify drafts (native, restart, fresh backend and discard)', () => {
  test('an app restart reopens the timed-out card with the drafts as drafts: device copy, transcript and recall all hold the exact text, nothing is submitted', async () => {
    test.setTimeout((CLARIFY_TIMEOUT_SECONDS + 240) * 1000)
    const { mock, sandbox } = fixture!
    const { records } = await timeOutMixedForm('restart-first', 1)
    const [stored] = records
    firstRequestId = stored.requestId
    const requestsBeforeRestart = mock.receivedChatRequests.length
    const pidBefore = sandboxGatewayPid(sandbox.hermesHome)

    await relaunchDesktop(fixture!)
    const { page } = fixture!
    await openSession(page, `${MIXED_CLARIFY_TRIGGER} restart-first`)
    const { rows, settled } = await expectSettledDrafts(page)
    await shot(page, 'native-restart-01-app-restarted.png')

    // The device copy survived the restart and is exactly the final state.
    const device = await deviceDraftEntries(page)
    expect(device).toHaveLength(1)
    expect(device[0].key).toContain(stored.requestId)

    expect(
      Object.fromEntries(
        Object.entries(JSON.parse(device[0].value).drafts as Record<string, { choices: string[]; text: string }>).map(
          ([qid, draft]) => [qid, { choices: draft.choices, text: draft.text }]
        )
      )
    ).toEqual(MIXED_SERVER_DRAFTS)

    // The explicit recall reads the backend's durable record and agrees.
    expect(await recallRows(settled)).toEqual(MIXED_DRAFT_ROWS)
    await shot(page, 'native-restart-02-recalled.png')

    // Reopening, recalling and restarting submitted nothing: no new user words, no new clarify result.
    expect(submittedDraftText(mock, requestsBeforeRestart, DRAFT_NEEDLES)).toEqual([])
    expect(clarifyToolResults(mock, 0)).toHaveLength(1)
    expect(serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId)).toEqual([stored.requestId])

    // What the daemon recorded about itself (its pid and its canonical HERMES_HOME), kept as evidence.
    const lockFile = path.join(sandbox.hermesHome, 'gateway.lock')

    observations.appRestart = {
      gatewayLock: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null,
      gatewayPidAfter: sandboxGatewayPid(sandbox.hermesHome),
      gatewayPidBefore: pidBefore,
      rows
    }
  })

  test('a fresh backend process with no device copy still recalls the exact text from the durable store', async () => {
    test.setTimeout(300_000)
    const { mock, sandbox } = fixture!
    const requestsBefore = mock.receivedChatRequests.length
    const pidBefore = sandboxGatewayPid(sandbox.hermesHome)
    expect(pidBefore, 'a gateway daemon is running before the restart').not.toBeNull()

    const { stoppedGatewayPid } = await relaunchDesktop(fixture!, { freshBackend: true })
    const pidAfter = sandboxGatewayPid(sandbox.hermesHome)
    expect(stoppedGatewayPid).toBe(pidBefore)
    expect(pidAfter, 'the relaunch started a new backend').not.toBeNull()
    expect(pidAfter, 'a different backend process than the one that took the drafts').not.toBe(pidBefore)

    // Lose this device's copy as well: the backend's record is all that is left to read from.
    const { page } = fixture!
    await clearDeviceDrafts(page)
    expect(await deviceDraftEntries(page)).toEqual([])
    await newSession(page)
    await openSession(page, `${MIXED_CLARIFY_TRIGGER} restart-first`)
    const { settled } = await expectSettledDrafts(page)

    expect(await recallRows(settled)).toEqual(MIXED_DRAFT_ROWS)
    expect(serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId)).toEqual([firstRequestId])
    await shot(page, 'native-restart-03-fresh-backend-recalled.png')

    expect(submittedDraftText(mock, requestsBefore, DRAFT_NEEDLES)).toEqual([])
    expect(clarifyToolResults(mock, 0)).toHaveLength(1)

    observations.freshBackend = { gatewayPidAfter: pidAfter, gatewayPidBefore: pidBefore }
  })

  test('an explicit discard removes only that request\'s copies; after another fresh backend nothing is recalled and nothing was submitted', async () => {
    test.setTimeout((CLARIFY_TIMEOUT_SECONDS + 300) * 1000)
    const { mock, sandbox } = fixture!
    const { from, records } = await timeOutMixedForm('restart-second', 2)
    const second = records.find(entry => entry.requestId !== firstRequestId)!
    const { page } = fixture!

    // This device holds the second form's copy; the first one's was cleared by the last test.
    const device = await deviceDraftEntries(page)
    expect(device.map(entry => entry.key).filter(key => key.includes(second.requestId))).toHaveLength(1)
    expect(device.some(entry => entry.key.includes(firstRequestId))).toBe(false)

    const requestsBeforeDiscard = mock.receivedChatRequests.length
    const settled = settledCards(page).filter({ visible: true })
    await settled.getByRole('button', { name: 'Discard drafts' }).click()
    await expect(settled.locator('[data-clarify-drafts-discarded]')).toHaveText('Removed from this device and the server.')
    await shot(page, 'native-restart-04-discarded.png')

    // Gone from the backend's disk and from this device: only this request's, never the other conversation's.
    await expect
      .poll(() => serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId), { timeout: 20_000 })
      .toEqual([firstRequestId])
    expect((await deviceDraftEntries(page)).some(entry => entry.key.includes(second.requestId))).toBe(false)
    expect(submittedDraftText(mock, requestsBeforeDiscard, DRAFT_NEEDLES)).toEqual([])
    expect(clarifyToolResults(mock, from)).toHaveLength(1)

    // Another fresh backend process: the discarded drafts cannot come back from anywhere.
    const pidBefore = sandboxGatewayPid(sandbox.hermesHome)
    await relaunchDesktop(fixture!, { freshBackend: true })
    expect(sandboxGatewayPid(sandbox.hermesHome)).not.toBe(pidBefore)
    const after = fixture!.page
    await openSession(after, `${MIXED_CLARIFY_TRIGGER} restart-second`)
    const reopened = settledCards(after).filter({ visible: true })
    await reopened.first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect(reopened).toHaveCount(1)
    await expect(liveForms(after)).toHaveCount(0)

    // Never answers, whatever the card shows of the transcript.
    const answers = await readAnswers(reopened)
    expect(answers).toHaveLength(3)
    answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))

    await reopened.getByRole('button', { name: RECALL }).click()
    await expect(reopened.locator('[data-clarify-drafts-recall="none"]')).toBeVisible({ timeout: 20_000 })
    await expect(reopened.locator('[data-clarify-drafts-recovered="exact"]')).toHaveCount(0)
    expect((await deviceDraftEntries(after)).some(entry => entry.key.includes(second.requestId))).toBe(false)
    await shot(after, 'native-restart-05-discard-survives-fresh-backend.png')

    // The first conversation, never discarded, is still intact on the new backend.
    await openSession(after, `${MIXED_CLARIFY_TRIGGER} restart-first`)
    const first = await expectSettledDrafts(after)
    expect(await recallRows(first.settled)).toEqual(MIXED_DRAFT_ROWS)

    expect(submittedDraftText(mock, requestsBeforeDiscard, DRAFT_NEEDLES)).toEqual([])
    observations.discard = { removedRequestId: second.requestId, survivingRequestId: firstRequestId }
  })
})
