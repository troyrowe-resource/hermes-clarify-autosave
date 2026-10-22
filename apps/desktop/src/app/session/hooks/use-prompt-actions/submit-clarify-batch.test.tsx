import { JsonRpcGatewayError } from '@hermes/shared'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $clarifyBatchRefusals, resetClarifyBatchForTests } from '@/store/clarify-batch'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $sessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { useSubmitPrompt } from './submit'
import type { GatewayRequest } from './utils'

vi.mock('@/store/gateway', async original => ({
  ...(await original<Record<string, unknown>>()),
  retainGatewayForSessionTurn: vi.fn(async () => () => undefined)
}))

type ClientSessionState = ReturnType<typeof createClientSessionState>
type Params = Record<string, unknown>

// A canonical (`hermes gateway ensure`) dial carries `native_dial`; a legacy `hermes serve` dial a token.
const CANONICAL = 'ws://127.0.0.1:1/api/ws?native_dial=unminted'
const LEGACY = 'ws://127.0.0.1:2/api/ws?token=t'

const connect = (wsUrl: string) =>
  $connection.set({ baseUrl: 'http://127.0.0.1:1', connectionId: 'local', mode: 'local', token: '', wsUrl } as never)

beforeEach(() => {
  window.localStorage.clear()
  $sessions.set([])
  $sessionStates.set({})
  $activeGatewayProfile.set('default')
  resetClarifyBatchForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $connection.set(null)
})

const admitted = (params?: Params) => ({
  admission_id: params?.submission_id,
  session_id: 'runtime-a',
  status: 'started',
  submission_id: params?.submission_id
})

function mount(requestGateway: GatewayRequest) {
  let state: ClientSessionState = createClientSessionState()

  const deps = {
    activeSessionIdRef: { current: 'runtime-a' as string | null },
    selectedStoredSessionIdRef: { current: 'stored-a' as string | null },
    busyRef: { current: false },
    copy: en.desktop,
    createBackendSessionForSend: vi.fn(async () => null),
    getRoutedStoredSessionId: () => null,
    getRuntimeIdForStoredSession: () => 'runtime-a',
    getRouteToken: () => 'same-route',
    requestGateway,
    runtimeIdByStoredSessionIdRef: { current: new Map([['stored-a', 'runtime-a']]) },
    resumeStoredSession: vi.fn(),
    syncAttachmentsForSubmit: vi.fn(async (sessionId: string) => ({ sessionId, attachments: [] })),
    updateSessionState: vi.fn((_sid: string, updater: (s: ClientSessionState) => ClientSessionState) => {
      state = updater(state)

      return state
    })
  }

  const { result } = renderHook(() => useSubmitPrompt(deps as never))

  return {
    send: (text: string, submissionId: string) =>
      act(async () => result.current(text, { submission_id: submissionId })),
    state: () => state
  }
}

const submitsOf = (requestGateway: ReturnType<typeof vi.fn>): Params[] =>
  requestGateway.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, params]) => params as Params)

describe('Desktop prompt.submit and the clarify batch opt-in', () => {
  it('offers clarify_batch to a canonical owner, on the identified submit', async () => {
    connect(CANONICAL)
    const requestGateway = vi.fn(async (_method: string, params?: Params) => admitted(params) as never)
    const { send, state } = mount(requestGateway as GatewayRequest)

    expect(await send('ask me things', 'sub-1')).toBe(true)

    const submits = submitsOf(requestGateway)
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({ clarify_batch: true, submission_id: 'sub-1', text: 'ask me things' })
    expect(state().messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('never sends it to a legacy hermes serve, including on its identityless retry', async () => {
    connect(LEGACY)

    const requestGateway = vi.fn(async (method: string, params?: Params) => {
      if (method === 'prompt.submit' && params && 'submission_id' in params) {
        throw Object.assign(new Error('submission_id: Extra inputs are not permitted'), { code: 4000 })
      }

      return { status: 'streaming' } as never
    })

    const { send } = mount(requestGateway as GatewayRequest)
    expect(await send('hi remote', 'sub-1')).toBe(true)

    const submits = submitsOf(requestGateway)
    expect(submits).toHaveLength(2)
    submits.forEach(params => expect(params).not.toHaveProperty('clarify_batch'))
    expect(submits[1]).not.toHaveProperty('submission_id')
  })

  it('resends once without it, under the same submission id and as a single turn, when the owner predates the field', async () => {
    connect(CANONICAL)

    const requestGateway = vi.fn(async (_method: string, params?: Params) => {
      if (params && 'clarify_batch' in params) {
        throw new JsonRpcGatewayError('invalid_params', {
          code: 4001,
          data: { fields: ['clarify_batch'], reason: 'invalid_params' }
        })
      }

      return admitted(params) as never
    })

    const { send, state } = mount(requestGateway as GatewayRequest)
    expect(await send('first', 'sub-1')).toBe(true)

    expect(submitsOf(requestGateway).map(params => ['clarify_batch' in params, params.submission_id])).toEqual([
      [true, 'sub-1'],
      [false, 'sub-1']
    ])
    expect(state().messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(Object.keys($clarifyBatchRefusals.get())).toHaveLength(1)

    // The owner is remembered: the next submit is plain at once, not another refused probe.
    requestGateway.mockClear()
    expect(await send('second', 'sub-2')).toBe(true)
    expect(submitsOf(requestGateway)).toHaveLength(1)
    expect(submitsOf(requestGateway)[0]).not.toHaveProperty('clarify_batch')
  })

  it('surfaces any other refusal without a resend and keeps offering the key', async () => {
    connect(CANONICAL)

    const requestGateway = vi.fn(async (method: string, params?: Params) => {
      if (method === 'prompt.submit') {
        throw new JsonRpcGatewayError('invalid_params', {
          code: 4001,
          data: { fields: ['attachments'], reason: 'invalid_params' }
        })
      }

      return admitted(params) as never
    })

    const { send } = mount(requestGateway as GatewayRequest)
    expect(await send('with a bad attachment', 'sub-1')).toBe(false)

    expect(submitsOf(requestGateway)).toHaveLength(1)
    expect($clarifyBatchRefusals.get()).toEqual({})
  })
})
