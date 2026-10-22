import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { type ClarifyRequest, clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { CLARIFY_DRAFT_SAVE_DELAY_MS, resetClarifyDraftsForTests } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'

import { ClarifyTool } from './index'

// A reconnect usually leaves the clarify card mounted. What the user typed while the connection was down is then
// only on this device, so the owner's replay of the request (with the copy it holds, if any) has to send it again:
// nothing remounts the card to do it, and without it the server's copy (and what the assistant is told at a
// timeout) would stay behind until the next keystroke.

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'assistant-1', status: { type: 'running' } }, thread: { isRunning: true } })
}))

const QUESTIONS = [{ choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }]
const ARGS = { questions: [{ question: 'Opening line?' }] }
const REQUEST_ID = 'srq-bbbbbbbbbbbb'

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

const state = () => document.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')
const field = () => screen.getByPlaceholderText('Type your answer…')

const delivery = (receivedAt: number, drafts?: ClarifyRequest['drafts']): ClarifyRequest => ({
  drafts,
  questions: QUESTIONS,
  receivedAt,
  requestId: REQUEST_ID,
  sessionId: 'session-1'
})

interface DraftSave {
  revision: number
  text: string
}

/**
 * A gateway whose `clarify.draft` works only while `link.up`. `saves` is what the server was sent; `refused` is what
 * the renderer tried to send while the link was down.
 */
function gateway() {
  const link = { up: true }
  const saves: DraftSave[] = []
  const refused: DraftSave[] = []

  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method !== 'clarify.draft') {
      return Promise.resolve({ status: 'ok' })
    }

    const save = { revision: params.revision as number, text: params.text as string }

    if (!link.up) {
      refused.push(save)

      return Promise.reject(new Error('gateway not connected'))
    }

    saves.push(save)

    return Promise.resolve({ durable: true, revision: params.revision, status: 'ok' })
  })

  $gateway.set({ request } as never)

  return { link, refused, saves }
}

beforeEach(() => {
  window.localStorage.clear()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $activeSessionId.set('session-1')
  $selectedStoredSessionId.set('stored-1')
  rememberServerRequest({ fail: vi.fn(), id: REQUEST_ID, method: 'clarify', params: {}, respond: vi.fn() })
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

describe('clarify drafts typed while the connection was down', () => {
  it('are sent again when the owner re-delivers the request with its older copy, though the card never remounted', async () => {
    const { link, refused, saves } = gateway()
    setClarifyRequest(delivery(1))
    render(tree(<ClarifyTool {...props()} />))

    fireEvent.change(field(), { target: { value: 'typed while online' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(saves).toHaveLength(1)

    // The newest edit is made with the link down: the save is attempted, refused, and not retried by itself.
    link.up = false
    fireEvent.change(field(), { target: { value: 'typed while online + typed offline' } })
    await waitFor(() => expect(refused).toHaveLength(1), { timeout: 4000 })
    expect(state()).toBe('device-only')
    expect(saves).toHaveLength(1)

    // The connection is back: the owner's replay carries the copy it holds, the older one.
    link.up = true
    act(() => setClarifyRequest(delivery(2, { q1: { choices: [], revision: saves[0].revision, text: 'typed while online' } })))

    await waitFor(() => expect(saves.at(-1)?.text).toBe('typed while online + typed offline'), { timeout: 4000 })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect((field() as HTMLTextAreaElement | HTMLInputElement).value).toBe('typed while online + typed offline')
  })

  it('are sent when the server held nothing to replay at all (the very first edit was made offline)', async () => {
    const { link, refused, saves } = gateway()
    link.up = false
    setClarifyRequest(delivery(1))
    render(tree(<ClarifyTool {...props()} />))

    fireEvent.change(field(), { target: { value: 'first typed offline' } })
    await waitFor(() => expect(refused).toHaveLength(1), { timeout: 4000 })
    expect(state()).toBe('device-only')
    expect(saves).toHaveLength(0)

    link.up = true
    act(() => setClarifyRequest(delivery(2)))

    await waitFor(() => expect(saves.map(save => save.text)).toEqual(['first typed offline']), { timeout: 4000 })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
  })

  it('are not sent again when the replay shows the server already holds that exact revision', async () => {
    const { saves } = gateway()
    setClarifyRequest(delivery(1))
    render(tree(<ClarifyTool {...props()} />))

    fireEvent.change(field(), { target: { value: 'already saved' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(saves).toHaveLength(1)

    act(() => setClarifyRequest(delivery(2, { q1: { choices: [], revision: saves[0].revision, text: 'already saved' } })))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CLARIFY_DRAFT_SAVE_DELAY_MS + 300))
    })

    expect(saves).toHaveLength(1)
  })
})
