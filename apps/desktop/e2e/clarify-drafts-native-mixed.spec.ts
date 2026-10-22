/**
 * Native E2E: clarify drafts with a multi-select, a single-select and a free-text question.
 *
 * Real chain: composer -> candidate `hermes gateway` (the app's local canonical gateway, sandbox HERMES_HOME)
 * -> agent -> clarify tool -> ONE batch `clarify` request -> native Electron renderer. The mock inference
 * server only scripts the model's tool call and records what the model is sent. `agent.clarify_timeout` is a
 * short value in the sandbox config, so every timeout here is the product's own real wait, not a stub.
 *
 *  1. picks, deselections, edits and multiline Unicode text with trailing spaces, never confirmed: the real
 *     timeout leaves EXACTLY the final state as drafts (a deselected choice appears nowhere), never as
 *     answers; the server's disk copy, the settled card, the explicit recall and what the model received
 *     (`drafts_submitted: false`, no answer) all agree.
 *  2. Confirm is the only submission: the locks reach the model as answers and supersede the drafts on the
 *     server's disk and on this device.
 *  3. Scope separation: a second session asking the IDENTICAL batch (same questions, same question ids) starts
 *     with none of the first session's drafts and ends with only its own.
 */

import { MIXED_CLARIFY_QUESTIONS, MIXED_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import {
  clarifyTimeoutConfig,
  clarifyToolResults,
  deviceDraftEntries,
  draftStatus,
  liveForms,
  newSession,
  observeDraftStates,
  pickedChoices,
  questionBlock,
  readAnswers,
  readDraftRows,
  readDraftStatus,
  retypeText,
  sendPrompt,
  serverDraftRecords,
  settledCards,
  shot,
  textField,
  toggleChoice,
  typeText,
  userMessages,
  waitForDraftState,
  waitForFinalSettled,
  waitForLiveForm,
  waitForServerRecords,
  writeObservations
} from './clarify-drafts-helpers'
import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const CLARIFY_TIMEOUT_SECONDS = 45
const QUESTIONS = MIXED_CLARIFY_QUESTIONS.map(entry => entry.question)

// Unicode (BMP and astral), a newline, an indented line and trailing spaces on a line and at the end.
const FREE_TEXT = 'Line one ✓ ünï©ödé 🙂  \n  indented second line\nlast line, trailing spaces   '
const NOTE = 'also: δelta  '

test.describe.configure({ mode: 'serial' })

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraConfig: clarifyTimeoutConfig(CLARIFY_TIMEOUT_SECONDS) })
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

/** What the first session's drafts end as; the third test must not see any of it. */
let firstSession: { requestId: string; rows: { content: string[]; question: string }[] } | null = null

