import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { resetClarifyDraftsForTests } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { ClarifyTool } from './index'

// Device-copy durability: no silent eviction, and a status line that never
// claims the newest keystrokes are safe when neither copy holds them.

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

const props = (toolCallId: string, result?: unknown) =>
  ({
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
  }) as ToolCallMessagePartProps

const tree = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {ui}
  </I18nProvider>
)

const deviceKeys = () => Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))

type Reply = (method: string, params: Record<string, unknown>) => unknown

function mount(requestId: string, toolCallId: string, reply: Reply = () => ({ status: 'ok' })) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => reply(method, params))
  $gateway.set({ request } as never)
  rememberServerRequest({ fail: vi.fn(), id: requestId, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId, sessionId: 'session-1' })
  const view = render(tree(<ClarifyTool {...props(toolCallId)} />))

  return { request, view }
}

const statusLine = () => document.querySelector('[data-clarify-draft-state]')

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

describe('clarify device copy durability', () => {
  it('keeps every recoverable draft: more than forty requests are never silently evicted', () => {
    for (let index = 0; index < 45; index += 1) {
      const requestId = `srq-${String(index).padStart(12, '0')}`
      const { view } = mount(requestId, `call-${index}`)
      fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: `answer ${index}` } })
      view.unmount()
      clearClarifyRequest(requestId, 'session-1')
    }

    expect(deviceKeys()).toHaveLength(45)
    expect(deviceKeys().some(key => key.endsWith('srq-000000000000'))).toBe(true)
  })

  it('says the draft is NOT saved when this device cannot store it and the server has not confirmed it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    mount('srq-aaaaaaaaaaaa', 'call-a', method => {
      if (method === 'clarify.draft') {
        throw Object.assign(new Error('unknown method: clarify.draft'), { code: -32601 })
      }

      return { status: 'ok' }
    })

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'nowhere safe' } })

    // At once (inside the save pause) and after the server refuses, neither copy holds it.
    await waitFor(() => expect(statusLine()?.getAttribute('data-clarify-draft-state')).toBe('not-saved'))
    expect(statusLine()?.textContent).toMatch(/Not saved/)
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(statusLine()?.getAttribute('data-clarify-draft-state')).toBe('not-saved')
    expect(statusLine()?.textContent).not.toMatch(/Draft saved|kept on this device/)
  })

  it('says the server holds the draft (and this device does not) once the server acknowledges the newest revision', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    // Final contract: only `durable: true` for the exact revision is proof the server holds it on disk.
    mount('srq-aaaaaaaaaaaa', 'call-a', (method, params) =>
      method === 'clarify.draft' ? { durable: true, revision: params.revision, status: 'ok' } : { status: 'ok' }
    )

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'server has it' } })
    expect(statusLine()?.getAttribute('data-clarify-draft-state')).toBe('not-saved')
    await waitFor(() => expect(statusLine()?.getAttribute('data-clarify-draft-state')).toBe('server-only'), {
      timeout: 4000
    })

    // A newer keystroke the server has not confirmed is not safe again.
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'server has it, and more' } })
    await waitFor(() => expect(statusLine()?.getAttribute('data-clarify-draft-state')).toBe('not-saved'))
  })

  it('a storage failure never drops the copy this renderer holds: the timed-out card still shows it', async () => {
    const { view } = mount('srq-aaaaaaaaaaaa', 'call-a', method => {
      if (method === 'clarify.draft') {
        throw Object.assign(new Error('unknown method: clarify.draft'), { code: -32601 })
      }

      return { status: 'ok' }
    })

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'first' } })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'first, then the last words' }
    })

    clearClarifyRequest('srq-aaaaaaaaaaaa', 'session-1')
    messageRunning = false
    view.rerender(
      tree(
        <ClarifyTool
          {...props(
            'call-a',
            JSON.stringify({
              outcome: 'timed_out',
              request_id: 'srq-aaaaaaaaaaaa',
              responses: [
                { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
                { question: 'Opening line?', status: 'unanswered', user_response: null }
              ]
            })
          )}
        />
      )
    )

    expect(document.querySelector('[data-clarify-drafts]')?.textContent).toContain('first, then the last words')
    // The older stored copy was not deleted either.
    vi.restoreAllMocks()
    expect(deviceKeys()).toHaveLength(1)
  })
})
