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

// Newest wins, per question, by revision: a timeout inside the save pause
// leaves the server (and the tool result) one edit behind this device, and a
// cleared answer must stay cleared rather than come back from an older copy.

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

const REQUEST_ID = 'srq-aaaaaaaaaaaa'

function mount() {
  const request = vi.fn(async () => ({ status: 'ok' }))
  $gateway.set({ request } as never)
  rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
  setClarifyRequest({ questions: QUESTIONS, requestId: REQUEST_ID, sessionId: 'session-1' })
  const view = render(tree(<ClarifyTool {...props()} />))

  return { request, view }
}

const acked = (request: ReturnType<typeof vi.fn>, qid: string, check: (params: Record<string, unknown>) => boolean) =>
  waitFor(
    () =>
      expect(
        request.mock.calls.some(
          call =>
            call[0] === 'clarify.draft' && (call[1] as Record<string, unknown>).question_id === qid && check(call[1])
        )
      ).toBe(true),
    { timeout: 4000 }
  )

/** The tool result after a timeout: what the SERVER last held (older than this device). */
function timeOut(view: ReturnType<typeof render>, drafts: unknown[]) {
  clearClarifyRequest(REQUEST_ID, 'session-1')
  messageRunning = false
  view.rerender(
    tree(
      <ClarifyTool
        {...props(
          JSON.stringify({
            drafts,
            drafts_notice: 'incomplete',
            drafts_submitted: false,
            outcome: 'timed_out',
            request_id: REQUEST_ID,
            responses: [
              { question: 'Which exhibitors?', status: 'unanswered', user_response: null },
              { question: 'Opening line?', status: 'unanswered', user_response: null }
            ]
          })
        )}
      />
    )
  )

  return document.querySelector('[data-clarify-drafts]') as HTMLElement | null
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

describe('clarify drafts: newest revision wins', () => {
  it('a timeout inside the save pause shows the last keystrokes, not the older server copy', async () => {
    const { request, view } = mount()
    const field = screen.getByPlaceholderText('Type your answer…')

    fireEvent.change(field, { target: { value: 'Ünïcode line one' } })
    await acked(request, 'q1', params => params.text === 'Ünïcode line one')
    fireEvent.change(field, { target: { value: 'Ünïcode line one\nand the last line ✓' } })

    const drafts = timeOut(view, [
      { question: 'Opening line?', question_index: 1, selected_choices: [], typed_text: 'Ünïcode line one' }
    ])

    expect(drafts?.textContent).toContain('Ünïcode line one\nand the last line ✓')
    // This newest version only exists on this device: the row says so.
    expect(drafts?.querySelector('[data-clarify-draft-device-only]')).toBeTruthy()
  })

  it('a cleared answer stays cleared: the older server copy is not resurrected on the timed-out card', async () => {
    const { request, view } = mount()

    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.change(screen.getByPlaceholderText(/Other/), { target: { value: 'plus Delta' } })
    await acked(request, 'q0', params => (params.choices as string[]).includes('Bolt') && params.text === 'plus Delta')
    // Deselect and clear inside the save pause, then the wait ends.
    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.change(screen.getByPlaceholderText(/Other/), { target: { value: '' } })

    const drafts = timeOut(view, [
      { question: 'Which exhibitors?', question_index: 0, selected_choices: ['Bolt'], typed_text: 'plus Delta' }
    ])

    expect(drafts).toBeNull()
    expect(screen.queryByText('plus Delta')).toBeNull()
  })

  it('a partly deselected multi-select keeps exactly the remaining choices', async () => {
    const { request, view } = mount()

    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bolt/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cobalt/ }))
    await acked(request, 'q0', params => (params.choices as string[]).length === 3)
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))

    const drafts = timeOut(view, [
      { question: 'Which exhibitors?', question_index: 0, selected_choices: ['Acme', 'Bolt', 'Cobalt'], typed_text: '' }
    ])

    expect(drafts?.textContent).toContain('Bolt, Cobalt')
    expect(drafts?.textContent).not.toContain('Acme')
  })
})
