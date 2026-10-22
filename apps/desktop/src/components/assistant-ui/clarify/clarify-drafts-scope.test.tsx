import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { type ClarifyRequest, clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { resetClarifyDraftsForTests } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { recordSessionEventScope } from '@/store/session-states'

import { ClarifyTool } from './index'

// Parent-detected gaps: device drafts were keyed by request id ONLY, a settled
// card with no request id picked a draft by session + question TEXT, and the
// exact lookup never checked gateway / profile / session. Identical questions
// recur (a second identical batch in the same chat), and two gateways or
// profiles can mint the same ids, so text and ids alone are not identity.

let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: 'assistant-1', status: { type: messageRunning ? 'running' : 'complete' } },
      thread: { isRunning: messageRunning }
    })
}))

const QUESTIONS = [
  { choices: ['Acme', 'Bolt'], multiSelect: true, qid: 'q0', question: 'Which exhibitors?' },
  { choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }
]

const ARGS = {
  questions: [
    { choices: ['Acme', 'Bolt'], multi_select: true, question: 'Which exhibitors?' },
    { question: 'Opening line?' }
  ]
}

const TIMED_OUT = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    outcome: 'timed_out',
    responses: [
      { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
      { question: 'Opening line?', status: 'unanswered', user_response: null }
    ],
    ...extra
  })

function props(toolCallId: string, result?: unknown): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: { type: result === undefined ? 'running' : 'complete' },
    toolCallId,
    toolName: 'clarify',
    type: 'tool-call'
  } as ToolCallMessagePartProps
}

const tree = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {ui}
  </I18nProvider>
)

function view(runtimeId: string, storedId: string) {
  $activeSessionId.set(runtimeId)
  $selectedStoredSessionId.set(storedId)
}

/** Type a draft on a live card for `requestId`, wait for the device copy, then unmount it. */
async function typeDraft(requestId: string, toolCallId: string, text: string, extra: Partial<ClarifyRequest> = {}) {
  const request = vi.fn(async () => ({ status: 'ok' }))
  $gateway.set({ request } as never)
  rememberServerRequest({ fail: vi.fn(), id: requestId, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId, sessionId: $activeSessionId.get(), ...extra })
  const mounted = render(tree(<ClarifyTool {...props(toolCallId)} />))
  fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: text } })
  await waitFor(() => expect(document.querySelector('[data-clarify-draft-state]')).toBeTruthy(), { timeout: 4000 })
  mounted.unmount()
  clearClarifyRequest(requestId, $activeSessionId.get())

  return request
}

/** A reload: the renderer's memory is gone, only this device's storage remains. */
function reload() {
  cleanup()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
}

function settled(toolCallId: string, result: unknown) {
  messageRunning = false
  render(tree(<ClarifyTool {...props(toolCallId, result)} />))

  return document.querySelector('[data-clarify-drafts]') as HTMLElement | null
}

beforeEach(() => {
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  view('session-1', 'stored-1')
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
  vi.clearAllMocks()
})

describe('clarify draft identity', () => {
  it('an identical later batch in the same session never shows the earlier request draft', async () => {
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'answer for the FIRST request')
    reload()

    // The second, identical batch timed out untouched; after the reload the card has no request id in hand.
    const drafts = settled('call-b', TIMED_OUT())

    expect(drafts).toBeNull()
    expect(screen.queryByText('answer for the FIRST request')).toBeNull()
  })

  it('after a reload the first card still finds its own draft through its exact tool-call association', async () => {
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'answer for the FIRST request')
    reload()

    const drafts = settled('call-a', TIMED_OUT())

    expect(drafts).toBeTruthy()
    expect(within(drafts as HTMLElement).getByText('answer for the FIRST request')).toBeTruthy()
  })

  it('a repeated tool-call id in one session is ambiguous: neither draft is attached', async () => {
    await typeDraft('srq-aaaaaaaaaaaa', 'call_0', 'first call_0 answer')
    await typeDraft('srq-bbbbbbbbbbbb', 'call_0', 'second call_0 answer')
    reload()

    expect(settled('call_0', TIMED_OUT())).toBeNull()
    expect(screen.queryByText(/call_0 answer/)).toBeNull()
  })

  it('the same request id on another gateway never discloses this gateway draft', async () => {
    recordSessionEventScope({ connectionId: 'gateway-a', profile: 'default', session_id: 'session-1' })
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'gateway A secret', {
      owner: { connectionId: 'gateway-a', profile: 'default' }
    })
    reload()

    // Same runtime id, same stored id, same request id, same questions: a different gateway.
    recordSessionEventScope({ connectionId: 'gateway-b', profile: 'default', session_id: 'session-1' })
    expect(settled('call-a', TIMED_OUT({ request_id: 'srq-aaaaaaaaaaaa' }))).toBeNull()
    expect(screen.queryByText('gateway A secret')).toBeNull()

    // Control: back on gateway A the exact draft is there.
    cleanup()
    recordSessionEventScope({ connectionId: 'gateway-a', profile: 'default', session_id: 'session-1' })
    expect(settled('call-a', TIMED_OUT({ request_id: 'srq-aaaaaaaaaaaa' }))?.textContent).toContain('gateway A secret')
  })

  it('the same ids under another profile never disclose this profile draft', async () => {
    recordSessionEventScope({ connectionId: 'gateway-a', profile: 'work', session_id: 'session-1' })
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'work profile secret', {
      owner: { connectionId: 'gateway-a', profile: 'work' }
    })
    reload()

    recordSessionEventScope({ connectionId: 'gateway-a', profile: 'home', session_id: 'session-1' })
    expect(settled('call-a', TIMED_OUT({ request_id: 'srq-aaaaaaaaaaaa' }))).toBeNull()
    expect(screen.queryByText('work profile secret')).toBeNull()
  })

  it('another stored session with the same runtime and request ids never sees the draft', async () => {
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'stored-1 secret')
    reload()

    view('session-1', 'stored-2')
    expect(settled('call-a', TIMED_OUT({ request_id: 'srq-aaaaaaaaaaaa' }))).toBeNull()
    expect(screen.queryByText('stored-1 secret')).toBeNull()
  })

  it('a live request whose captured owner disagrees with the session owner saves nothing on this device', async () => {
    recordSessionEventScope({ connectionId: 'gateway-b', profile: 'default', session_id: 'session-1' })
    await typeDraft('srq-aaaaaaaaaaaa', 'call-a', 'ambiguous owner text', {
      owner: { connectionId: 'gateway-a', profile: 'default' }
    })

    const stored = Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))
    expect(stored).toEqual([])
  })
})
