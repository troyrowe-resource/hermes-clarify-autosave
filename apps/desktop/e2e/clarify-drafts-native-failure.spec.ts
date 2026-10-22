/**
 * Native E2E: failed persistence is reported truthfully, never as a save.
 *
 * Real chain as in `clarify-drafts-native-mixed.spec.ts`. The server's draft store is made to fail the same way
 * on every OS: a regular FILE sits where the backend wants the `<HERMES_HOME>/clarify_drafts` directory, so it
 * can never be created (`chmod` means nothing on Windows). The device store is made to fail the way a full or
 * disabled localStorage does: every `setItem` of a draft key throws in the renderer.
 *
 *  1. server store failing, device store working: the card never says "saved"; it says the server has not
 *     confirmed the draft on its disk and that this device keeps it. After the real timeout the rows are
 *     marked "not on the server's disk" (never "confirmed"), a recall finds nothing, and the model is told the
 *     drafts are unsubmitted and not durable.
 *  2. both stores failing: the card says the draft is NOT SAVED anywhere and the settled card says only this
 *     window holds it.
 *  3. device store failing, server store working: the card says the draft is saved on the server only.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { MIXED_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
  DEVICE_KEY_PREFIX,
  deviceDraftEntries,
  liveForms,
  newSession,
  observeDraftStates,
  readAnswers,
  readDraftRows,
  readDraftStatus,
  sendPrompt,
  serverDraftRecords,
  settledCards,
  shot,
  textField,
  toggleChoice,
  typeText,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const CLARIFY_TIMEOUT_SECONDS = 25
const TEXT = 'unsaved ✓ text\n  with a second line  '
const BLOCKER = (hermesHome: string) => path.join(hermesHome, 'clarify_drafts')

test.describe.configure({ mode: 'serial' })

let fixture: MockBackendFixture | null = null
const observations: Record<string, unknown> = { timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraConfig: clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS) })
  await waitForAppReady(fixture!, 120_000)
  // A file where the store's directory must go: creating the directory fails on every platform.
  fs.writeFileSync(BLOCKER(fixture!.sandbox.hermesHome), 'not a directory', 'utf8')
})

test.afterAll(async () => {
  writeObservations('native-failure-observations.json', observations)
  await fixture?.cleanup()
  fixture = null
})

/** A draft of three kinds of edit on a fresh batch form (one pick, one single pick, typed text). */
async function draftSomething(page: MockBackendFixture['page'], label: string) {
  await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} ${label}`)
  const form = await waitForLiveForm(page, 3)
  await toggleChoice(form, 0, 'Bravo')
  await toggleChoice(form, 1, 'Tea')
  await typeText(form, 2, TEXT)
  await expect(textField(form, 2)).toHaveValue(TEXT)

  return form
}

test.describe('clarify drafts (native, failed persistence)', () => {
  test('a server store that cannot write is never reported as saved; this device keeps the draft and the card says so', async () => {
    test.setTimeout(240_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    const form = await draftSomething(page, 'server-fails')

    // Every state the card showed over the next seconds: none of them may be "saved".
    const states = await observeDraftStates(form, 4_000)
    const live = await readDraftStatus(form)
    expect(states, 'the card must never claim a server save the disk did not confirm').not.toContain('saved')
    expect(live.state).toBe('server-unconfirmed')
    expect(live.text).toBe('Draft sent to the server, not yet confirmed on its disk; kept on this device')

    // The truth underneath: nothing is on the server's disk, and this device holds the exact draft.
    expect(serverDraftRecords(sandbox.hermesHome)).toEqual([])
    const device = await deviceDraftEntries(page)
    expect(device).toHaveLength(1)
    expect(JSON.parse(device[0].value).drafts).toMatchObject({
      q0: { choices: ['Bravo'], text: '' },
      q1: { choices: ['Tea'], text: '' },
      q2: { choices: [], text: TEXT }
    })
    await expect(form.locator('button[type="submit"]')).toBeEnabled()
    await shot(page, 'native-failure-01-server-fails-live.png')

    // The real timeout.
    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await expect(liveForms(page)).toHaveCount(0)
    await waitForFinalSettled(settled, 3)

    const answers = await readAnswers(settled)
    answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))
    const rows = await readDraftRows(settled)
    expect(rows.map(row => row.content)).toEqual([['Bravo'], ['Tea'], [TEXT]])
    rows.forEach(row => {
      expect(row.disk, 'a draft the server could not write must never read as confirmed on its disk').toBe('not-on-disk')
      expect(row.transcript).toBe('received')
    })
    await expect(settled).toContainText('The server reported this draft is not saved to its disk')
    await expect(settled).not.toContainText('Autosave confirmed')

    // Recall finds nothing on the server: there is nothing to find.
    await settled.getByRole('button', { name: /Show drafts saved on the server/ }).click()
    await expect(settled.locator('[data-clarify-drafts-recall="none"]')).toBeVisible({ timeout: 15_000 })
    await expect(settled.locator('[data-clarify-drafts-recovered="exact"]')).toHaveCount(0)
    await shot(page, 'native-failure-02-server-fails-settled.png')

    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('timed_out')
    expect(told.drafts_submitted).toBe(false)
    expect(told.drafts_durable).toBe(false)
    expect(told.responses.every(response => response.status === 'unanswered' && response.user_response === null)).toBe(true)

    observations.serverFails = { liveState: live, modelReceived: told, rows, statesObserved: states }
  })

  test('with both stores failing the card says the draft is not saved anywhere, and the settled card says only this window holds it', async () => {
    test.setTimeout(240_000)
    const { page } = fixture!

    // A full or disabled localStorage: every draft write is refused.
    await page.evaluate(prefix => {
      const original = Storage.prototype.setItem

      Storage.prototype.setItem = function (key: string, value: string) {
        if (String(key).startsWith(prefix)) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        }

        return original.call(this, key, value)
      }
    }, DEVICE_KEY_PREFIX)

    await newSession(page)
    const form = await draftSomething(page, 'both-fail')

    const states = await observeDraftStates(form, 4_000)
    const live = await readDraftStatus(form)
    expect(states).not.toContain('saved')
    expect(states).not.toContain('device-only')
    expect(live.state).toBe('not-saved')
    expect(live.text).toBe(
      'Not saved: this device could not store your latest changes and the server has not confirmed them. Copy your text before the form closes.'
    )
    expect(serverDraftRecords(fixture!.sandbox.hermesHome)).toEqual([])
    expect(await deviceDraftEntries(page)).toEqual([])
    await expect(textField(form, 2)).toHaveValue(TEXT)
    await shot(page, 'native-failure-03-both-fail-live.png')

    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await waitForFinalSettled(settled, 3)
    expect((await readDraftRows(settled)).map(row => row.content)).toEqual([['Bravo'], ['Tea'], [TEXT]])
    await expect(settled.locator('[data-clarify-drafts-memory-only]')).toContainText(
      'This device could not store these drafts: only this window holds them. Copy them now.'
    )
    await shot(page, 'native-failure-04-both-fail-settled.png')

    observations.bothFail = { liveState: live, statesObserved: states }
  })

  test('with only the device store failing the card says the draft is saved on the server only', async () => {
    test.setTimeout(240_000)
    const { page, sandbox } = fixture!

    // The server's disk works again (the blocking file is gone); the device refusal from the last test stays.
    fs.rmSync(BLOCKER(sandbox.hermesHome), { force: true })

    await newSession(page)
    const form = await draftSomething(page, 'device-fails')

    await waitForDraftState(form, 'server-only')
    const live = await readDraftStatus(form)
    expect(live.text).toBe('Draft saved on the server only: this device could not store a copy')
    expect(await deviceDraftEntries(page)).toEqual([])

    const [stored] = await waitForServerRecords(sandbox.hermesHome, 1)
    expect(stored.record.drafts.q2.text).toBe(TEXT)
    await shot(page, 'native-failure-05-device-fails-live.png')

    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await waitForFinalSettled(settled, 3)
    const rows = await readDraftRows(settled)
    expect(rows.map(row => row.content)).toEqual([['Bravo'], ['Tea'], [TEXT]])
    rows.forEach(row => expect(row.disk).toBe('confirmed'))
    await shot(page, 'native-failure-06-device-fails-settled.png')

    observations.deviceFails = { liveState: live, rows }
  })
})