test.describe('clarify drafts (native, mixed question kinds)', () => {
  test('picks, deselections, edits and multiline text survive a real timeout as drafts, never answers; the model is told they are unsubmitted', async () => {
    test.setTimeout(300_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length

    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} first`)
    const form = await waitForLiveForm(page, 3)

    // The three kinds of question: multi-select, single-select, free text (no choice rows at all).
    await expect(questionBlock(form, 0).locator('[data-clarify-select-mode]')).toHaveAttribute('data-clarify-select-mode', 'multi')
    await expect(questionBlock(form, 1).locator('[data-clarify-select-mode]')).toHaveAttribute('data-clarify-select-mode', 'single')
    await expect(questionBlock(form, 2).locator('button[data-choice]')).toHaveCount(0)

    // Q1, multi-select: pick A, B and C, then deselect A; typed text rides alongside the picks.
    await toggleChoice(form, 0, 'Alpha')
    await toggleChoice(form, 0, 'Bravo')
    await toggleChoice(form, 0, 'Charlie')
    await toggleChoice(form, 0, 'Alpha')
    expect(await pickedChoices(form, 0)).toEqual(['Bravo', 'Charlie'])
    await typeText(form, 0, NOTE)
    expect(await pickedChoices(form, 0)).toEqual(['Bravo', 'Charlie'])

    // Q2, single-select: Coffee, replaced by Tea; typing clears the pick; picking Tea again clears the typing.
    await toggleChoice(form, 1, 'Coffee')
    await toggleChoice(form, 1, 'Tea')
    expect(await pickedChoices(form, 1)).toEqual(['Tea'])
    await typeText(form, 1, 'oops')
    expect(await pickedChoices(form, 1)).toEqual([])
    await toggleChoice(form, 1, 'Tea')
    expect(await pickedChoices(form, 1)).toEqual(['Tea'])
    await expect(textField(form, 1)).toHaveValue('')

    // Q3, free text: type, then replace everything with the final multiline text.
    await typeText(form, 2, 'first draft, to be replaced')
    await retypeText(form, 2, FREE_TEXT)
    await expect(textField(form, 2)).toHaveValue(FREE_TEXT)

    // The card says "saved" only when the server's disk holds the NEWEST revision of every draft.
    await waitForDraftState(form, 'saved')
    const liveStatus = await readDraftStatus(form)
    const [stored] = await waitForServerRecords(sandbox.hermesHome, 1)

    const storedDrafts = Object.fromEntries(
      Object.entries(stored.record.drafts).map(([qid, draft]) => [qid, { choices: draft.choices, text: draft.text }])
    )

    expect(stored.gateway).toBe('session_owner')
    expect(storedDrafts).toEqual({
      q0: { choices: ['Bravo', 'Charlie'], text: NOTE },
      q1: { choices: ['Tea'], text: '' },
      q2: { choices: [], text: FREE_TEXT }
    })
    expect(stored.record.outcome).toBeNull()

    // Nothing was submitted: Confirm is still available and the model has received no tool result.
    await expect(form.locator('button[type="submit"]')).toBeEnabled()
    expect(clarifyToolResults(mock, from)).toEqual([])
    await shot(page, 'mixed-01-live-card.png')

    // The real clarify wait expires (no Confirm was pressed).
    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await expect(liveForms(page)).toHaveCount(0)
    await waitForFinalSettled(settled, 3)

    // Nothing is an answer: every confirmed-answer row is empty.
    const answers = await readAnswers(settled)
    expect(answers).toHaveLength(3)
    answers.forEach(answer => expect(answer).toMatch(/^(No answer|Skipped)$/))

    // The drafts are exactly the final state: A deselected, Coffee replaced, "oops" and the first draft gone.
    const expectedRows = [
      { content: ['Bravo, Charlie', NOTE], question: QUESTIONS[0] },
      { content: ['Tea'], question: QUESTIONS[1] },
      { content: [FREE_TEXT], question: QUESTIONS[2] }
    ]

    const rows = await readDraftRows(settled)
    expect(rows.map(({ content, question }) => ({ content, question }))).toEqual(expectedRows)
    rows.forEach(row => {
      expect(row.disk).toBe('confirmed')
      expect(row.transcript).toBe('received')
    })

    const cardText = await settled.first().innerText()

    for (const gone of ['Alpha', 'Coffee', 'oops', 'first draft']) {
      expect(cardText, `${gone} was deselected or replaced and must appear nowhere`).not.toContain(gone)
    }

    await expect(settled.locator('[data-clarify-drafts]')).toHaveAttribute('data-clarify-drafts', 'server')
    await expect(settled.locator('[data-clarify-drafts]')).toContainText('The assistant was told these are drafts, not answers.')
    await shot(page, 'mixed-02-settled-card.png')

    // Explicit durable recall: a real `clarify.drafts` read gives back the same thing.
    await settled.getByRole('button', { name: /Show drafts saved on the server/ }).click()
    const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')
    await recovered.waitFor({ state: 'visible', timeout: 15_000 })
    expect((await readDraftRows(recovered)).map(({ content, question }) => ({ content, question }))).toEqual(expectedRows)
    await shot(page, 'mixed-03-recalled.png')

    // What the model actually received: drafts beside, never inside, the responses; flagged unsubmitted.
    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('timed_out')
    expect(told.responses.map(response => [response.status, response.user_response])).toEqual([
      ['unanswered', null],
      ['unanswered', null],
      ['unanswered', null]
    ])
    expect(told.drafts_submitted).toBe(false)
    expect(told.drafts_durable).toBe(true)
    expect(told.drafts_request_id).toBe(stored.requestId)
    expect(told.drafts_notice).toMatch(/not answers, not consent/)
    expect(
      told.drafts?.map(({ question_id, selected_choices, typed_text }) => ({ question_id, selected_choices, typed_text }))
    ).toEqual([
      { question_id: 'q0', selected_choices: ['Bravo', 'Charlie'], typed_text: NOTE },
      { question_id: 'q1', selected_choices: ['Tea'], typed_text: '' },
      { question_id: 'q2', selected_choices: [], typed_text: FREE_TEXT }
    ])

    // And nothing was ever sent as the user's own words or as an approval.
    const said = userMessages(mock, from)
    expect(said.filter(text => text.includes(FREE_TEXT) || text.includes('Bravo'))).toEqual([])

    firstSession = { requestId: stored.requestId, rows: expectedRows }
    writeObservations('mixed-observations.json', {
      deviceKeys: (await deviceDraftEntries(page)).map(entry => entry.key),
      liveStatus,
      modelReceived: told,
      rows,
      serverRecord: stored.record,
      timeoutSeconds: CLARIFY_TIMEOUT_SECONDS
    })
  })

  test('Confirm is the only submission: the locks reach the model and supersede the drafts on the server and this device', async () => {
    test.setTimeout(240_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    expect(firstSession, 'the first test leaves its drafts behind').not.toBeNull()

    await newSession(page)
    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} second`)
    const form = await waitForLiveForm(page, 3)

    await toggleChoice(form, 0, 'Alpha')
    await toggleChoice(form, 0, 'Charlie')
    await toggleChoice(form, 1, 'Coffee')
    await typeText(form, 2, 'confirmed answer ✓')
    await waitForDraftState(form, 'saved')

    // Two records now: the first session's drafts and this form's.
    const records = await waitForServerRecords(sandbox.hermesHome, 2)
    const mine = records.find(entry => entry.requestId !== firstSession!.requestId)!
    expect(mine.record.drafts.q0.choices).toEqual(['Alpha', 'Charlie'])
    expect((await deviceDraftEntries(page)).some(entry => entry.key.includes(mine.requestId))).toBe(true)

    // Saving drafts submitted nothing: the model has received no clarify result yet.
    expect(clarifyToolResults(mock, from)).toEqual([])

    await form.locator('button[type="submit"]').click()
    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: 60_000 })
    expect(await readAnswers(settled)).toEqual(['Alpha, Charlie', 'Coffee', 'confirmed answer ✓'])
    await expect(settled.locator('[data-clarify-drafts]')).toHaveCount(0)

    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.outcome).toBe('submitted')
    expect(told.responses.map(response => [response.status, response.user_response])).toEqual([
      ['answered', ['Alpha', 'Charlie']],
      ['answered', 'Coffee'],
      ['answered', 'confirmed answer ✓']
    ])
    expect(told.drafts).toBeUndefined()
    expect(told.drafts_submitted).toBeUndefined()

    // Superseded everywhere: this form's record is gone from the server's disk and from this device;
    // the first session's record is untouched.
    await expect
      .poll(() => serverDraftRecords(sandbox.hermesHome).map(entry => entry.requestId), { timeout: 20_000 })
      .toEqual([firstSession!.requestId])
    expect((await deviceDraftEntries(page)).some(entry => entry.key.includes(mine.requestId))).toBe(false)
    await shot(page, 'mixed-04-confirmed.png')
  })

  test('a second session asking the identical batch starts with none of the first session\'s drafts and ends with only its own', async () => {
    test.setTimeout(300_000)
    const { mock, page, sandbox } = fixture!
    const from = mock.receivedChatRequests.length
    expect(firstSession).not.toBeNull()

    await newSession(page)
    await sendPrompt(page, `${MIXED_CLARIFY_TRIGGER} third`)
    const form = await waitForLiveForm(page, 3)

    // The same questions under the same question ids (q0..q2), a different session: nothing is restored.
    for (const index of [0, 1]) {
      expect(await pickedChoices(form, index)).toEqual([])
    }

    for (const index of [0, 1, 2]) {
      await expect(textField(form, index)).toHaveValue('')
    }

    await expect(draftStatus(form)).toHaveCount(0)
    expect(await observeDraftStates(form, 1_500)).toEqual([])

    await toggleChoice(form, 1, 'Coffee')
    await typeText(form, 2, 'third-session text')
    await waitForDraftState(form, 'saved')

    const records = await waitForServerRecords(sandbox.hermesHome, 2)
    const mine = records.find(entry => entry.requestId !== firstSession!.requestId)!
    expect(mine.record.session_key).not.toBe(records.find(entry => entry.requestId === firstSession!.requestId)!.record.session_key)
    expect(mine.record.drafts.q1.choices).toEqual(['Coffee'])
    expect(mine.record.drafts.q2.text).toBe('third-session text')

    const settled = settledCards(page).filter({ visible: true })
    await settled.first().waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await waitForFinalSettled(settled, 2)
    expect((await readDraftRows(settled)).map(({ content, question }) => ({ content, question }))).toEqual([
      { content: ['Coffee'], question: QUESTIONS[1] },
      { content: ['third-session text'], question: QUESTIONS[2] }
    ])

    // Recall is scoped to THIS request: it returns this session's drafts and none of the first session's.
    await settled.getByRole('button', { name: /Show drafts saved on the server/ }).click()
    const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')
    await recovered.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await recovered.innerText()).not.toContain('Bravo')
    expect(await recovered.innerText()).not.toContain('Line one')

    // The model was told only this session's drafts.
    await expect.poll(() => clarifyToolResults(mock, from).length, { timeout: 30_000 }).toBe(1)
    const [told] = clarifyToolResults(mock, from)
    expect(told.drafts?.map(draft => draft.typed_text)).toEqual(['', 'third-session text'])

    // Going back to the first session, its card still shows its own drafts and nothing of the third's.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: new RegExp(`${MIXED_CLARIFY_TRIGGER} first`) })
      .first()
      .click()
    const first = settledCards(page).filter({ visible: true })
    await first.first().waitFor({ state: 'visible', timeout: 60_000 })
    await waitForFinalSettled(first, 3)
    expect((await readDraftRows(first)).map(({ content, question }) => ({ content, question }))).toEqual(firstSession!.rows)
    expect(await first.first().innerText()).not.toContain('third-session text')
    await shot(page, 'mixed-05-first-session-after-others.png')
  })
})
