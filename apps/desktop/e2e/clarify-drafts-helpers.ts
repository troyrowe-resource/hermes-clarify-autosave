/**
 * Shared helpers for the native clarify-draft acceptance specs (`clarify-drafts-native-*.spec.ts`).
 *
 * Everything here observes the REAL product: the live batch form (`form[data-clarify-batch]`), the settled
 * card (`[data-clarify-settled]`), the renderer's device store (localStorage), the sandbox backend's durable
 * store (`<HERMES_HOME>/clarify_drafts/**`) and what the mock model actually received. Nothing is stubbed.
 *
 * Waits are on observable facts (a status attribute, a file, a row) with a deadline, never on a fixed sleep.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Locator, Page } from '@playwright/test'

import type { MockServer } from '../../../tests-js/scripts/mock-server'

import { expect } from './test'

export const EVIDENCE = process.env.HERMES_E2E_EVIDENCE_DIR

/** Config for a short, real clarify wait (the product's own `agent.clarify_timeout`). */
export const clarifyTimeoutConfig = (seconds: number): string => `agent:\n  clarify_timeout: ${seconds}\n`

/** The drafts' device-store key prefix (`store/clarify-drafts.ts`). */
export const DEVICE_KEY_PREFIX = 'hermes.clarifyDrafts.v2/'

// ─── Evidence ──────────────────────────────────────────────────────────

export async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE) {
    await page.screenshot({ path: path.join(EVIDENCE, name) })
  }
}

export function writeObservations(name: string, data: unknown): void {
  if (EVIDENCE) {
    fs.mkdirSync(EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}

// ─── The composer and the live form ────────────────────────────────────

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

/** Start a fresh chat (an empty history), so a scripted clarify trigger fires again. */
export async function newSession(page: Page): Promise<void> {
  await page.locator('button:has-text("New session")').first().click()
}

export const liveForms = (page: Page): Locator => page.locator('form[data-clarify-batch]')

/** The one live batch form with `questions` entries, once the gateway's request has armed it. */
export async function waitForLiveForm(page: Page, questions: number, timeout = 90_000): Promise<Locator> {
  const form = liveForms(page).filter({ visible: true })
  await form.first().waitFor({ state: 'visible', timeout })
  await expect(form).toHaveCount(1)
  await expect(form).toHaveAttribute('data-clarify-batch', String(questions))
  await expect(form.locator('[data-clarify-batch-question]')).toHaveCount(questions)
  // A preview form (tool args, request not yet live) is disabled; wait for the live one.
  await expect(form).not.toHaveAttribute('data-clarify-batch-preview', /.*/)

  return form
}

export const questionBlock = (form: Locator, index: number): Locator =>
  form.locator('[data-clarify-batch-question]').nth(index)

export const choiceButton = (form: Locator, index: number, label: string): Locator =>
  questionBlock(form, index).locator('button[data-choice]').filter({ hasText: label })

export const textField = (form: Locator, index: number): Locator => questionBlock(form, index).locator('textarea')

export async function toggleChoice(form: Locator, index: number, label: string): Promise<void> {
  await choiceButton(form, index, label).click()
}

/** The picked labels of one question, bare (the "(Recommended)" suffix and the key letter stripped). */
export async function pickedChoices(form: Locator, index: number): Promise<string[]> {
  return questionBlock(form, index)
    .locator('button[data-choice]')
    .evaluateAll(buttons =>
      buttons
        .filter(button => button.getAttribute('aria-pressed') === 'true')
        .map(button => (button.querySelector('span')?.textContent ?? '').replace(/\s*\(Recommended\)\s*$/, ''))
    )
}

/** Type like a person: real key events, Enter for a newline. */
export async function typeText(form: Locator, index: number, text: string): Promise<void> {
  const field = textField(form, index)
  await field.click()
  await field.pressSequentially(text, { delay: 3 })
}

/** Replace what the field holds with `text`, by selecting it all and typing over it. */
export async function retypeText(form: Locator, index: number, text: string): Promise<void> {
  const field = textField(form, index)
  await field.click()
  await field.press('ControlOrMeta+A')
  await field.press('Delete')
  await field.pressSequentially(text, { delay: 3 })
}

export const draftStatus = (form: Locator): Locator => form.locator('[data-clarify-draft-state]')

export async function readDraftStatus(form: Locator): Promise<{ state: null | string; text: null | string }> {
  const status = draftStatus(form)

  if ((await status.count()) === 0) {
    return { state: null, text: null }
  }

  return { state: await status.getAttribute('data-clarify-draft-state'), text: await status.textContent() }
}

/** Wait for the status line to say exactly `state` (e.g. `saved`: the server confirmed the newest edit on its disk). */
export async function waitForDraftState(form: Locator, state: string, timeout = 20_000): Promise<void> {
  await expect(draftStatus(form)).toHaveAttribute('data-clarify-draft-state', state, { timeout })
}

/**
 * Sample the status line for `windowMs` and return every distinct state seen, in order: a claim the card made
 * even for an instant (a "saved" before the disk confirmed it) must show up here.
 */
export async function observeDraftStates(form: Locator, windowMs: number): Promise<string[]> {
  const seen: string[] = []

  await expect
    .poll(
      async () => {
        const { state } = await readDraftStatus(form)

        if (state && seen.at(-1) !== state) {
          seen.push(state)
        }

        return false
      },
      { timeout: windowMs, intervals: [50] }
    )
    .toBe(true)
    .catch(() => undefined)

  return seen
}

// ─── The settled card ──────────────────────────────────────────────────

export const settledCards = (page: Page): Locator => page.locator('[data-clarify-settled]')

export interface DraftRowSnapshot {
  /** The row's content spans after the question, verbatim: the picked choices joined by ", ", then the typed text. */
  content: string[]
  disk: null | string
  question: string
  transcript: null | string
}

/** Every draft row under `scope` (the settled card, or its drafts panel), text read verbatim. */
export async function readDraftRows(scope: Locator): Promise<DraftRowSnapshot[]> {
  return scope.locator('[data-clarify-draft]').evaluateAll(nodes =>
    nodes.map(node => {
      const kids = Array.from(node.children) as HTMLElement[]

      return {
        content: kids
          .slice(1, -1)
          .filter(kid => !kid.hasAttribute('data-clarify-draft-device-only'))
          .map(kid => kid.textContent ?? ''),
        disk: node.getAttribute('data-clarify-draft-disk'),
        question: kids[0]?.textContent ?? '',
        transcript: node.getAttribute('data-clarify-draft-transcript')
      }
    })
  )
}

/** The text of every confirmed-answer row of a settled card. */
export const readAnswers = (settled: Locator): Promise<string[]> => settled.locator('[data-clarify-answer]').allTextContents()

/**
 * The FINAL settled state: the card first paints from this device's copy, then `tool.complete` lands the
 * result the assistant was told. Wait until every draft row says what the assistant received.
 */
export async function waitForFinalSettled(settled: Locator, rows: number, timeout = 30_000): Promise<void> {
  const drafts = settled.locator('[data-clarify-draft]')
  await expect(drafts).toHaveCount(rows, { timeout })
  await expect(settled.locator('[data-clarify-draft]:not([data-clarify-draft-transcript="received"])')).toHaveCount(0, {
    timeout
  })
}

// ─── The sandbox backend's durable store ───────────────────────────────

export interface ServerDraftRecord {
  /** `session_owner` (the canonical gateway) or `tui_gateway` (the `hermes serve` sidecar). */
  gateway: string
  record: {
    drafts: Record<string, { choices: string[]; revision: number; text: string }>
    outcome: null | string
    questions: { choices: null | string[]; multi_select: boolean; qid: string; question: string }[]
    request_id: string
    session_key: string
  }
  requestId: string
}

/** Every record under `<hermesHome>/clarify_drafts`, read straight from disk (independent of any RPC). */
export function serverDraftRecords(hermesHome: string): ServerDraftRecord[] {
  const root = path.join(hermesHome, 'clarify_drafts')
  const found: ServerDraftRecord[] = []

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return found
  }

  for (const gateway of fs.readdirSync(root)) {
    const gatewayDir = path.join(root, gateway)

    if (!fs.statSync(gatewayDir).isDirectory()) {
      continue
    }

    for (const digest of fs.readdirSync(gatewayDir)) {
      const dir = path.join(gatewayDir, digest)

      for (const name of fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []) {
        if (/^srq-[0-9a-f]{12}\.json$/.test(name)) {
          found.push({
            gateway,
            record: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
            requestId: name.slice(0, -'.json'.length)
          })
        }
      }
    }
  }

  return found
}

/** Poll the sandbox store until it holds exactly `count` records, and return them. */
export async function waitForServerRecords(hermesHome: string, count: number, timeout = 20_000): Promise<ServerDraftRecord[]> {
  await expect.poll(() => serverDraftRecords(hermesHome).length, { timeout }).toBe(count)

  return serverDraftRecords(hermesHome)
}

// ─── The renderer's device store ───────────────────────────────────────

export function deviceDraftEntries(page: Page): Promise<{ key: string; value: string }[]> {
  return page.evaluate(
    prefix =>
      Object.keys(window.localStorage)
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key, value: window.localStorage.getItem(key) ?? '' })),
    DEVICE_KEY_PREFIX
  )
}

