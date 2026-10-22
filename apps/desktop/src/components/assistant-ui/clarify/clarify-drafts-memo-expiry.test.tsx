import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { REFUSAL_TTL_MS } from '@/store/clarify-batch'
import {
  recallServerClarifyDrafts,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// An owner that answered "method not found" to a draft RPC is an older backend, and what is remembered about it
// is bounded like the `clarify_batch` refusal is: a runtime upgrade restarts the owner under the SAME route, so
// the memory must lapse instead of keeping drafts device-only until the app is reloaded.

let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: 'assistant-1', status: { type: messageRunning ? 'running' : 'complete' } },
      thread: { isRunning: messageRunning }
    })
}))

const QUESTIONS = [{ choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }]
const ARGS = { questions: [{ question: 'Opening line?' }] }
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

const SETTLED = JSON.stringify({
  outcome: 'timed_out',
  request_id: REQUEST_ID,
  responses: [{ question: 'Opening line?', status: 'unanswered', user_response: null }]
})

const methodMissing = (method: string) => Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })

let container: HTMLElement

const state = () => container.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')
const field = () => screen.getByPlaceholderText('Type your answer…')
const drafts = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(call => call[0] === 'clarify.draft')

/** Move the clock past the memory without waiting for it. */
const afterTheMemoLapses = () => vi.setSystemTime(Date.now() + REFUSAL_TTL_MS + 1000)

beforeEach(() => {
  // Only the clock is faked: the save pause and the test's own waits stay real.
  vi.useFakeTimers({ toFake: ['Date'] })
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
  messageRunning = true
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  clearClarifyRequest()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
})

describe('a backend remembered as lacking the draft RPCs', () => {
  it('is asked to save drafts again once the memory lapses (the same route, an upgraded backend)', async () => {
    let missing = true

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'clarify.draft') {
        return { status: 'ok' }
      }

      if (missing) {
        throw methodMissing(method)
      }

      return { durable: true, revision: params.revision, status: 'ok' }
    })

    $gateway.set({ request } as never)
    rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
    setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
    container = render(tree(<ClarifyTool {...props()} />)).container

    fireEvent.change(field(), { target: { value: 'one' } })
    await waitFor(() => expect(state()).toBe('unavailable'), { timeout: 4000 })
    expect(drafts(request)).toHaveLength(1)

    // Still in force: nobody is asked.
    fireEvent.change(field(), { target: { value: 'one two' } })
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(drafts(request)).toHaveLength(1)

    missing = false
    afterTheMemoLapses()
    fireEvent.change(field(), { target: { value: 'one two three' } })

    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(drafts(request)).toHaveLength(2)
  })

  it('is asked to recall drafts again once the memory lapses', async () => {
    const scope = resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' })
    let missing = true

    const request = vi.fn(async (method: string) => {
      if (missing) {
        throw methodMissing(method)
      }

      return { drafts: [] }
    })

    $gateway.set({ request } as never)

    expect(await recallServerClarifyDrafts(scope, 'session-1', REQUEST_ID)).toEqual({ status: 'unavailable' })
    missing = false

    // Still in force: no second request is made for it.
    expect(await recallServerClarifyDrafts(scope, 'session-1', REQUEST_ID)).toEqual({ status: 'unavailable' })
    expect(request).toHaveBeenCalledTimes(1)

    afterTheMemoLapses()

    expect(await recallServerClarifyDrafts(scope, 'session-1', REQUEST_ID)).toEqual({ records: [], status: 'ok' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops saying a settled card cannot recall once the memory has lapsed, and offers the recall again', async () => {
    const request = vi.fn(async (method: string) => {
      throw methodMissing(method)
    })

    $gateway.set({ request } as never)
    messageRunning = false
    const view = render(tree(<ClarifyTool key="first" {...props(SETTLED)} />))
    container = view.container

    fireEvent.click(screen.getByRole('button', { name: /Show drafts saved on the server/ }))
    await waitFor(() => expect(screen.getByText(/This server cannot recall saved drafts/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Show drafts saved on the server/ })).toBeNull()

    afterTheMemoLapses()
    view.rerender(tree(<ClarifyTool key="second" {...props(SETTLED)} />))

    expect(screen.queryByText(/This server cannot recall saved drafts/)).toBeNull()
    expect(screen.getByRole('button', { name: /Show drafts saved on the server/ })).toBeTruthy()
  })
})
