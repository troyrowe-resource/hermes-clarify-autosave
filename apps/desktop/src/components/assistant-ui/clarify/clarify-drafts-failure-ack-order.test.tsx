import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { resetClarifyDraftsForTests } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'

import { ClarifyTool } from './index'

// Replies to two overlapping `clarify.draft` saves can arrive out of order on a slow connection. The
// status line may only ever say what is true: once the server has confirmed the NEWEST revision on its
// disk, a late reply for an OLDER revision must not take that confirmation back.

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'assistant-1', status: { type: 'running' } }, thread: { isRunning: true } })
}))

const QUESTIONS = [{ choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }]
const ARGS = { questions: [{ question: 'Opening line?' }] }
const REQUEST_ID = 'srq-aaaaaaaaaaaa'

const props = () =>
  ({
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'call-a',
    toolName: 'clarify',
    type: 'tool-call'
  }) as unknown as ToolCallMessagePartProps

const tree = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {ui}
  </I18nProvider>
)

beforeEach(() => {
  window.localStorage.clear()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $gateway.set(null)
})

describe('clarify draft acknowledgements arriving out of order', () => {
  it('a late disk-confirmed reply for an older revision does not downgrade the newer confirmed one', async () => {
    const release: (() => void)[] = []

    const request = vi.fn((method: string, params: Record<string, unknown>) =>
      method === 'clarify.draft'
        ? new Promise(resolve => {
            release.push(() => resolve({ durable: true, revision: params.revision, status: 'ok' }))
          })
        : Promise.resolve({ status: 'ok' })
    )

    $gateway.set({ request } as never)
    rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
    setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
    const { container } = render(tree(<ClarifyTool {...props()} />))
    const field = () => screen.getByPlaceholderText('Type your answer…')
    const state = () => container.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')

    fireEvent.change(field(), { target: { value: 'one' } })
    await waitFor(() => expect(release).toHaveLength(1), { timeout: 4000 })
    fireEvent.change(field(), { target: { value: 'one two' } })
    await waitFor(() => expect(release).toHaveLength(2), { timeout: 4000 })

    // The newer save is confirmed first, then the older one answers late.
    await act(async () => release[1]())
    await waitFor(() => expect(state()).toBe('saved'))
    await act(async () => release[0]())
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(state()).toBe('saved')
  })
})
