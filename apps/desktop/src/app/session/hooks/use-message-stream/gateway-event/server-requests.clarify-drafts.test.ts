import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { $clarifyRequests, clearClarifyRequest } from '@/store/clarify'
import { resetServerRequestsForTests } from '@/store/server-requests'

import { handleServerRequest } from './server-requests'
import type { ServerRequestContext } from './server-requests'

// A reconnect replays an open batch with the drafts the server saved
// (`clarify.draft`) beside its locked answers. The card restores them; they
// are never treated as answers, and malformed entries are dropped.

const deps = {
  activeSessionIdRef: { current: null },
  sessionInterrupted: () => false,
  sessionStateByRuntimeIdRef: { current: new Map() },
  updateSessionState: (_sessionId, update) => update(createClientSessionState('stored-session')),
  upsertToolCall: () => undefined
} as ServerRequestContext['deps']

afterEach(() => {
  clearClarifyRequest()
  resetServerRequestsForTests()
})

describe('clarify replay with drafts', () => {
  it('parks the replayed drafts separately from the locked answers', () => {
    handleServerRequest(
      {
        decline: vi.fn(),
        fail: vi.fn(),
        id: 'srq-cccccccccccc',
        method: 'clarify',
        params: {
          answers: { q1: 'Panel' },
          drafts: {
            bad: { choices: 'not a list', revision: 1, text: 'x' },
            q0: { choices: ['Acme', 'Bolt'], revision: 12, text: 'line 1\nline 2' }
          },
          questions: [
            { choices: ['Acme', 'Bolt'], multi_select: true, qid: 'q0', question: 'Who?' },
            { choices: ['Panel', 'Fireside'], qid: 'q1', question: 'Format?' }
          ],
          session_id: 'runtime-1'
        },
        profile: 'default',
        replayed: true,
        respond: vi.fn()
      },
      deps,
      'runtime-1'
    )

    const parked = $clarifyRequests.get()['runtime-1']
    expect(parked?.lockedAnswers).toEqual({ q1: 'Panel' })
    expect(parked?.drafts).toEqual({ q0: { choices: ['Acme', 'Bolt'], revision: 12, text: 'line 1\nline 2' } })
  })

  it('captures the exact registry source the request arrived on as its draft owner', () => {
    handleServerRequest(
      {
        connectionId: 'gateway-a',
        decline: vi.fn(),
        fail: vi.fn(),
        id: 'srq-dddddddddddd',
        method: 'clarify',
        params: {
          questions: [{ choices: null, qid: 'q0', question: 'Opening line?' }],
          session_id: 'runtime-2'
        },
        profile: 'work',
        respond: vi.fn()
      },
      deps,
      'runtime-2'
    )

    expect($clarifyRequests.get()['runtime-2']?.owner).toEqual({ connectionId: 'gateway-a', profile: 'work' })
  })
})
