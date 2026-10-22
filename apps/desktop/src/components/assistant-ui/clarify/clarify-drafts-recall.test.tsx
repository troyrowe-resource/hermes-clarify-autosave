import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest } from '@/store/clarify'
import { clarifyDraftKey, resetClarifyDraftsForTests, resolveClarifyDraftScope } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Native durable recall: after an app restart (this device's copy gone) the
// timed-out card reads the backend's durable record back through
// `clarify.drafts` for the SAME owned session, and shows it without sending
// anything. With no exact request id, it lists the session's records
// explicitly instead of guessing by question text.

let messageRunning = false

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: 'assistant-1', status: { type: messageRunning ? 'running' : 'complete' } },
      thread: { isRunning: messageRunning }
    })
}))

const QUESTIONS = [
  { choices: ['Acme', 'Bolt', 'Cobalt'], multi_select: true, qid: 'q0', question: 'Which exhibitors?' },
  { choices: null, multi_select: false, qid: 'q1', question: 'Opening line?' }
]

const ARGS = {
  questions: QUESTIONS.map(({ choices, multi_select, question }) => ({ choices, multi_select, question }))
}

const record = (requestId: string, drafts: Record<string, unknown>, updatedAt = 1_792_000_000) => ({
  created_at: updatedAt - 60,
  drafts,
  outcome: 'timed_out',
  questions: QUESTIONS,
  request_id: requestId,
  updated_at: updatedAt
})

const result = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    outcome: 'timed_out',
    responses: [
      { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
      { question: 'Opening line?', status: 'unanswered', user_response: null }
    ],
    ...extra
  })

