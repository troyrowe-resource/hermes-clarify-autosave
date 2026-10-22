import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import {
  $clarifyDraftStatus,
  readClarifyDrafts,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Confirm is the only submission, and it supersedes drafts only where it
// actually succeeded: a failed or partial set of locks must leave every unsent
// draft recoverable, and a late autosave reply must not resurrect a copy.

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

const REQUEST_ID = 'srq-aaaaaaaaaaaa'

type Reply = (method: string, params: Record<string, unknown>) => unknown

function mount(reply: Reply) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  $gateway.set({ request } as never)
  rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
  render(tree(<ClarifyTool {...props()} />))

  return request
}

const deviceCopy = () =>
  readClarifyDrafts(resolveClarifyDraftScope({ sessionId: 'session-1', storedSessionId: 'stored-1' }), REQUEST_ID)

const locks = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(call => call[0] === 'clarify.lock')

function stageBoth() {
  fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
  fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
    target: { value: 'Opening words\nsecond line' }
  })
}

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

describe('clarify drafts and Confirm', () => {
  it('a partial Confirm (second lock fails) keeps the unlocked draft and drops only the locked one', async () => {
    const request = mount((method, params) => {
      if (method === 'clarify.lock' && params.question_id === 'q1') {
        throw new Error('socket closed')
      }

      return { remaining: ['q1'], status: 'ok' }
    })

    stageBoth()
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(locks(request)).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /Bolt/ }).hasAttribute('disabled')).toBe(false))

    const copy = deviceCopy()
    expect(copy?.drafts.q1).toMatchObject({ choices: [], text: 'Opening words\nsecond line' })
    // q0 is locked on the server: its answer wins, its draft is gone.
    expect(copy?.drafts.q0).toBeUndefined()
    expect(request.mock.calls.some(call => call[0] === 'clarify.draft' && call[1].question_id === 'q0')).toBe(false)
  })

  it('locks the server refused as expired are not a submission: every draft stays recoverable', async () => {
    const request = mount(method => (method === 'clarify.lock' ? { status: 'expired' } : { status: 'ok' }))

    stageBoth()
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(locks(request)).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 50))

    const copy = deviceCopy()
    expect(copy?.drafts.q0).toMatchObject({ choices: ['Bolt'] })
    expect(copy?.drafts.q1).toMatchObject({ text: 'Opening words\nsecond line' })
  })

  it('an autosave reply landing after a successful Confirm neither recreates nor revives the device copy', async () => {
    let releaseDraft: (value: unknown) => void = () => undefined

    const request = mount(method =>
      method === 'clarify.draft'
        ? new Promise(resolve => {
            releaseDraft = resolve
          })
        : { remaining: [], status: 'ok' }
    )

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'final' } })
    // The autosave fires and is still in flight when the user confirms.
    await waitFor(() => expect(request.mock.calls.some(call => call[0] === 'clarify.draft')).toBe(true), {
      timeout: 4000
    })
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(locks(request)).toHaveLength(2))
    await waitFor(() => expect(deviceCopy()).toBeNull())

    releaseDraft({ status: 'ok' })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(deviceCopy()).toBeNull()
    expect(Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))).toEqual([])
    expect(Object.keys($clarifyDraftStatus.get())).toEqual([])
  })
})
