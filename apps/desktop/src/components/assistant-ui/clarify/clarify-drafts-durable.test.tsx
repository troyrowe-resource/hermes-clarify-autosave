import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import {
  clarifyDraftKey,
  readClarifyDrafts,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Final backend contract: `clarify.draft` ok/stale carry `durable` (true only when THAT
// revision is on the server's disk; false or absent is not proof), and the terminal tool
// result carries per-row `question_id` + `revision` and `drafts_durable`. The card must
// never claim disk safety it was not given, and must reconcile the terminal result per
// question by revision (another authorised viewer can be newer than this device).

let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: 'assistant-1', status: { type: messageRunning ? 'running' : 'complete' } },
      thread: { isRunning: messageRunning }
    })
}))

// Two questions with IDENTICAL text: text is never identity.
const QUESTIONS = [
  { choices: ['Acme', 'Bolt'], multiSelect: true, qid: 'q0', question: 'Same question?' },
  { choices: null, multiSelect: false, qid: 'q1', question: 'Same question?' }
]

const ARGS = {
  questions: [
    { choices: ['Acme', 'Bolt'], multi_select: true, question: 'Same question?' },
    { question: 'Same question?' }
  ]
}

const REQUEST_ID = 'srq-aaaaaaaaaaaa'

const props = (result?: unknown) =>
  ({
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: { type: result === undefined ? 'running' : 'complete' },
    toolCallId: 'call-a',
    toolName: 'clarify',
    type: 'tool-call'
  }) as ToolCallMessagePartProps

const tree = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {ui}
  </I18nProvider>
)

type Reply = (method: string, params: Record<string, unknown>) => unknown

function mount(reply: Reply) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  $gateway.set({ request } as never)
  rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
  const view = render(tree(<ClarifyTool {...props()} />))

  return { request, view }
}

const scope = () => resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' })
const state = () => document.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')
const draftCalls = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(call => call[0] === 'clarify.draft')
const field = () => screen.getByPlaceholderText('Type your answer…')

function timeOut(view: ReturnType<typeof render>, extra: Record<string, unknown>) {
  clearClarifyRequest(REQUEST_ID, 'session-1')
  messageRunning = false
  view.rerender(
    tree(
      <ClarifyTool
        {...props(
          JSON.stringify({
            drafts_notice: 'incomplete',
            drafts_request_id: REQUEST_ID,
            drafts_submitted: false,
            outcome: 'timed_out',
            responses: [
              { question: 'Same question?', status: 'unanswered', user_response: null },
              { question: 'Same question?', status: 'unanswered', user_response: null }
            ],
            ...extra
          })
        )}
      />
    )
  )

  return document.querySelector('[data-clarify-drafts]') as HTMLElement | null
}

/** Seed this device's copy (a reload: the renderer's memory is gone). */
function seed(drafts: Record<string, { choices: string[]; revision: number; text: string }>) {
  const s = scope()!
  window.localStorage.setItem(
    clarifyDraftKey(s, REQUEST_ID),
    JSON.stringify({
      ...s,
      drafts,
      questions: QUESTIONS,
      requestId: REQUEST_ID,
      savedAt: 1,
      server: 'device-only',
      sessionId: 'session-1',
      storedSessionId: 'stored-1',
      toolCallId: 'call-a',
      v: 2
    })
  )
}

function renderSettled(extra: Record<string, unknown>) {
  messageRunning = false
  render(
    tree(
      <ClarifyTool
        {...props(
          JSON.stringify({
            drafts_notice: 'incomplete',
            drafts_request_id: REQUEST_ID,
            drafts_submitted: false,
            outcome: 'timed_out',
            responses: [
              { question: 'Same question?', status: 'unanswered', user_response: null },
              { question: 'Same question?', status: 'unanswered', user_response: null }
            ],
            ...extra
          })
        )}
      />
    )
  )

  return [...document.querySelectorAll('[data-clarify-draft]')] as HTMLElement[]
}

beforeEach(() => {
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  clearClarifyRequest()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
})