const props = (toolCallId: string, value: unknown) =>
  ({
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result: value,
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

type Reply = (method: string, params: Record<string, unknown>) => unknown

function gateway(reply: Reply) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  $gateway.set({ request } as never)

  return request
}

const recover = () => fireEvent.click(screen.getByRole('button', { name: /Show drafts saved on the server/ }))

const sent = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(call => call[0] as string)

beforeEach(() => {
  window.localStorage.clear()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  // A restarted app: a NEW runtime id for the same stored conversation.
  $activeSessionId.set('session-after-restart')
  $selectedStoredSessionId.set('stored-1')
  messageRunning = false
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  resetClarifyDraftsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
})

describe('clarify durable draft recall', () => {
  it('reads the exact request back from the server after a restart and shows it without sending anything', async () => {
    const request = gateway(method =>
      method === 'clarify.drafts'
        ? {
            drafts: [
              record('srq-aaaaaaaaaaaa', {
                q0: { choices: ['Acme', 'Cobalt'], revision: 7, text: 'plus Delta' },
                q1: { choices: [], revision: 8, text: 'Línea uno\nline two ✓' }
              })
            ]
          }
        : { status: 'ok' }
    )

    render(tree(<ClarifyTool {...props('call-a', result({ request_id: 'srq-aaaaaaaaaaaa' }))} />))
    // Nothing is read until the user asks.
    expect(sent(request)).toEqual([])
    recover()

    const recovered = await waitFor(() => {
      const node = document.querySelector('[data-clarify-drafts-recovered="exact"]') as HTMLElement
      expect(node).toBeTruthy()

      return node
    })

    expect(within(recovered).getByText('Acme, Cobalt')).toBeTruthy()
    expect(within(recovered).getByText('plus Delta')).toBeTruthy()
    expect(recovered.textContent).toContain('Línea uno\nline two ✓')
    expect(request).toHaveBeenCalledWith('clarify.drafts', {
      request_id: 'srq-aaaaaaaaaaaa',
      session_id: 'session-after-restart'
    })
    expect(sent(request)).toEqual(['clarify.drafts'])
  })

  it('correlates through the backend drafts_request_id field of the tool result', async () => {
    const request = gateway(method =>
      method === 'clarify.drafts'
        ? { drafts: [record('srq-eeeeeeeeeeee', { q1: { choices: [], revision: 4, text: 'owner gateway draft' } })] }
        : { status: 'ok' }
    )

    render(
      tree(
        <ClarifyTool
          {...props(
            'call-unknown',
            result({
              drafts: [
                {
                  question: 'Opening line?',
                  question_index: 1,
                  selected_choices: [],
                  typed_text: 'owner gateway draft'
                }
              ],
              drafts_request_id: 'srq-eeeeeeeeeeee',
              drafts_submitted: false
            })
          )}
        />
      )
    )
    recover()

    await waitFor(() => expect(document.querySelector('[data-clarify-drafts-recovered="exact"]')).toBeTruthy())
    expect(request).toHaveBeenCalledWith('clarify.drafts', {
      request_id: 'srq-eeeeeeeeeeee',
      session_id: 'session-after-restart'
    })
  })

  it('without an exact request id, lists the session records explicitly and attaches none to this card', async () => {
    gateway(method =>
      method === 'clarify.drafts'
        ? {
            drafts: [
              record(
                'srq-bbbbbbbbbbbb',
                { q1: { choices: [], revision: 3, text: 'second identical batch' } },
                1_792_000_100
              ),
              record(
                'srq-aaaaaaaaaaaa',
                { q1: { choices: [], revision: 2, text: 'first identical batch' } },
                1_792_000_000
              )
            ]
          }
        : { status: 'ok' }
    )

    render(tree(<ClarifyTool {...props('call-unknown', result())} />))
    recover()

    const listing = await waitFor(() => {
      const node = document.querySelector('[data-clarify-drafts-recovered="session"]') as HTMLElement
      expect(node).toBeTruthy()

      return node
    })

    expect(listing.querySelectorAll('[data-clarify-drafts-record]')).toHaveLength(2)
    expect(within(listing).getByText('second identical batch')).toBeTruthy()
    expect(within(listing).getByText('first identical batch')).toBeTruthy()
    expect(within(listing).getByText(/not matched to this form/)).toBeTruthy()
    expect(document.querySelector('[data-clarify-drafts-recovered="exact"]')).toBeNull()
  })

  it('a newer server revision wins over an older device copy, and a newer cleared device copy wins over the server', async () => {
    const scope = resolveClarifyDraftScope({ sessionId: 'session-after-restart', storedSessionId: 'stored-1' })
    expect(scope).toBeTruthy()
    window.localStorage.setItem(
      clarifyDraftKey(scope!, 'srq-aaaaaaaaaaaa'),
      JSON.stringify({
        ...scope,
        drafts: {
          q0: { choices: [], revision: 20, text: '' },
          q1: { choices: [], revision: 5, text: 'older on this device' }
        },
        questions: QUESTIONS.map(({ choices, multi_select, qid, question }) => ({
          choices,
          multiSelect: multi_select,
          qid,
          question
        })),
        requestId: 'srq-aaaaaaaaaaaa',
        savedAt: 1,
        server: 'saved',
        sessionId: 'session-1',
        storedSessionId: 'stored-1',
        toolCallId: 'call-a',
        v: 2
      })
    )
    gateway(method =>
      method === 'clarify.drafts'
        ? {
            drafts: [
              record('srq-aaaaaaaaaaaa', {
                q0: { choices: ['Bolt'], revision: 9, text: 'cleared later on this device' },
                q1: { choices: [], revision: 9, text: 'newer from another window' }
              })
            ]
          }
        : { status: 'ok' }
    )

    render(tree(<ClarifyTool {...props('call-a', result({ request_id: 'srq-aaaaaaaaaaaa' }))} />))
    recover()

    const recovered = await waitFor(() => {
      const node = document.querySelector('[data-clarify-drafts-recovered="exact"]') as HTMLElement
      expect(node).toBeTruthy()

      return node
    })

    expect(recovered.textContent).toContain('newer from another window')
    expect(document.body.textContent).not.toContain('older on this device')
    expect(document.body.textContent).not.toContain('cleared later on this device')
  })

  it('an older backend without clarify.drafts says recall is unavailable once and never retries', async () => {
    const request = gateway(method => {
      if (method === 'clarify.drafts') {
        throw Object.assign(new Error('unknown method: clarify.drafts'), { code: -32601 })
      }

      return { status: 'ok' }
    })

    render(tree(<ClarifyTool {...props('call-a', result({ request_id: 'srq-aaaaaaaaaaaa' }))} />))
    recover()

    await waitFor(() => expect(screen.getByText(/This server cannot recall saved drafts/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Show drafts saved on the server/ })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent(request)).toEqual(['clarify.drafts'])

    // Another card for the same owner does not ask again either.
    cleanup()
    render(tree(<ClarifyTool {...props('call-b', result({ request_id: 'srq-bbbbbbbbbbbb' }))} />))
    expect(screen.queryByRole('button', { name: /Show drafts saved on the server/ })).toBeNull()
    expect(screen.getByText(/This server cannot recall saved drafts/)).toBeTruthy()
    expect(sent(request)).toEqual(['clarify.drafts'])
  })
})
