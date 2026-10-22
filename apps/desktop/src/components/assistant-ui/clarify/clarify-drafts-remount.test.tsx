import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, type ClarifyRequest } from '@/store/clarify'
import {
  readClarifyDrafts,
  recordClarifyDraft,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// The turn ends and the stored transcript replaces the live message: its id, so its React key, changes and every
// card in it is mounted again (a trace of the native Windows run caught `assistant-stream-<ms>-<n>` becoming
// `<ts>-<n>-assistant` while a click was being handled). Recall and discard are asynchronous and explicit, so what a
// click started must still be there, in flight or finished, on the card that replaces the one clicked.

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'assistant-1', status: { type: 'complete' } }, thread: { isRunning: false } })
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
const OTHER_REQUEST_ID = 'srq-bbbbbbbbbbbb'

const resultFor = (requestId: string) =>
  JSON.stringify({
    outcome: 'timed_out',
    request_id: requestId,
    responses: [
      { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
      { question: 'Opening line?', status: 'unanswered', user_response: null }
    ]
  })

const props = (toolCallId: string, result: string) =>
  ({
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: { type: 'complete' },
    toolCallId,
    toolName: 'clarify',
    type: 'tool-call'
  }) as ToolCallMessagePartProps

const tree = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {ui}
  </I18nProvider>
)

/** The settled card of one tool call, under the React key its message has at that moment. */
const card = (messageId: string, toolCallId: string, requestId: string) =>
  tree(<ClarifyTool key={messageId} {...props(toolCallId, resultFor(requestId))} />)

/** The live message, then the stored one the turn's end swaps in. */
const LIVE = 'assistant-stream-1792664880214-3'
const STORED = '1792664935.8949223-3-assistant'

const record = (requestId: string, text: string) => ({
  created_at: 1_792_000_000,
  drafts: { q1: { choices: [], revision: 8, text } },
  outcome: 'timed_out',
  questions: QUESTIONS.map(({ choices, multiSelect, qid, question }) => ({
    choices,
    multi_select: multiSelect,
    qid,
    question
  })),
  request_id: requestId,
  updated_at: 1_792_000_060
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })

  return { promise, resolve }
}

type Reply = (method: string, params: Record<string, unknown>) => unknown

function gateway(reply: Reply) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  $gateway.set({ request } as never)

  return request
}

const recallButton = () => screen.getByRole('button', { name: /Show drafts saved on the server/ })
const readingButton = () => screen.getByRole('button', { name: /Reading saved drafts/ })
const recalls = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(call => call[0] === 'clarify.drafts')

let container: HTMLElement

const recovered = () => container.querySelector('[data-clarify-drafts-recovered="exact"]') as HTMLElement | null

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
})

describe('a settled clarify card that is mounted again while the user acts on it', () => {
  it('keeps a recall that is still being read, and shows the exact record when it arrives', async () => {
    const read = deferred<unknown>()
    const request = gateway(method => (method === 'clarify.drafts' ? read.promise : { status: 'ok' }))
    const view = render(card(LIVE, 'call-a', REQUEST_ID))
    container = view.container

    fireEvent.click(recallButton())
    await waitFor(() => expect(recalls(request)).toHaveLength(1))
    expect(readingButton()).toBeTruthy()

    // The turn ends: the message is replaced under another key, so this card is a new component instance.
    view.rerender(card(STORED, 'call-a', REQUEST_ID))
    container = view.container

    // The read the user asked for is still the read in flight: no idle button to click again, no second request.
    expect(readingButton()).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show drafts saved on the server/ })).toBeNull()

    read.resolve({ drafts: [record(REQUEST_ID, 'typed before the turn ended')] })

    await waitFor(() => expect(recovered()).toBeTruthy())
    expect(within(recovered() as HTMLElement).getByText('typed before the turn ended')).toBeTruthy()
    expect(recalls(request)).toHaveLength(1)
  })

  it('shows a recall that finished before the card was mounted again, without reading it twice', async () => {
    const request = gateway(method =>
      method === 'clarify.drafts' ? { drafts: [record(REQUEST_ID, 'exactly this')] } : { status: 'ok' }
    )

    const view = render(card(LIVE, 'call-a', REQUEST_ID))
    container = view.container
    fireEvent.click(recallButton())
    await waitFor(() => expect(recovered()).toBeTruthy())

    view.rerender(card(STORED, 'call-a', REQUEST_ID))
    container = view.container

    expect(recovered()).toBeTruthy()
    expect(within(recovered() as HTMLElement).getByText('exactly this')).toBeTruthy()
    expect(recalls(request)).toHaveLength(1)
  })

  it('does not carry one request\'s recall to another request\'s card', async () => {
    gateway(method => (method === 'clarify.drafts' ? { drafts: [record(REQUEST_ID, 'belongs to the first')] } : { status: 'ok' }))

    const view = render(card(LIVE, 'call-a', REQUEST_ID))
    container = view.container
    fireEvent.click(recallButton())
    await waitFor(() => expect(recovered()).toBeTruthy())

    // The same tool-call id under another request (providers that name every call `call_0`): its own, untouched card.
    view.rerender(card(STORED, 'call-a', OTHER_REQUEST_ID))
    container = view.container

    expect(recovered()).toBeNull()
    expect(recallButton()).toBeTruthy()
  })

  it('keeps a discard that is still being sent, and then says exactly what the server confirmed', async () => {
    const scope = resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' })
    expect(scope).toBeTruthy()
    recordClarifyDraft(
      scope,
      { questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' } as ClarifyRequest,
      QUESTIONS[1],
      { choices: [], draft: 'to be discarded' },
      { toolCallId: 'call-a' }
    )

    const removal = deferred<unknown>()
    const request = gateway(method => (method === 'clarify.drafts.discard' ? removal.promise : { status: 'ok' }))
    const view = render(card(LIVE, 'call-a', REQUEST_ID))
    container = view.container

    fireEvent.click(screen.getByRole('button', { name: /Discard drafts/ }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('clarify.drafts.discard', expect.anything()))
    expect(readClarifyDrafts(scope, REQUEST_ID)).toBeNull()

    view.rerender(card(STORED, 'call-a', REQUEST_ID))
    container = view.container

    // The mounted-again card is still discarding, and is not offering the drafts as if nothing had happened.
    expect(screen.getByText(/Discarding drafts/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Discard drafts/ })).toBeNull()

    removal.resolve({ status: 'ok' })

    await waitFor(() => expect(screen.getByText(/Removed from this device and the server/)).toBeTruthy())
  })
})
