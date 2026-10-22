import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $clarifyRequests, clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import {
  $clarifyDraftRecallUnavailable,
  readClarifyDrafts,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { hasOpenServerRequest, rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { clearAllSessionStates, recordSessionEventScope } from '@/store/session-states'

import { ClarifyTool } from './index'

// Failure injection for unsent clarify drafts. Whatever breaks (this device's storage, the
// `clarify.draft` / `clarify.drafts` RPCs, the connection), the card may only say what the two
// stores confirmed, and saving or recalling a draft is never a submission: it never locks,
// responds to or fills in the request, and never writes into the confirmed-answer rows.

let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: 'assistant-1', status: { type: messageRunning ? 'running' : 'complete' } },
      thread: { isRunning: messageRunning }
    })
}))

const QUESTIONS = [
  { choices: ['Acme', 'Bolt', 'Cobalt'], multiSelect: true, qid: 'q0', question: 'Which exhibitors?' },
  { choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }
]

const ARGS = {
  questions: [
    { choices: ['Acme', 'Bolt', 'Cobalt'], multi_select: true, question: 'Which exhibitors?' },
    { question: 'Opening line?' }
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

const DEVICE_ONLY = 'Draft kept on this device only'
const NOT_SAVED = /^Not saved: this device could not store your latest changes/

const scope = () => resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' })
const deviceCopy = () => readClarifyDrafts(scope(), REQUEST_ID)
const stateLine = () => document.querySelector('[data-clarify-draft-state]')
const state = () => stateLine()?.getAttribute('data-clarify-draft-state')
const field = () => screen.getByPlaceholderText('Type your answer…')
const submit = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement)
const calls = (request: ReturnType<typeof vi.fn>, method: string) => request.mock.calls.filter(call => call[0] === method)
const methodsUsed = (request: ReturnType<typeof vi.fn>) => [...new Set(request.mock.calls.map(call => call[0] as string))]

/** Let a settled RPC reply reach the store (the autosave reply is a few microtasks behind its request). */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })

/** A live batch card whose `clarify.*` RPCs answer through `reply`; the open server request is observable. */
function mount(reply: Reply, extra: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  const respond = vi.fn()
  const fail = vi.fn()
  $gateway.set({ request } as never)
  rememberServerRequest({ fail, id: REQUEST_ID, method: 'clarify', params: {}, respond })
  setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1', ...extra })
  const view = render(tree(<ClarifyTool {...props()} />))

  return { fail, request, respond, view }
}

const stored = (value: string, tag: number) => ({ choices: [] as string[], revision: tag, text: value })

/** The timed-out card as a restarted app shows it: this device's copy is gone, the request id is known. */
function settledAfterRestart(reply: Reply, requestId = REQUEST_ID) {
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  $activeSessionId.set('session-after-restart')
  messageRunning = false
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  const respond = vi.fn()
  const fail = vi.fn()
  $gateway.set({ request } as never)
  rememberServerRequest({ fail, id: requestId, method: 'clarify', params: {}, respond })

  render(
    tree(
      <ClarifyTool
        {...props(
          JSON.stringify({
            outcome: 'timed_out',
            request_id: requestId,
            responses: [
              { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
              { question: 'Opening line?', status: 'unanswered', user_response: null }
            ]
          })
        )}
      />
    )
  )

  return { fail, request, respond }
}

const serverRecord = (requestId: string, drafts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  created_at: 1_792_000_000 - 60,
  drafts,
  outcome: 'timed_out',
  questions: QUESTIONS.map(({ choices, qid, question }) => ({ choices, qid, question })),
  request_id: requestId,
  updated_at: 1_792_000_000,
  ...extra
})

const recall = () => fireEvent.click(screen.getByRole('button', { name: /Show drafts saved on the server/ }))
const answerRows = () => [...document.querySelectorAll('[data-clarify-answer]')].map(row => row.textContent)

/** Make `window.localStorage` itself throw on access (storage disabled): the SecurityError browsers raise. */
function disableStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
  })

  return () => {
    if (original) {
      Object.defineProperty(window, 'localStorage', original)
    } else {
      delete (window as { localStorage?: unknown }).localStorage
    }
  }
}

beforeEach(() => {
  window.localStorage.clear()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
  messageRunning = true
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  clearClarifyRequest()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
})

