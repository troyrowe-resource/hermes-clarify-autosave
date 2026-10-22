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
// timeout) would stay behind until the next keystroke. The replay is also the proof that the request is open and this
// viewer is attached to it, so it is what lifts an `expired` reply that came before the session was attached again.

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

let card: HTMLElement

const mount = () => {
  card = render(tree(<ClarifyTool {...props()} />)).container
}

const state = () => card.querySelector('[data-clarify-draft-state]')?.getAttribute('data-clarify-draft-state')
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
 * the renderer tried to send while the link was down. While the socket is up but this viewer is not attached to the
 * session (`link.attached` false, right after a reconnect) the owner answers `expired`, as it does for a request it
 * will not let that viewer touch; `link.discard` makes it answer `discarded` instead. `answers` is every reply that
 * was not a save.
 */
function gateway() {
  const link = { attached: true, discard: false, up: true }
  const saves: DraftSave[] = []
  const refused: DraftSave[] = []
  const answers: string[] = []

  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method !== 'clarify.draft') {
      return Promise.resolve({ status: 'ok' })
    }

    const save = { revision: params.revision as number, text: params.text as string }

    if (!link.up) {
      refused.push(save)

      return Promise.reject(new Error('gateway not connected'))
    }

    if (link.discard || !link.attached) {
      answers.push(link.discard ? 'discarded' : 'expired')

      return Promise.resolve({ status: link.discard ? 'discarded' : 'expired' })
    }

    saves.push(save)

    return Promise.resolve({ durable: true, revision: params.revision, status: 'ok' })
  })

  $gateway.set({ request } as never)

  return { answers, link, refused, saves }
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
    mount()

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
    mount()

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
    mount()

    fireEvent.change(field(), { target: { value: 'already saved' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect(saves).toHaveLength(1)

    act(() => setClarifyRequest(delivery(2, { q1: { choices: [], revision: saves[0].revision, text: 'already saved' } })))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CLARIFY_DRAFT_SAVE_DELAY_MS + 300))
    })

    expect(saves).toHaveLength(1)
  })

  it('a draft CLEARED while the connection was down is sent as cleared, so the server stops holding the older text', async () => {
    const { link, refused, saves } = gateway()
    setClarifyRequest(delivery(1))
    mount()

    fireEvent.change(field(), { target: { value: 'text the user deletes later' } })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    const held = saves[0]

    link.up = false
    fireEvent.change(field(), { target: { value: '' } })
    await waitFor(() => expect(refused).toHaveLength(1), { timeout: 4000 })
    expect(refused[0].text).toBe('')

    // The owner replays the request still holding the older, non-blank text.
    link.up = true
    act(() => setClarifyRequest(delivery(2, { q1: { choices: [], revision: held.revision, text: held.text } })))

    await waitFor(() => expect(saves.at(-1)?.text).toBe(''), { timeout: 4000 })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
    expect((field() as HTMLTextAreaElement | HTMLInputElement).value).toBe('')
  })

  it('a draft that was never typed is not sent as cleared just because the request is delivered again', async () => {
    const { saves } = gateway()
    setClarifyRequest(delivery(1))
    mount()

    act(() => setClarifyRequest(delivery(2)))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CLARIFY_DRAFT_SAVE_DELAY_MS + 300))
    })

    expect(saves).toHaveLength(0)
  })
})

describe('server saving after an `expired` reply', () => {
  it('is not over for good when the socket was not attached to the session yet: the re-delivered open request resumes it', async () => {
    const { answers, link, saves } = gateway()
    link.attached = false
    setClarifyRequest(delivery(1))
    mount()

    fireEvent.change(field(), { target: { value: 'typed while the session re-attached' } })
    await waitFor(() => expect(answers).toEqual(['expired']), { timeout: 4000 })
    expect(state()).toBe('device-only')
    expect(saves).toHaveLength(0)

    // Attached again, the owner replays the open request: it IS open, so server saving is too.
    link.attached = true
    act(() => setClarifyRequest(delivery(2)))

    await waitFor(() => expect(saves.map(save => save.text)).toEqual(['typed while the session re-attached']), {
      timeout: 4000
    })
    await waitFor(() => expect(state()).toBe('saved'), { timeout: 4000 })
  })

  it('still sends nothing more while the request is not delivered again', async () => {
    const { answers, link } = gateway()
    link.attached = false
    setClarifyRequest(delivery(1))
    mount()

    fireEvent.change(field(), { target: { value: 'one' } })
    await waitFor(() => expect(answers).toEqual(['expired']), { timeout: 4000 })
    fireEvent.change(field(), { target: { value: 'one two' } })
    await new Promise(resolve => setTimeout(resolve, CLARIFY_DRAFT_SAVE_DELAY_MS + 300))

    expect(answers).toEqual(['expired'])
  })

  it('a `discarded` reply is final: delivering the request again never sends the draft back', async () => {
    const { answers, link } = gateway()
    link.discard = true
    setClarifyRequest(delivery(1))
    mount()

    fireEvent.change(field(), { target: { value: 'discarded elsewhere' } })
    await waitFor(() => expect(answers).toEqual(['discarded']), { timeout: 4000 })

    link.discard = false
    act(() => setClarifyRequest(delivery(2)))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CLARIFY_DRAFT_SAVE_DELAY_MS + 300))
    })

    expect(answers).toEqual(['discarded'])
    expect(state()).toBe('device-only')
  })
})
