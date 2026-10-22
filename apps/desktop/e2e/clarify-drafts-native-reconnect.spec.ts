/**
 * Native E2E: a lost gateway connection and a window reload while a clarify form is open.
 *
 * Real chain as in `clarify-drafts-native-mixed.spec.ts` (composer -> candidate `hermes gateway` -> agent ->
 * clarify tool -> ONE batch `clarify` request -> native Electron renderer, a short real `agent.clarify_timeout`).
 * The renderer's gateway WebSocket is routed through the test process, which can cut it exactly as a lost link
 * would; the whole window is reloaded with `page.reload()`.
 *
 *  1. The unsent picks, deselections and multiline text survive a cut connection and then a reload: the same
 *     single card comes back with the exact state, still unsubmitted, Confirm still possible. With no Confirm the
 *     real timeout then leaves exactly that state as drafts, never answers.
 *  2. After a cut connection Confirm is still the one submission: the locks reach the model as answers and
 *     supersede the drafts on the server and on this device.
 *  3. Edits made while the connection is down are reported truthfully (never as saved), are not lost when
 *     the connection returns, and reach the server without the user typing again.
 */

import { MIXED_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
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
  stageMixedDraft,
  textField,
  typeText,
  userMessages,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForReconnect,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

// Long enough for a cut, a reconnect and a reload on a slow machine; the test then waits out the rest.
const CLARIFY_TIMEOUT_SECONDS = 75

test.describe.configure({ mode: 'serial' })

let fixture: MockBackendFixture | null = null
let link: Awaited<ReturnType<typeof interceptGatewaySocket>>
const observations: Record<string, unknown> = { timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraConfig: clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS) })
  await waitForAppReady(fixture!, 120_000)

  // Only sockets opened after the route exists are routed: reload once so the renderer's connection is one.
  link = await interceptGatewaySocket(fixture!.page)
  await fixture!.page.reload()
  await waitForAppReady(fixture!, 120_000)
  await expect.poll(() => link.opened(), { timeout: 60_000 }).toBeGreaterThan(0)
})

test.afterAll(async () => {
  writeObservations('reconnect-observations.json', observations)
  await fixture?.cleanup()
  fixture = null
})

/** The records on the server's disk, as plain data (revision numbers included), for a before/after comparison. */
const diskRecords = (hermesHome: string) => serverDraftRecords(hermesHome).map(entry => entry.record)

/** Cut the connection and wait for the renderer's own redial: a new accepted socket. */
async function cutAndReconnect(): Promise<void> {
  const before = link.opened()
  link.drop()
  await waitForReconnect(link, before)
}

