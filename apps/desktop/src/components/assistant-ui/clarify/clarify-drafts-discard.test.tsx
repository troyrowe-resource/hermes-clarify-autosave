import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { readClarifyDrafts, resetClarifyDraftsForTests, resolveClarifyDraftScope } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Discard must say exactly which copies it removed, and a pending autosave is
// bound to the gateway it was made on: a switch during the save pause never
// carries the draft to another server.

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

const REQUEST_ID = 'srq-aaaaaaaaaaaa'

const RESULT = JSON.stringify({
  outcome: 'timed_out',
  request_id: REQUEST_ID,
  responses: [
    { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
    { question: 'Opening line?', status: 'unanswered', user_response: null }
  ]
})

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

const gatewayWith = (reply: Reply) => {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))

  return { gateway: { request } as never, request }
}

const scope = () => resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' })

/** Type on the live card, let the autosave land, then time the card out. */
async function draftThenTimeOut(reply: Reply) {
  const { gateway, request } = gatewayWith(reply)
  $gateway.set(gateway)
  rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
  const view = render(tree(<ClarifyTool {...props()} />))
  fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'to be discarded' } })
  await waitFor(() => expect(request.mock.calls.some(call => call[0] === 'clarify.draft')).toBe(true), {
    timeout: 4000
  })
  clearClarifyRequest(REQUEST_ID, 'session-1')
  messageRunning = false
  view.rerender(tree(<ClarifyTool {...props(RESULT)} />))

  return request
}

const discard = () => fireEvent.click(screen.getByRole('button', { name: /Discard drafts/ }))

beforeEach(() => {
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
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
})

describe('clarify draft discard and owner-bound autosave', () => {
  it('says both copies were removed only when the server confirms its removal', async () => {
    const request = await draftThenTimeOut(method =>
      method === 'clarify.drafts.discard' ? { status: 'ok' } : { status: 'ok' }
    )

    discard()

    await waitFor(() => expect(screen.getByText(/Removed from this device and the server/)).toBeTruthy())
    expect(request).toHaveBeenCalledWith('clarify.drafts.discard', { request_id: REQUEST_ID, session_id: 'session-1' })
    expect(readClarifyDrafts(scope(), REQUEST_ID)).toBeNull()
  })

  it('says the server held no copy when it reports nothing to remove', async () => {
    await draftThenTimeOut(method => (method === 'clarify.drafts.discard' ? { status: 'missing' } : { status: 'ok' }))
    discard()

    await waitFor(() => expect(screen.getByText(/the server held no copy/)).toBeTruthy())
  })

  it('never hides a failed server deletion: the server copy is said to remain', async () => {
    await draftThenTimeOut(method => {
      if (method === 'clarify.drafts.discard') {
        throw new Error('socket closed')
      }

      return { status: 'ok' }
    })
    discard()

    await waitFor(() => expect(screen.getByText(/could not be removed from the server/)).toBeTruthy())
    expect(screen.queryByText(/Removed from this device and the server/)).toBeNull()
  })

  it('a server that reports the drafts discarded stops autosaving this request for good', async () => {
    const { gateway, request } = gatewayWith(method =>
      method === 'clarify.draft' ? { status: 'discarded' } : { status: 'ok' }
    )

    $gateway.set(gateway)
    rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
    setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
    render(tree(<ClarifyTool {...props()} />))

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'one' } })
    await waitFor(() => expect(request.mock.calls.filter(call => call[0] === 'clarify.draft')).toHaveLength(1), {
      timeout: 4000
    })
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'one two' } })
    await new Promise(resolve => setTimeout(resolve, 900))

    expect(request.mock.calls.filter(call => call[0] === 'clarify.draft')).toHaveLength(1)
    expect(request.mock.calls.some(call => call[0] === 'clarify.lock')).toBe(false)
    // This device still keeps the newest keystrokes.
    expect(readClarifyDrafts(scope(), REQUEST_ID)?.drafts.q1?.text).toBe('one two')
  })

  it('a gateway switch during the save pause sends the draft to neither server and keeps the device copy', async () => {
    const first = gatewayWith(() => ({ status: 'ok' }))
    const second = gatewayWith(() => ({ status: 'ok' }))
    $gateway.set(first.gateway)
    rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
    setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
    render(tree(<ClarifyTool {...props()} />))

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'typed on the first gateway' }
    })
    $gateway.set(second.gateway)
    await new Promise(resolve => setTimeout(resolve, 900))

    expect(second.request.mock.calls.filter(call => call[0] === 'clarify.draft')).toHaveLength(0)
    expect(first.request.mock.calls.filter(call => call[0] === 'clarify.draft')).toHaveLength(0)
    expect(readClarifyDrafts(scope(), REQUEST_ID)?.drafts.q1?.text).toBe('typed on the first gateway')
    expect(document.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')).toBe(
      'device-only'
    )
  })
})
