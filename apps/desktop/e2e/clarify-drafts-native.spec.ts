/**
 * Native E2E: unsent clarify drafts survive a REAL timeout.
 *
 * Real chain: composer -> isolated `hermes serve` (candidate source) -> agent ->
 * clarify tool -> clarify.request -> native Electron renderer. The mock
 * inference server only scripts the model's tool call. The fixture sets a
 * short `agent.clarify_timeout` inside its own sandbox HERMES_HOME.
 *
 * The user picks a choice and types an Other answer but NEVER presses Confirm.
 * After the wait times out, the settled card must show the exact unsent picks
 * and text as drafts (not answers), and the server's durable copy must be
 * recallable through `clarify.drafts`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { BATCH_CLARIFY_QUESTIONS, BATCH_CLARIFY_TRIGGER } from '../../../tests-js/scripts/mock-server'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const CLARIFY_TIMEOUT_SECONDS = 25
const OTHER_TEXT = 'Native draft: line one ✓\nline two (unsent)'
const EVIDENCE = process.env.HERMES_E2E_EVIDENCE_DIR

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraConfig: `agent:\n  clarify_timeout: ${CLARIFY_TIMEOUT_SECONDS}\n` })
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('clarify drafts (native)', () => {
  test('a real timeout keeps the unsent pick and typed text as recoverable drafts, never answers', async () => {
    test.setTimeout(180_000)
    const page = fixture!.page
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type(BATCH_CLARIFY_TRIGGER, { delay: 20 })
    await page.keyboard.press('Enter')

    const card = page.locator('form[data-clarify-batch]')
    await card.first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect(card).toHaveCount(1)

    // Q1: pick a choice. Q2: type an Other answer (Unicode + newline). No Confirm.
    await card.getByRole('button', { name: /Tea/ }).click()
    const others = card.getByPlaceholder(/Other/)
    await others.nth(1).fill(OTHER_TEXT)

    // The autosave status line appears; record exactly what it claimed.
    const status = card.locator('[data-clarify-draft-state]')
    await status.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(2_000)
    const liveState = await status.getAttribute('data-clarify-draft-state')
    const liveText = await status.textContent()
    await expect(card.locator('button[type="submit"]')).toBeEnabled()

    if (EVIDENCE) {
      await page.screenshot({ path: path.join(EVIDENCE, 'native-01-live-card.png') })
    }

    // The real clarify wait expires (no Confirm was pressed).
    const settled = page.locator('[data-clarify-settled]')
    await settled.waitFor({ state: 'visible', timeout: (CLARIFY_TIMEOUT_SECONDS + 60) * 1000 })
    await expect(page.locator('form[data-clarify-batch]')).toHaveCount(0)

    // Nothing was submitted: both confirmed-answer rows are empty.
    await expect(settled.locator('[data-clarify-answer]')).toHaveCount(BATCH_CLARIFY_QUESTIONS.length)
    for (const answer of await settled.locator('[data-clarify-answer]').allTextContents()) {
      expect(answer).not.toContain('Tea')
      expect(answer).not.toContain('Native draft')
    }

    // The unsent drafts are visible, exactly.
    const drafts = settled.locator('[data-clarify-drafts]')
    await drafts.waitFor({ state: 'visible', timeout: 15_000 })
    const rows = drafts.locator('[data-clarify-draft]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Tea')
    expect(await rows.nth(1).textContent()).toContain(OTHER_TEXT)
    const rowStates = await rows.evaluateAll(nodes =>
      nodes.map(node => ({
        disk: node.getAttribute('data-clarify-draft-disk'),
        transcript: node.getAttribute('data-clarify-draft-transcript')
      }))
    )

    if (EVIDENCE) {
      await page.screenshot({ path: path.join(EVIDENCE, 'native-02-timed-out-card.png') })
    }

    // Durable recall: a real `clarify.drafts` read against the isolated backend.
    await drafts.getByRole('button', { name: /Show drafts saved on the server/ }).click()
    const recovered = settled.locator('[data-clarify-drafts-recovered="exact"]')
    await recovered.waitFor({ state: 'visible', timeout: 15_000 })
    await expect(recovered).toContainText('Tea')
    expect(await recovered.textContent()).toContain(OTHER_TEXT)

    if (EVIDENCE) {
      await page.screenshot({ path: path.join(EVIDENCE, 'native-03-recalled.png') })
      fs.writeFileSync(
        path.join(EVIDENCE, 'native-observations.json'),
        JSON.stringify({ liveState, liveText, rowStates, timeoutSeconds: CLARIFY_TIMEOUT_SECONDS }, null, 2)
      )
    }
  })
})