describe('clarify draft status under server failures', () => {
  it.each([
    ['locked', { status: 'locked' }],
    ['unrecognised', { status: 'queued' }],
    ['empty', {}],
    ['missing', null]
  ])('a %s clarify.draft reply is not a server save: the draft stays device-only', async (_name, reply) => {
    const { fail, request, respond } = mount(method => (method === 'clarify.draft' ? reply : { status: 'ok' }))

    fireEvent.change(field(), { target: { value: 'unsent words' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(1), { timeout: 4000 })
    await settle()

    expect(state()).toBe('device-only')
    expect(stateLine()?.textContent).toBe(DEVICE_ONLY)
    expect(deviceCopy()?.drafts.q1?.text).toBe('unsent words')
    expect(methodsUsed(request)).toEqual(['clarify.draft'])
    expect(respond).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('ok with durable:false is accepted but never reads as saved: it says the disk copy is unconfirmed', async () => {
    const { request } = mount((method, params) =>
      method === 'clarify.draft' ? { durable: false, revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.change(field(), { target: { value: 'in the server cache only' } })
    await waitFor(() => expect(state()).toBe('server-unconfirmed'), { timeout: 4000 })

    expect(stateLine()?.textContent).toBe('Draft sent to the server, not yet confirmed on its disk; kept on this device')
    expect(stateLine()?.textContent).not.toMatch(/^Draft saved/)
    expect(calls(request, 'clarify.draft')).toHaveLength(1)
  })

  it('an expired reply closes server saving for this request for good, and this device keeps the newest text', async () => {
    const { request } = mount(method => (method === 'clarify.draft' ? { status: 'expired' } : { status: 'ok' }))

    fireEvent.change(field(), { target: { value: 'one' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(1), { timeout: 4000 })
    await settle()
    expect(state()).toBe('device-only')
    expect(stateLine()?.textContent).toBe(DEVICE_ONLY)

    fireEvent.change(field(), { target: { value: 'one two' } })
    await new Promise(resolve => setTimeout(resolve, 900))

    // The request ended on the server: nothing more is sent for it, and nothing is claimed saved.
    expect(calls(request, 'clarify.draft')).toHaveLength(1)
    expect(state()).toBe('device-only')
    expect(deviceCopy()?.drafts.q1?.text).toBe('one two')
  })

  it('a transport failure is transient: nothing is claimed saved, and the next edit reaches the server again', async () => {
    let attempts = 0

    const { request } = mount((method, params) => {
      if (method !== 'clarify.draft') {
        return { status: 'ok' }
      }

      attempts += 1

      if (attempts === 1) {
        throw new Error('socket closed')
      }

      return { durable: true, revision: params.revision, status: 'ok' }
    })

    fireEvent.change(field(), { target: { value: 'first' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(1), { timeout: 4000 })
    await settle()
    expect(state()).toBe('device-only')
    expect(stateLine()?.textContent).toBe(DEVICE_ONLY)
    expect(deviceCopy()?.drafts.q1?.text).toBe('first')

    fireEvent.change(field(), { target: { value: 'first, then more' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(stateLine()?.textContent).toBe('Draft saved')
    expect(calls(request, 'clarify.draft')).toHaveLength(2)
  })

  it.each([
    ['an internal JSON-RPC error', Object.assign(new Error('internal error'), { code: -32603 })],
    ['a request timeout', new Error('request timed out after 30s: clarify.draft')]
  ])('%s is not a missing capability: autosave is not disabled and the next edit retries', async (_name, failure) => {
    let attempts = 0

    const { request } = mount(method => {
      if (method !== 'clarify.draft') {
        return { status: 'ok' }
      }

      attempts += 1

      if (attempts === 1) {
        throw failure
      }

      return { status: 'ok' }
    })

    fireEvent.change(field(), { target: { value: 'first' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(1), { timeout: 4000 })
    await settle()

    expect(state()).toBe('device-only')
    expect(screen.queryByText(/Server autosave unavailable/)).toBeNull()

    fireEvent.change(field(), { target: { value: 'first, then more' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(2), { timeout: 4000 })
  })

  it('a draft request that never settles leaves the card honest and Confirm unblocked', async () => {
    const { request } = mount(method =>
      method === 'clarify.draft' ? new Promise(() => undefined) : { remaining: [], status: 'ok' }
    )

    fireEvent.change(field(), { target: { value: 'sent into the void' } })
    await waitFor(() => expect(calls(request, 'clarify.draft')).toHaveLength(1), { timeout: 4000 })
    await settle()

    expect(state()).toBe('device-only')
    expect(stateLine()?.textContent).toBe(DEVICE_ONLY)

    submit()
    await waitFor(() => expect(calls(request, 'clarify.lock')).toHaveLength(2), { timeout: 4000 })
    expect(calls(request, 'clarify.draft')).toHaveLength(1)
  })

  it('an unprovable draft owner stores nothing, sends nothing, and the card says the text is not saved', async () => {
    // The request arrived on gateway A, but the session is attributed to gateway B: ambiguous, so unscoped.
    recordSessionEventScope({ connectionId: 'gateway-b', profile: 'default', session_id: 'session-1' })
    const { request } = mount(() => ({ durable: true, status: 'ok' }), {
      owner: { connectionId: 'gateway-a', profile: 'default' }
    })

    fireEvent.change(field(), { target: { value: 'whose conversation is this?' } })
    await new Promise(resolve => setTimeout(resolve, 900))

    expect(document.querySelector('[data-clarify-draft-state="unscoped"]')?.textContent).toMatch(/^Not saved: this form could not confirm which conversation owns it/)
    expect(request.mock.calls).toEqual([])
    expect(Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))).toEqual([])
  })
})

describe('clarify draft status under device storage failures', () => {
  it('storage that refuses every access never crashes the card and never reads as saved', async () => {
    const { request } = mount((method, params) =>
      method === 'clarify.draft'
        ? { durable: true, revision: params.revision, status: 'ok' }
        : { remaining: [], status: 'ok' }
    )

    const restore = disableStorage()

    try {
      fireEvent.change(field(), { target: { value: 'nowhere to put this' } })
      expect(state()).toBe('not-saved')
      expect(stateLine()?.textContent).toMatch(NOT_SAVED)

      // Only the server's disk-confirmed acknowledgement of THIS revision changes what the card may say.
      await waitFor(() => expect(state()).toBe('server-only'), { timeout: 4000 })
      expect(stateLine()?.textContent).toBe('Draft saved on the server only: this device could not store a copy')

      fireEvent.change(field(), { target: { value: 'nowhere to put this, and more' } })
      expect(state()).toBe('not-saved')

      // Even forgetting the device copy on Confirm cannot throw out of a storage that refuses it.
      submit()
      await waitFor(() => expect(calls(request, 'clarify.lock')).toHaveLength(2), { timeout: 4000 })
    } finally {
      restore()
    }
  })

  it('storage that recovers stops reporting not-saved on the next successful write', () => {
    mount(() => ({ status: 'ok' }))

    // Refuse exactly the first draft write (quota), then behave again.
    const write = Storage.prototype.setItem
    let refused = false

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (!refused && key.startsWith('hermes.clarifyDrafts')) {
        refused = true
        throw new DOMException('quota', 'QuotaExceededError')
      }

      write.call(this, key, value)
    })

    fireEvent.change(field(), { target: { value: 'first' } })
    expect(state()).toBe('not-saved')

    fireEvent.change(field(), { target: { value: 'first, then second' } })
    expect(state()).toBe('device-only')
    expect(stateLine()?.textContent).toBe(DEVICE_ONLY)

    const keys = Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))
    expect(keys).toHaveLength(1)
    expect(JSON.parse(window.localStorage.getItem(keys[0]) ?? '{}').drafts.q1.text).toBe('first, then second')
  })
})

describe('saving a draft is never a submission', () => {
  it('autosaving a pick and typed text only uses clarify.draft and leaves the request open and unanswered', async () => {
    const { fail, request, respond } = mount((method, params) =>
      method === 'clarify.draft' ? { durable: true, revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.change(field(), { target: { value: 'Opening words\nsecond line ✓' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    await waitFor(() => expect(calls(request, 'clarify.draft').length).toBeGreaterThanOrEqual(2), { timeout: 4000 })

    expect(methodsUsed(request)).toEqual(['clarify.draft'])
    expect(respond).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(hasOpenServerRequest(REQUEST_ID)).toBe(true)
    expect($clarifyRequests.get()['session-1']?.requestId).toBe(REQUEST_ID)
    // Staged picks are still only staged: the card still waits for Confirm.
    expect(screen.getByRole('button', { name: /Bolt/ }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('button[type="submit"]')).toBeTruthy()
  })
})

describe('recalling saved drafts is a read, never a submission', () => {
  it('shows only drafts after a restart, never fills the answer rows, and sends nothing but the recall and discard reads', async () => {
    const { fail, request, respond } = settledAfterRestart(method =>
      method === 'clarify.drafts'
        ? {
            drafts: [
              serverRecord(REQUEST_ID, {
                q0: { choices: ['Acme', 'Cobalt'], revision: 7, text: 'plus Delta' },
                q1: stored('Línea uno\nline two ✓', 8)
              })
            ]
          }
        : { status: 'ok' }
    )

    expect(answerRows()).toEqual(['No answer', 'No answer'])
    recall()

    const recovered = await waitFor(() => {
      const node = document.querySelector('[data-clarify-drafts-recovered="exact"]') as HTMLElement
      expect(node).toBeTruthy()

      return node
    })

    expect(recovered.textContent).toContain('plus Delta')
    // The drafts appear beside the answers, never in them.
    expect(answerRows()).toEqual(['No answer', 'No answer'])

    fireEvent.click(screen.getByRole('button', { name: /Discard drafts/ }))
    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-discarded]')).toBeTruthy())

    expect(methodsUsed(request)).toEqual(['clarify.drafts', 'clarify.drafts.discard'])
    expect(respond).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(hasOpenServerRequest(REQUEST_ID)).toBe(true)
  })

  it('shows drafts only: answers, locked values and another request record in the reply are never displayed', async () => {
    settledAfterRestart(method =>
      method === 'clarify.drafts'
        ? {
            drafts: [
              serverRecord(
                REQUEST_ID,
                { q1: stored('only this is a draft', 9) },
                {
                  answers: { q1: 'LOCKED-ANSWER-VALUE' },
                  locked: ['q1'],
                  responses: [{ question: 'Opening line?', status: 'answered', user_response: 'SUBMITTED-ANSWER-VALUE' }]
                }
              ),
              serverRecord('srq-bbbbbbbbbbbb', { q1: stored('OTHER-REQUEST-DRAFT', 99) })
            ]
          }
        : { status: 'ok' }
    )

    recall()
    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-recovered="exact"]')).toBeTruthy())

    const text = document.body.textContent ?? ''
    expect(text).toContain('only this is a draft')
    expect(text).not.toContain('LOCKED-ANSWER-VALUE')
    expect(text).not.toContain('SUBMITTED-ANSWER-VALUE')
    expect(text).not.toContain('OTHER-REQUEST-DRAFT')
    expect(answerRows()).toEqual(['No answer', 'No answer'])
  })

  it.each([
    ['a dropped connection', new Error('socket closed')],
    ['a request timeout', new Error('request timed out after 30s: clarify.drafts')],
    ['an internal JSON-RPC error', Object.assign(new Error('internal error'), { code: -32603 })]
  ])('%s says the read failed, invents no drafts, keeps recall available and is not an unsupported server', async (_name, failure) => {
    let attempts = 0

    const { request, respond } = settledAfterRestart(method => {
      if (method !== 'clarify.drafts') {
        return { status: 'ok' }
      }

      attempts += 1

      if (attempts === 1) {
        throw failure
      }

      return { drafts: [serverRecord(REQUEST_ID, { q1: stored('recovered on retry', 5) })] }
    })

    recall()
    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-recall="error"]')).toBeTruthy())

    expect(document.querySelector('[data-clarify-drafts-recall="error"]')?.textContent).toBe(
      'Could not read the drafts saved on the server. Try again once connected.'
    )
    expect(document.querySelector('[data-clarify-drafts-recovered]')).toBeNull()
    expect(document.querySelector('[data-clarify-draft]')).toBeNull()
    expect($clarifyDraftRecallUnavailable.get()).toEqual({})

    // The retry works: a failed read was not remembered as "this server cannot recall".
    recall()
    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-recovered="exact"]')).toBeTruthy())
    expect(document.body.textContent).toContain('recovered on retry')
    expect(methodsUsed(request)).toEqual(['clarify.drafts'])
    expect(respond).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty list', { drafts: [] }],
    ['no list', {}],
    ['a missing reply', null],
    ['a list that is not a list', { drafts: 'nope' }],
    ['rows that are not records', { drafts: [null, 7, 'x', { request_id: '' }] }],
    ['only another request', { drafts: [serverRecord('srq-bbbbbbbbbbbb', { q1: stored('OTHER-REQUEST-DRAFT', 4) })] }]
  ])('%s reads as "the server holds no saved drafts for this form" and shows nothing', async (_name, reply) => {
    settledAfterRestart(method => (method === 'clarify.drafts' ? reply : { status: 'ok' }))

    recall()
    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-recall="none"]')).toBeTruthy())

    expect(document.querySelector('[data-clarify-drafts-recall="none"]')?.textContent).toBe(
      'The server holds no saved drafts for this form.'
    )
    expect(document.querySelector('[data-clarify-drafts-recovered]')).toBeNull()
    expect(document.body.textContent).not.toContain('OTHER-REQUEST-DRAFT')
    expect(answerRows()).toEqual(['No answer', 'No answer'])
  })
})