test.describe('clarify drafts (native, reconnect and reload)', () => {
  test('the same card and the exact unsent state survive a lost connection and a reload; a real timeout still leaves drafts, never answers', async () => {
    test.setTimeout((CLARIFY_TIMEOUT_SECONDS + 210) * 1000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length

    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} reconnect-first`)
    const form = await waitForLiveForm(page, 3)
    const staged = await stageMixedDraft(form)
    await waitForDraftState(form, 'saved')
    expect(await readFormState(form)).toEqual(staged)

    const [stored] = await waitForServerRecords(sandbox.hermesHome, 1)
    expect(stored.gateway).toBe('session_owner')
    await shot(page, 'reconnect-01-before-drop.png')

    // The connection is cut; the renderer redials by itself.
    await cutAndReconnect()
    const afterDrop = await waitForLiveForm(page, 3)
    expect(await readFormState(afterDrop), 'the edits are exactly as they were before the connection was lost').toEqual(staged)
    await waitForDraftState(afterDrop, 'saved')
    await expect(afterDrop.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from), 'a lost connection submits nothing').toEqual([])
    expect(diskRecords(sandbox.hermesHome), 'the server copy is untouched').toEqual([stored.record])
    await shot(page, 'reconnect-02-after-drop.png')

    // The whole window is reloaded with the form open: the replayed request brings the same card back.
    await page.reload()
    await waitForAppReady(fixture!, 120_000)
    const afterReload = await waitForLiveForm(page, 3)
    expect(await readFormState(afterReload), 'the edits survive a reload exactly').toEqual(staged)

    // The status line is rebuilt from what THIS window has seen acknowledged: after a reload it says nothing
    // until the next save, and it never claims anything but a confirmed save.
    expect([null, 'saved']).toContain((await readDraftStatus(afterReload)).state)
    await expect(afterReload.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from), 'a reload submits nothing').toEqual([])
    expect(diskRecords(sandbox.hermesHome)).toEqual([stored.record])
    await shot(page, 'reconnect-03-after-reload.png')

    // No Confirm: the real clarify wait expires and the card settles once.
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
    rows.forEach(row => {
      expect(row.disk).toBe('confirmed')
      expect(row.transcript).toBe('received')
    })
    await shot(page, 'reconnect-04-settled.png')

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
    expect(userMessages(mock, from).filter(text => text.includes(MIXED_TEXT) || text.includes('Bravo'))).toEqual([])

    observations.cutAndReload = { modelReceived: told, rows, socketsOpened: link.opened(), staged }
  })

  test('after a lost connection Confirm is still the one submission: the locks reach the model and supersede the drafts', async () => {
    test.setTimeout(240_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    const [first] = serverDraftRecords(sandbox.hermesHome)

    await newSession(page)
    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} reconnect-second`)
    const form = await waitForLiveForm(page, 3)

    const choose = async (index: number, labels: string[]) => {
      for (const label of labels) {
        await form.locator('[data-clarify-batch-question]').nth(index).locator('button[data-choice]').filter({ hasText: label }).click()
      }
    }

    await choose(0, ['Alpha', 'Charlie'])
    await choose(1, ['Coffee'])
    await typeText(form, 2, 'confirmed after reconnect ✓')
    await waitForDraftState(form, 'saved')
    const staged = await readFormState(form)
    const mine = (await waitForServerRecords(sandbox.hermesHome, 2)).find(entry => entry.requestId !== first.requestId)!

    await cutAndReconnect()
    const again = await waitForLiveForm(page, 3)
    expect(await readFormState(again)).toEqual(staged)
    expect(clarifyToolResults(mock, from)).toEqual([])

    await again.locator('button[type="submit"]').click()
    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect(settled).toHaveCount(1)
    expect(await readAnswers(settled)).toEqual(['Alpha, Charlie', 'Coffee', 'confirmed after reconnect ✓'])
    await expect(settled.locator('[data-clarify-drafts]')).toHaveCount(0)

    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('submitted')
    expect(told.responses.map(response => [response.status, response.user_response])).toEqual([
      ['answered', ['Alpha', 'Charlie']],
      ['answered', 'Coffee'],
      ['answered', 'confirmed after reconnect ✓']
    ])
    expect(told.drafts).toBeUndefined()

    await expect
      .poll(() => serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId), { timeout: 20_000 })
      .toEqual([first.requestId])
    expect((await deviceDraftEntries(page)).some(entry => entry.key.includes(mine.requestId))).toBe(false)
    await shot(page, 'reconnect-05-confirmed-after-drop.png')

    observations.confirmAfterDrop = { modelReceived: told }
  })

  test('edits made while the connection is down are reported as unsent, never as saved, and reach the server when it returns', async () => {
    test.setTimeout(240_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    const before = serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId)
    const mineOnDisk = () => serverDraftRecords(sandbox.hermesHome).find(entry => !before.includes(entry.requestId))

    await newSession(page)
    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} reconnect-third`)
    const form = await waitForLiveForm(page, 3)
    await typeText(form, 2, 'typed while online')
    await waitForDraftState(form, 'saved')

    // The network goes down and stays down; the user keeps typing.
    const opened = link.opened()
    link.down()
    await typeText(form, 2, ' + typed while offline ✓')
    const offlineText = 'typed while online + typed while offline ✓'
    await expect(textField(form, 2)).toHaveValue(offlineText)

    // Never "saved" for text the server cannot have: the card says it is kept on this device only.
    await waitForDraftState(form, 'device-only')
    const offline = await readDraftStatus(form)
    const device = await deviceDraftEntries(page)
    expect(device.some(entry => JSON.parse(entry.value).drafts?.q2?.text === offlineText)).toBe(true)
    expect(mineOnDisk()?.record.drafts.q2.text, 'the server has only what was typed while online').toBe('typed while online')
    await shot(page, 'reconnect-06-offline-edit.png')

    // The network returns: the renderer redials, the card is the same, and the text is still all there.
    link.restore()
    await waitForReconnect(link, opened)
    const again = await waitForLiveForm(page, 3)
    await expect(textField(again, 2)).toHaveValue(offlineText)

    // The server ends up holding the newest text without the user typing again, and only then does the card say saved.
    await expect
      .poll(() => mineOnDisk()?.record.drafts.q2?.text, {
        message: 'the edit made offline reaches the server after the reconnect',
        timeout: 30_000
      })
      .toBe(offlineText)
    await waitForDraftState(again, 'saved')
    await shot(page, 'reconnect-07-offline-edit-synced.png')

    // Nothing was submitted by any of it; Confirm is what submits, and it carries the newest text.
    expect(clarifyToolResults(mock, from)).toEqual([])
    await again.locator('button[type="submit"]').click()
    await settledCards(page).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('submitted')
    expect(told.responses[2]).toMatchObject({ status: 'answered', user_response: offlineText })

    observations.offlineEdit = { modelReceived: told, statusWhileOffline: offline }
  })

  test('a whole draft made while the connection is down, from the very first edit, reaches the server when it returns', async () => {
    test.setTimeout(240_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    const before = serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId)
    const mineOnDisk = () => serverDraftRecords(sandbox.hermesHome).find(entry => !before.includes(entry.requestId))

    await newSession(page)
    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} reconnect-fourth`)
    const form = await waitForLiveForm(page, 3)

    // Nothing has been edited yet, so the server holds no draft at all; the network goes down.
    const opened = link.opened()
    link.down()
    await toggleChoice(form, 1, 'Tea')
    await typeText(form, 2, MIXED_TEXT)
    await expect(textField(form, 2)).toHaveValue(MIXED_TEXT)
    await waitForDraftState(form, 'device-only')
    expect(await observeDraftStates(form, 1_500)).toEqual([])
    expect(mineOnDisk(), 'the server has nothing yet').toBeUndefined()

    link.restore()
    await waitForReconnect(link, opened)
    const again = await waitForLiveForm(page, 3)
    expect(await readFormState(again)).toEqual({ picks: [[], ['Tea'], []], texts: ['', '', MIXED_TEXT] })

    await expect
      .poll(() => mineOnDisk()?.record.drafts, {
        message: 'a draft made entirely offline reaches the server after the reconnect',
        timeout: 30_000
      })
      .toMatchObject({ q1: { choices: ['Tea'], text: '' }, q2: { choices: [], text: MIXED_TEXT } })
    expect(mineOnDisk()?.record.drafts.q0, 'an untouched question has no draft').toBeUndefined()
    await waitForDraftState(again, 'saved')

    expect(clarifyToolResults(mock, from)).toEqual([])
    await again.locator('button[type="submit"]').click()
    await settledCards(page).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('submitted')
    expect(told.responses[1]).toMatchObject({ status: 'answered', user_response: 'Tea' })

    observations.firstEditOffline = { modelReceived: told }
  })
  })
})