describe('clarify draft durability contract', () => {
  it('ok with durable:false while this device cannot store it is NOT saved; memory and the older disk copy survive', async () => {
    const { request, view } = mount((method, params) =>
      method === 'clarify.draft' ? { durable: false, revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.change(field(), { target: { value: 'older on disk' } })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    fireEvent.change(field(), { target: { value: 'newest only in memory' } })
    await waitFor(() => expect(draftCalls(request).length).toBeGreaterThan(0), { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(state()).toBe('not-saved')
    expect(document.querySelector('[data-clarify-draft-state]')?.textContent).toMatch(/Not saved/)

    const drafts = timeOut(view, {})
    expect(drafts?.textContent).toContain('newest only in memory')
    vi.restoreAllMocks()
    const stored = Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))
    expect(stored).toHaveLength(1)
    expect(window.localStorage.getItem(stored[0])).toContain('older on disk')
  })

  it('ok with durable:true for the newest revision is the only reply that reads as saved', async () => {
    mount((method, params) =>
      method === 'clarify.draft' ? { durable: true, revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.change(field(), { target: { value: 'on disk' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
  })

  it('ok with durable absent is not server-saved', async () => {
    const { request } = mount((method, params) =>
      method === 'clarify.draft' ? { revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.change(field(), { target: { value: 'durability unknown' } })
    await waitFor(() => expect(draftCalls(request)).toHaveLength(1), { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(state()).toBe('server-unconfirmed')
    expect(state()).not.toBe('saved')
  })

  it('stale is not proof: durable absent or for another revision is not saved; durable for the exact revision is', async () => {
    let mode: 'absent' | 'exact' | 'newer' = 'absent'

    const { request } = mount((method, params) => {
      if (method !== 'clarify.draft') {
        return { status: 'ok' }
      }

      const revision = params.revision as number

      return mode === 'absent'
        ? { revision, status: 'stale' }
        : mode === 'newer'
          ? { durable: true, revision: revision + 5, status: 'stale' }
          : { durable: true, revision, status: 'stale' }
    })

    fireEvent.change(field(), { target: { value: 'a' } })
    await waitFor(() => expect(draftCalls(request)).toHaveLength(1), { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(state()).not.toBe('saved')

    mode = 'newer'
    fireEvent.change(field(), { target: { value: 'ab' } })
    await waitFor(() => expect(draftCalls(request)).toHaveLength(2), { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The server holds a DIFFERENT (newer) revision on disk: this device's newest is not what is saved.
    expect(state()).not.toBe('saved')

    mode = 'exact'
    fireEvent.change(field(), { target: { value: 'abc' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(readClarifyDrafts(scope(), REQUEST_ID)?.drafts.q1?.text).toBe('abc')
  })

  it('reconciles the terminal result per question id by revision, never by question text', () => {
    seed({
      q0: { choices: ['Acme'], revision: 10, text: 'device older' },
      q1: { choices: [], revision: 50, text: 'device newer' }
    })

    const rows = renderSettled({
      drafts: [
        // Another authorised viewer edited q0 later: the server's newer revision wins.
        {
          question: 'Same question?',
          question_id: 'q0',
          question_index: 0,
          revision: 20,
          selected_choices: ['Bolt'],
          typed_text: 'server newer'
        },
        {
          question: 'Same question?',
          question_id: 'q1',
          question_index: 1,
          revision: 40,
          selected_choices: [],
          typed_text: 'server older'
        }
      ],
      drafts_durable: true
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('server newer')
    expect(rows[0].textContent).toContain('Bolt')
    expect(rows[1].textContent).toContain('device newer')
    expect(document.body.textContent).not.toContain('device older')
    expect(document.body.textContent).not.toContain('server older')
  })

  it('a newer CLEARED device copy stays cleared, and a terminal row without a revision never replaces the device copy', () => {
    seed({
      q0: { choices: [], revision: 30, text: '' },
      q1: { choices: [], revision: 5, text: 'device copy, revision known' }
    })

    const rows = renderSettled({
      drafts: [
        {
          question: 'Same question?',
          question_id: 'q0',
          question_index: 0,
          revision: 20,
          selected_choices: ['Bolt'],
          typed_text: 'cleared later'
        },
        {
          question: 'Same question?',
          question_id: 'q1',
          question_index: 1,
          selected_choices: [],
          typed_text: 'unknown revision'
        }
      ]
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('device copy, revision known')
    expect(document.body.textContent).not.toContain('cleared later')
    expect(document.body.textContent).not.toContain('unknown revision')
  })

  it.each([
    [true, 'confirmed'],
    [false, 'not-on-disk'],
    [undefined, 'unknown']
  ])('drafts_durable %s reads as disk state %s, separately from what the assistant received', (durable, disk) => {
    const rows = renderSettled({
      drafts: [
        {
          question: 'Same question?',
          question_id: 'q1',
          question_index: 1,
          revision: 7,
          selected_choices: [],
          typed_text: 'told to the assistant'
        }
      ],
      ...(durable === undefined ? {} : { drafts_durable: durable })
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-clarify-draft-transcript')).toBe('received')
    expect(rows[0].getAttribute('data-clarify-draft-disk')).toBe(disk)
    expect(rows[0].textContent).toMatch(disk === 'confirmed' ? /saved on the server disk/ : /not confirmed|not saved/i)

    if (disk !== 'confirmed') {
      expect(rows[0].textContent).not.toMatch(/saved on the server disk/)
    }
  })
})