export function clearDeviceDrafts(page: Page): Promise<void> {
  return page.evaluate(prefix => {
    for (const key of Object.keys(window.localStorage).filter(candidate => candidate.startsWith(prefix))) {
      window.localStorage.removeItem(key)
    }
  }, DEVICE_KEY_PREFIX)
}

// ─── What the mock model actually received ─────────────────────────────

export interface ClarifyToolResult {
  drafts?: { question_id: string; question_index: number; revision?: number; selected_choices: string[]; typed_text: string }[]
  drafts_durable?: boolean
  drafts_notice?: string
  drafts_request_id?: string
  drafts_submitted?: boolean
  notice?: string
  outcome: string
  responses: { choices_offered: null | string[]; question: string; status: string; user_response: null | string | string[] }[]
}

/**
 * The clarify tool results the model received, parsed, in arrival order, from `fromRequest` on. A tool result
 * rides every later request of its conversation, so each is returned once.
 */
export function clarifyToolResults(mock: MockServer, fromRequest = 0): ClarifyToolResult[] {
  const seen = new Set<string>()
  const results: ClarifyToolResult[] = []

  for (const request of mock.receivedChatRequests.slice(fromRequest)) {
    for (const message of request.messages) {
      const content = typeof message?.content === 'string' ? message.content : ''

      if (message?.role !== 'tool' || seen.has(content)) {
        continue
      }

      seen.add(content)

      try {
        const parsed = JSON.parse(content)

        if (Array.isArray(parsed?.responses)) {
          results.push(parsed as ClarifyToolResult)
        }
      } catch {
        // Not a clarify result.
      }
    }
  }

  return results
}

/** Every user-role message the model received from `fromRequest` on, as text. */
export function userMessages(mock: MockServer, fromRequest = 0): string[] {
  return mock.receivedChatRequests
    .slice(fromRequest)
    .flatMap(request => request.messages)
    .filter(message => message?.role === 'user')
    .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
}
