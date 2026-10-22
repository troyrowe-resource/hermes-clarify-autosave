import { JsonRpcGatewayClient, type ServerRequest } from '@hermes/shared'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { handleServerRequest } from '@/app/session/hooks/use-message-stream/gateway-event/server-requests'
import { restorePendingClarifyFromSnapshot } from '@/app/session/hooks/use-session-actions/restore-pending-clarify'
import { $clarifyRequests } from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { resetServerRequestsForTests } from '@/store/server-requests'
import type { SessionResumeResult } from '@/types/hermes'

import { CanonicalDesktopProtocol } from './canonical-protocol'
import { HermesGateway } from './client'

// The canonical owner answers `session.resume` / `session.events.since` with an `open_requests` entry for a
// batch `clarify` request still waiting on this viewer: the request as sent, the locks so far, and the unsent
// drafts. It is a server request, not a `prompts` entry (a prompt's Confirm would be a single-answer
// `clarify.respond`, which the owner answers `already_resolved` for a batch id).
const BATCH = {
  id: 'srq-1105b708fbd1',
  method: 'clarify',
  params: {
    session_id: 'waiting',
    questions: [
      { qid: 'q0', question: 'Pick a drink?', choices: ['Coffee (Recommended)', 'Tea'], multi_select: false },
      { qid: 'q1', question: 'Pick a time?', choices: ['Morning', 'Night'], multi_select: false },
      { qid: 'q2', question: 'Anything else?' }
    ],
    answers: { q1: 'Night' },
    drafts: { q2: { choices: [], text: 'half typed  ', revision: 3 } }
  }
}

beforeEach(() => {
  $clarifyRequests.set({})
  resetServerRequestsForTests()
})

afterEach(() => vi.restoreAllMocks())

test('a snapshot keeps the owner open batch request beside the prompt-derived ones, oldest first', () => {
  const snapshot = new CanonicalDesktopProtocol().result(
    'session.resume',
    { session_id: 'waiting' },
    {
      session_id: 'waiting',
      revision: 1,
      execution_generation: 3,
      running: true,
      open_requests: [BATCH],
      prompts: [{ kind: 'approval', prompt_id: 'approval-1', execution_generation: 3, command: 'ls', choices: ['once'] }]
    }
  )

  expect(snapshot.open_requests.map((entry: { id: string }) => entry.id)).toEqual([BATCH.id, 'approval-1'])
  expect(snapshot.open_requests[0]).toEqual(BATCH)
})

test('a snapshot without any open request still reports an empty list (an older owner sends none)', () => {
  const snapshot = new CanonicalDesktopProtocol().result(
    'session.resume',
    { session_id: 'waiting' },
    { session_id: 'waiting', revision: 1, execution_generation: 3, running: false, prompts: [] }
  )

  expect(snapshot.open_requests).toEqual([])
})

test('after a reconnect the replayed batch card is restored with its locks and drafts, and Confirm still locks per question', async () => {
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()

  const wire = vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async name => {
    if (name === 'session.resume') {
      return { session_id: 'waiting', stored_session_id: 'waiting', revision: 1, execution_generation: 3, running: true,
        messages: [], open_requests: [BATCH], prompts: [] } as never
    }

    return { status: 'ok', remaining: [] } as never
  })

  const client = new HermesGateway()
  const previousGateway = $gateway.get()
  $gateway.set(client)

  const shown = vi.fn((request: ServerRequest) => handleServerRequest({ ...request, profile: 'default' }, {
    activeSessionIdRef: { current: 'waiting' },
    sessionInterrupted: () => false,
    sessionStateByRuntimeIdRef: { current: new Map() },
    updateSessionState: vi.fn(),
    upsertToolCall: vi.fn()
  }, 'waiting'))

  client.onRequest(shown)

  try {
    await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture')
    const startedAt = Date.now() / 1000

    // The shared channel re-delivers `open_requests` from the RAW answer before the caller sees it
    // (apps/shared JsonRpcRequestChannel.handleFrame); this stands in for that frame.
    const channel = (client as unknown as { channel: { deliverRequest: typeof deliver } }).channel
    const deliver = (params: Record<string, unknown>) => channel.deliverRequest(BATCH.id, BATCH.method, params, true)
    deliver(BATCH.params)
    const snapshot = await client.request<SessionResumeResult>('session.resume', { session_id: 'waiting' })

    const parked = $clarifyRequests.get().waiting
    expect(parked?.requestId).toBe(BATCH.id)
    expect(parked?.questions.map(question => question.qid)).toEqual(['q0', 'q1', 'q2'])
    expect(parked?.lockedAnswers).toEqual({ q1: 'Night' })
    expect(parked?.drafts).toEqual({ q2: { choices: [], revision: 3, text: 'half typed  ' } })

    // The reconciliation after the resume sees the question: it does not read the snapshot as "none open".
    const restored = restorePendingClarifyFromSnapshot(snapshot, 'waiting', startedAt)
    expect(restored.authoritativeAbsent).toBe(false)
    expect(restored.request?.requestId).toBe(BATCH.id)
    expect($clarifyRequests.get().waiting?.requestId).toBe(BATCH.id)

    // A second resume returns the same entry: the same card, the same locks, not a second delivery of state.
    deliver({ ...BATCH.params, answers: { q1: 'Night', q0: 'Tea' } })
    expect(Object.keys($clarifyRequests.get())).toEqual(['waiting'])
    expect($clarifyRequests.get().waiting?.lockedAnswers).toEqual({ q0: 'Tea', q1: 'Night' })

    // Confirm is a per-question clarify.lock on the batch id, never a canonical single-answer clarify.respond.
    await client.request('clarify.lock', { request_id: BATCH.id, question_id: 'q0', answer: 'Tea' })
    const names = wire.mock.calls.map(([name]) => name)
    expect(names).toContain('clarify.lock')
    expect(names).not.toContain('clarify.respond')
  } finally {
    $gateway.set(previousGateway)
    client.close()
  }
})
