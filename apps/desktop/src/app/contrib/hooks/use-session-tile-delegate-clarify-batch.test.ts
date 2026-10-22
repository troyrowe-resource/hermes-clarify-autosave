import { JsonRpcGatewayError } from '@hermes/shared'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { createClientSessionState } from '@/lib/chat-runtime'
import { resetClarifyBatchForTests } from '@/store/clarify-batch'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, setSessions } from '@/store/session'
import { sessionTileDelegate } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { useSessionTileDelegate } from './use-session-tile-delegate'

// The tile delegate's `submitToSession` is how a quick-entry send reaches a session that is open as a tile. The turn
// it starts is asked clarify questions like any other, so it is offered the batch form as a normal submit is.

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: '' })),
  getSession: vi.fn()
}))
vi.mock('@/store/gateway', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn(),
  requestGatewayForProfile: vi.fn()
}))

const { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } = await import('@/hermes')
const { requestGatewayForProfile } = await import('@/store/gateway')

const CANONICAL = 'ws://127.0.0.1:1/api/ws?native_dial=unminted'
const LEGACY = 'ws://127.0.0.1:2/api/ws?token=t'
const STORED = 'stored-tile'
const RUNTIME = 'runtime-tile'

type Params = Record<string, unknown>

const connect = (wsUrl: string) =>
  $connection.set({ baseUrl: 'http://127.0.0.1:1', connectionId: 'local', mode: 'local', token: '', wsUrl } as never)

const row = (): SessionInfo =>
  ({
    ended_at: null,
    id: STORED,
    input_tokens: 0,
    is_active: false,
    last_active: 0,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    profile: 'default',
    source: null,
    started_at: 0,
    title: null
  }) as SessionInfo

function renderTile() {
  renderHook(() =>
    useSessionTileDelegate({
      archiveSession: vi.fn(async () => undefined),
      branchLoadedSession: vi.fn(async () => false) as never,
      branchStoredSession: vi.fn(async () => undefined),
      executeSlashCommand: vi.fn(async () => undefined) as never,
      removeSession: vi.fn(async () => undefined),
      requestGateway: vi.fn() as never,
      runtimeIdByStoredSessionIdRef: { current: new Map([[STORED, RUNTIME]]) } as never,
      sessionStateByRuntimeIdRef: {
        current: new Map([[RUNTIME, createClientSessionState(STORED, [])]])
      } as never,
      updateSessionState: vi.fn() as never
    })
  )
}

const submits = (): Params[] =>
  vi
    .mocked(requestGatewayForProfile)
    .mock.calls.filter(call => call[1] === 'prompt.submit')
    .map(call => call[2] as Params)

beforeEach(() => {
  setSessions([row()])
  $activeGatewayProfile.set('default')
  resetClarifyBatchForTests()
  vi.mocked(requestGatewayForProfile).mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  setSessions([])
  $connection.set(null)
})

describe('useSessionTileDelegate submitToSession and the clarify batch opt-in', () => {
  it('offers clarify_batch to a canonical owner', async () => {
    connect(CANONICAL)
    vi.mocked(requestGatewayForProfile).mockResolvedValue({} as never)
    renderTile()

    await sessionTileDelegate()!.submitToSession(RUNTIME, 'asked from quick entry')

    expect(requestGatewayForProfile).toHaveBeenCalledWith(
      'default',
      'prompt.submit',
      { clarify_batch: true, session_id: RUNTIME, text: 'asked from quick entry' },
      PROMPT_SUBMIT_REQUEST_TIMEOUT_MS,
      undefined
    )
  })

  it('never offers it to a legacy hermes serve', async () => {
    connect(LEGACY)
    vi.mocked(requestGatewayForProfile).mockResolvedValue({} as never)
    renderTile()

    await sessionTileDelegate()!.submitToSession(RUNTIME, 'asked from quick entry')

    expect(submits()).toEqual([{ session_id: RUNTIME, text: 'asked from quick entry' }])
  })

  it('resends once without it when the owner predates the field, and does not offer it again', async () => {
    connect(CANONICAL)

    vi.mocked(requestGatewayForProfile).mockImplementation((async (_profile: string, _method: string, params: Params) => {
      if ('clarify_batch' in params) {
        throw new JsonRpcGatewayError('invalid_params', {
          code: 4001,
          data: { fields: ['clarify_batch'], reason: 'invalid_params' }
        })
      }

      return {}
    }) as never)
    renderTile()

    await sessionTileDelegate()!.submitToSession(RUNTIME, 'first')
    await sessionTileDelegate()!.submitToSession(RUNTIME, 'second')

    expect(submits().map(params => ['clarify_batch' in params, params.text])).toEqual([
      [true, 'first'],
      [false, 'first'],
      [false, 'second']
    ])
  })
})
