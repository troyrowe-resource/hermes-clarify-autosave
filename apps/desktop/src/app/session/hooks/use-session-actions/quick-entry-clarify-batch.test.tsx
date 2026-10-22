import { JsonRpcGatewayError } from '@hermes/shared'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { resetClarifyBatchForTests } from '@/store/clarify-batch'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, setSessions } from '@/store/session'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'

import type { ClientSessionState } from '../../../types'

import { useSessionActions } from './index'

// A quick-entry send to a NEW chat creates the session and submits its first prompt in one task. The turn that
// prompt starts is asked clarify questions like any other, so it is offered the batch form as a normal submit is.

vi.mock('@/app/contrib/hooks/use-background-sync', () => ({ resetLiveRuntimeTracking: vi.fn() }))

const CANONICAL = 'ws://127.0.0.1:1/api/ws?native_dial=unminted'
const LEGACY = 'ws://127.0.0.1:2/api/ws?token=t'

type Params = Record<string, unknown>
type SubmitNew = ReturnType<typeof useSessionActions>['submitTextToNewSession']

const connect = (wsUrl: string) =>
  $connection.set({ baseUrl: 'http://127.0.0.1:1', connectionId: 'local', mode: 'local', token: '', wsUrl } as never)

function Harness({ onReady, requestGateway }: { onReady: (submit: SubmitNew) => void; requestGateway: never }) {
  const states = useRef(new Map<string, ClientSessionState>())
  const activeSessionIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)
  const runtimeIdByStoredSessionIdRef = useRef(new Map<string, string>())
  const selectedStoredSessionIdRef = useRef<string | null>(null)

  const actions = useSessionActions({
    activeSessionId: null,
    activeSessionIdRef,
    busyRef,
    creatingSessionRef,
    ensureSessionState: () => createClientSessionState(null),
    getRouteToken: () => 'token',
    getRoutedStoredSessionId: () => null,
    navigate: vi.fn() as never,
    requestGateway,
    resetViewSync: vi.fn(),
    routedSessionId: null,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId: null,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef: states,
    syncSessionStateToView: vi.fn(),
    updateSessionState: (id, updater, storedId) => {
      const next = updater(states.current.get(id) ?? createClientSessionState(storedId ?? null))
      states.current.set(id, next)
      publishSessionState(id, next)

      return next
    }
  })

  useEffect(() => {
    onReady(actions.submitTextToNewSession)
  }, [actions.submitTextToNewSession, onReady])

  return null
}

/** A gateway that creates the session and answers `prompt.submit` through `onSubmit`. */
function gateway(onSubmit: (params: Params) => unknown = () => ({ status: 'streaming' })) {
  return vi.fn(async (method: string, params?: Params) => {
    if (method === 'session.create') {
      return { info: {}, session_id: 'runtime-new', stored_session_id: 'stored-new' }
    }

    if (method === 'prompt.submit') {
      return onSubmit(params ?? {})
    }

    return {}
  })
}

async function quickEntry(requestGateway: ReturnType<typeof gateway>, text: string) {
  let submit: SubmitNew | null = null
  render(
    <Harness
      onReady={ready => {
        submit = ready
      }}
      requestGateway={requestGateway as never}
    />
  )

  await act(async () => {
    await submit!(text)
  })
}

const submits = (requestGateway: ReturnType<typeof gateway>): Params[] =>
  requestGateway.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, params]) => params as Params)

beforeEach(() => {
  clearAllSessionStates()
  setSessions([])
  $activeGatewayProfile.set('default')
  resetClarifyBatchForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearAllSessionStates()
  $connection.set(null)
})

describe('quick-entry send to a new chat and the clarify batch opt-in', () => {
  it('offers clarify_batch to a canonical owner on the first prompt', async () => {
    connect(CANONICAL)
    const requestGateway = gateway()

    await quickEntry(requestGateway, 'ask me things')

    expect(submits(requestGateway)).toEqual([{ clarify_batch: true, session_id: 'runtime-new', text: 'ask me things' }])
  })

  it('never offers it to a legacy hermes serve', async () => {
    connect(LEGACY)
    const requestGateway = gateway()

    await quickEntry(requestGateway, 'ask me things')

    expect(submits(requestGateway)).toEqual([{ session_id: 'runtime-new', text: 'ask me things' }])
  })

  it('resends once without it when the owner predates the field', async () => {
    connect(CANONICAL)

    const requestGateway = gateway(params => {
      if ('clarify_batch' in params) {
        throw new JsonRpcGatewayError('invalid_params', {
          code: 4001,
          data: { fields: ['clarify_batch'], reason: 'invalid_params' }
        })
      }

      return { status: 'streaming' }
    })

    await quickEntry(requestGateway, 'ask me things')

    expect(submits(requestGateway).map(params => 'clarify_batch' in params)).toEqual([true, false])
  })
})
