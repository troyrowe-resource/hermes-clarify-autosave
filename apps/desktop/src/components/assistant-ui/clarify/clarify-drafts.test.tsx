import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleInputRequestEvent } from '@/app/session/hooks/use-message-stream/gateway-event/input-requests'
import type { GatewayEventContext } from '@/app/session/hooks/use-message-stream/gateway-event/types'
import { I18nProvider } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { clarifyDraftKey, resetClarifyDraftsForTests, resolveClarifyDraftScope } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Regression: a batch card staged every pick and typed answer in component state
// and sent nothing until Confirm, so a timeout lost all of it (Q6-10 of a real
// session). Drafts now autosave through `clarify.draft` (never `clarify.lock`)
// and the timed-out card shows what was saved.

let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => messageRunning
}))

const QUESTIONS = [
  {
    choices: ['Acme (Recommended)', 'Bolt', 'Cobalt'],
    multiSelect: true,
    qid: 'q0',
    question: '7. Which exhibitors?'
  },
  { choices: null, multiSelect: false, qid: 'q1', question: '8. Opening line?' }
]

const ARGS = {
  questions: [
    { choices: ['Acme', 'Bolt', 'Cobalt'], multi_select: true, question: '7. Which exhibitors?' },
    { question: '8. Opening line?' }
  ]
}

function props(result?: unknown): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: { type: result === undefined ? 'running' : 'complete' },
    toolCallId: 'clarify-drafts',
    toolName: 'clarify',
    type: 'tool-call'
  } as ToolCallMessagePartProps
}

function tree(ui: ReactNode) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      {ui}
    </I18nProvider>
  )
}

/** The exact scope these tests' session resolves to (sole legacy backend, runtime-only session). */
const scopeFor = (sessionId: string) => {
  const scope = resolveClarifyDraftScope({ sessionId, storedSessionId: null })

  if (!scope) {
    throw new Error('test session has no draft scope')
  }

  return scope
}

const deviceKey = (requestId: string, sessionId = 'session-1') => clarifyDraftKey(scopeFor(sessionId), requestId)

/** Seed this device's copy of a request's drafts under its complete scope. */
function seedDeviceCopy(
  requestId: string,
  drafts: Record<string, { choices: string[]; revision: number; text: string }>,
  extra: Record<string, unknown> = {},
  sessionId = 'session-1'
) {
  const scope = scopeFor(sessionId)
  window.localStorage.setItem(
    clarifyDraftKey(scope, requestId),
    JSON.stringify({
      ...scope,
      drafts,
      questions: QUESTIONS,
      requestId,
      savedAt: 1,
      server: 'saved',
      sessionId,
      storedSessionId: null,
      toolCallId: 'clarify-drafts',
      v: 2,
      ...extra
    })
  )
}

type Reply = (method: string, params: Record<string, unknown>) => unknown

function mount(reply: Reply = () => ({ durable: true, status: 'ok' }), extra: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  rememberServerRequest({ fail: vi.fn(), id: 'srq-aaaaaaaaaaaa', method: 'clarify', params: {}, respond: vi.fn() })
  $activeSessionId.set('session-1')
  $gateway.set({ request } as never)
  setClarifyRequest({ questions: QUESTIONS, requestId: 'srq-aaaaaaaaaaaa', sessionId: 'session-1', ...extra })
  const view = render(tree(<ClarifyTool {...props()} />))

  return { request, view }
}

const draftCalls = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(call => call[0] === 'clarify.draft').map(call => call[1] as Record<string, unknown>)

const lastDraft = (request: ReturnType<typeof vi.fn>, qid: string) =>
  draftCalls(request)
    .filter(params => params.question_id === qid)
    .at(-1)

/** Drive the real `request.cancel` handler over a transcript holding this card's tool row. */
function expireThroughRequestCancel(requestId: string, sessionId: string): unknown {
  let messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      parts: [
        {
          args: ARGS,
          argsText: JSON.stringify(ARGS),
          toolCallId: 'clarify-drafts',
          toolName: 'clarify',
          type: 'tool-call'
        }
      ],
      pending: true,
      role: 'assistant'
    } as ChatMessage
  ]

  const deps = {
    activeSessionIdRef: { current: sessionId },
    sessionInterrupted: () => false,
    sessionStateByRuntimeIdRef: { current: new Map() },
    updateSessionState: (_sid: string, update: (state: ReturnType<typeof createClientSessionState>) => unknown) => {
      const next = update({ ...createClientSessionState('stored-1'), busy: true, messages }) as {
        messages: ChatMessage[]
      }

      messages = next.messages
    },
    upsertToolCall: () => undefined
  } as unknown as GatewayEventContext['deps']

  act(() => {
    handleInputRequestEvent({
      deps,
      event: {
        payload: { id: requestId, method: 'clarify', reason: 'timeout' },
        session_id: sessionId,
        type: 'request.cancel'
      },
      explicitSid: sessionId,
      fromActiveSource: () => true,
      isActiveEvent: true,
      occurredAt: Date.now() / 1000,
      payload: { id: requestId, method: 'clarify', reason: 'timeout' },
      scheduleConfigRefresh: () => undefined,
      sessionId
    } as unknown as GatewayEventContext)
  })

  const part = messages[0]?.parts[0] as { result?: unknown } | undefined

  return part?.result
}

beforeEach(() => {
  resetServerRequestsForTests()
  resetClarifyDraftsForTests()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  resetServerRequestsForTests()
  resetClarifyDraftsForTests()
  $activeSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
  vi.clearAllMocks()
})

describe('clarify drafts', () => {
  it('autosaves typed text and multi-select picks without locking, then shows them on the timed-out card', async () => {
    const { request, view } = mount()

    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cobalt/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bolt/ })) // deselected again
    fireEvent.change(screen.getByPlaceholderText(/Other/), { target: { value: 'plus Delta' } })
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Open with the recycling\nstatistics — 42 % ✓' }
    })

    await waitFor(
      () => {
        expect(lastDraft(request, 'q0')).toMatchObject({ choices: ['Acme', 'Cobalt'], text: 'plus Delta' })
        expect(lastDraft(request, 'q1')).toMatchObject({ text: 'Open with the recycling\nstatistics — 42 % ✓' })
      },
      { timeout: 4000 }
    )
    expect(lastDraft(request, 'q0')).toMatchObject({
      question_id: 'q0',
      request_id: 'srq-aaaaaaaaaaaa',
      session_id: 'session-1'
    })
    // Typing and picking never answers anything.
    expect(request.mock.calls.some(call => call[0] === 'clarify.lock')).toBe(false)

    // The wait times out: the backend withdraws the request with `request.cancel`,
    // and the real handler tears the live card down and settles its tool row.
    const projected = expireThroughRequestCancel('srq-aaaaaaaaaaaa', 'session-1')
    expect(projected).toMatchObject({ outcome: 'cancelled' })
    messageRunning = false
    view.rerender(tree(<ClarifyTool {...props(projected)} />))

    let drafts = document.querySelector('[data-clarify-drafts]') as HTMLElement
    expect(drafts).toBeTruthy()
    expect(within(drafts).getByText('Acme, Cobalt')).toBeTruthy()
    expect(within(drafts).getByText('plus Delta')).toBeTruthy()
    expect(drafts.textContent).toContain('Open with the recycling\nstatistics — 42 % ✓')

    // Then the tool's own result lands: the server's drafts, reported apart from the answers.
    const result = JSON.stringify({
      drafts: [
        {
          question: '7. Which exhibitors?',
          question_index: 0,
          selected_choices: ['Acme', 'Cobalt'],
          typed_text: 'plus Delta'
        },
        {
          question: '8. Opening line?',
          question_index: 1,
          selected_choices: [],
          typed_text: 'Open with the recycling\nstatistics — 42 % ✓'
        }
      ],
      drafts_notice: 'incomplete',
      drafts_submitted: false,
      outcome: 'timed_out',
      responses: [
        { question: '7. Which exhibitors?', status: 'unanswered', user_response: null },
        { question: '8. Opening line?', status: 'unanswered', user_response: null }
      ]
    })

    view.rerender(tree(<ClarifyTool {...props(result)} />))

    drafts = document.querySelector('[data-clarify-drafts="server"]') as HTMLElement
    expect(drafts).toBeTruthy()
    expect(within(drafts).getByText('Unsubmitted drafts')).toBeTruthy()
    expect(within(drafts).getByText('Acme, Cobalt')).toBeTruthy()
    expect(within(drafts).getByText('plus Delta')).toBeTruthy()
    expect(drafts.textContent).toContain('Open with the recycling\nstatistics — 42 % ✓')
    // The confirmed-answer rows still say nothing was answered.
    expect(screen.getAllByText('No answer')).toHaveLength(2)
    expect(within(drafts).getByText(/The assistant was told these are drafts, not answers/)).toBeTruthy()
    expect(within(drafts).getByText(/can no longer be submitted/)).toBeTruthy()
    expect(within(drafts).getByRole('button', { name: /Copy drafts/ })).toBeTruthy()
    expect(request.mock.calls.some(call => call[0] === 'clarify.lock')).toBe(false)
  })

  it('restores the same request on reconnect from the server replay, newest device copy first', async () => {
    // This device kept a newer edit of q1 than the server acknowledged (offline before the pause ended).
    seedDeviceCopy('srq-aaaaaaaaaaaa', { q1: { choices: [], revision: 9, text: 'newer on device' } })

    const { request } = mount(undefined, {
      drafts: {
        q0: { choices: ['Acme', 'Bolt'], revision: 4, text: 'extra' },
        q1: { choices: [], revision: 3, text: 'older on server' }
      }
    })

    expect(screen.getByRole('button', { name: /Acme/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Bolt/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Cobalt/ }).getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByPlaceholderText(/Other/) as HTMLTextAreaElement).value).toBe('extra')
    expect((screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement).value).toBe('newer on device')
    // The unacknowledged device copy is pushed to the server; nothing is locked.
    await waitFor(() => expect(lastDraft(request, 'q1')).toMatchObject({ revision: 9, text: 'newer on device' }), {
      timeout: 4000
    })
    expect(request.mock.calls.some(call => call[0] === 'clarify.lock')).toBe(false)
  })

  it('never carries a draft into a new request, even with the same questions in the same session', () => {
    seedDeviceCopy('srq-aaaaaaaaaaaa', { q1: { choices: [], revision: 2, text: 'belongs to the old request' } })
    rememberServerRequest({ fail: vi.fn(), id: 'srq-bbbbbbbbbbbb', method: 'clarify', params: {}, respond: vi.fn() })
    $activeSessionId.set('session-1')
    $gateway.set({ request: vi.fn() } as never)
    setClarifyRequest({ questions: QUESTIONS, requestId: 'srq-bbbbbbbbbbbb', sessionId: 'session-1' })
    render(tree(<ClarifyTool {...props()} />))

    expect((screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps the draft on this device and says so when the backend has no clarify.draft, without retrying or blocking Confirm', async () => {
    const { request } = mount(method => {
      if (method === 'clarify.draft') {
        throw Object.assign(new Error('unknown method: clarify.draft'), { code: -32601 })
      }

      return { remaining: [], status: 'ok' }
    })

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'first' } })
    await waitFor(() => expect(screen.getByText(/Server autosave unavailable/)).toBeTruthy(), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'first and more' } })
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(draftCalls(request)).toHaveLength(1)
    // The device copy has the newest text even though the server never stored any.
    expect(JSON.parse(window.localStorage.getItem(deviceKey('srq-aaaaaaaaaaaa')) || '{}').drafts.q1.text).toBe(
      'first and more'
    )

    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(request.mock.calls.filter(call => call[0] === 'clarify.lock')).toHaveLength(2))
  })

  it('shows device-only drafts on the timed-out card when the server reported none (older backend)', () => {
    seedDeviceCopy(
      'srq-aaaaaaaaaaaa',
      { q1: { choices: [], revision: 2, text: 'only on this device' } },
      { server: 'unavailable' }
    )
    $activeSessionId.set('session-1')

    const result = JSON.stringify({
      outcome: 'timed_out',
      responses: [
        { question: '7. Which exhibitors?', status: 'unanswered', user_response: null },
        { question: '8. Opening line?', status: 'unanswered', user_response: null }
      ]
    })

    messageRunning = false
    render(tree(<ClarifyTool {...props(result)} />))

    const drafts = document.querySelector('[data-clarify-drafts="device"]') as HTMLElement
    expect(drafts).toBeTruthy()
    expect(within(drafts).getByText('only on this device')).toBeTruthy()
    expect(within(drafts).getByText(/The assistant has not seen these/)).toBeTruthy()
  })

  it("never shows another session's drafts on a settled card", () => {
    seedDeviceCopy('srq-aaaaaaaaaaaa', { q1: { choices: [], revision: 2, text: 'session one secret' } })
    $activeSessionId.set('session-2')

    const result = JSON.stringify({
      outcome: 'timed_out',
      responses: [
        { question: '7. Which exhibitors?', status: 'unanswered', user_response: null },
        { question: '8. Opening line?', status: 'unanswered', user_response: null }
      ]
    })

    messageRunning = false
    render(tree(<ClarifyTool {...props(result)} />))

    expect(document.querySelector('[data-clarify-drafts]')).toBeNull()
    expect(screen.queryByText('session one secret')).toBeNull()
  })

  it('Confirm supersedes drafts: pending autosaves are dropped, only locks are sent, the device copy is forgotten', async () => {
    // Slow locks: a pending autosave would fire while they are still in flight.
    const { request } = mount(method =>
      method === 'clarify.lock'
        ? new Promise(resolve => setTimeout(() => resolve({ remaining: [], status: 'ok' }), 800))
        : { status: 'ok' }
    )

    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'final words' } })
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    await waitFor(() => expect(request.mock.calls.filter(call => call[0] === 'clarify.lock')).toHaveLength(2), {
      timeout: 4000
    })
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(draftCalls(request)).toHaveLength(0)
    expect(request.mock.calls.map(call => call[0])).toEqual(['clarify.lock', 'clarify.lock'])
    expect(window.localStorage.getItem(deviceKey('srq-aaaaaaaaaaaa'))).toBeNull()
  })

  it('saves a cleared choice as a cleared draft and keeps revisions strictly increasing', async () => {
    const { request } = mount()

    fireEvent.click(screen.getByRole('button', { name: /Cobalt/ }))
    await waitFor(() => expect(lastDraft(request, 'q0')).toMatchObject({ choices: ['Cobalt'] }), { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: /Cobalt/ }))
    await waitFor(() => expect(lastDraft(request, 'q0')).toMatchObject({ choices: [], text: '' }), { timeout: 4000 })

    const revisions = draftCalls(request)
      .filter(params => params.question_id === 'q0')
      .map(params => params.revision as number)

    expect(revisions).toHaveLength(2)
    expect(revisions[1]).toBeGreaterThan(revisions[0])
    expect(request.mock.calls.some(call => call[0] === 'clarify.lock')).toBe(false)
  })
})
