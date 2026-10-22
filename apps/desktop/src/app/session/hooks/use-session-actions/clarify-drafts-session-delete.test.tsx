// Session deletion must take that conversation's recoverable clarify drafts
// with it (on the real removeSession lifecycle, only after the delete RPC
// lands), and nothing else: other sessions, and the same ids under another
// gateway or profile, stay.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteSession, type SessionInfo } from '@/hermes'
import { clarifyDraftKey, type ClarifyDraftScope, resetClarifyDraftsForTests } from '@/store/clarify-drafts'
import { setSessions } from '@/store/session'
import { $archivedSessions } from '@/store/sidebar-archive'

import type { ClientSessionState } from '../../../types'

import { useSessionActions } from './index'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getAllSessionMessages: vi.fn(),
  getLatestSessionMessages: vi.fn(),
  listAllProfileSessions: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setSessionArchived: vi.fn()
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

function archivedSession(id: string): SessionInfo {
  return {
    archived: true,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: 1,
    message_count: 2,
    model: null,
    output_tokens: 0,
    preview: null,
    source: 'desktop',
    started_at: 1,
    title: id,
    tool_call_count: 0
  } as SessionInfo
}

type Handle = Pick<ReturnType<typeof useSessionActions>, 'removeSession'>

function Harness({ onReady }: { onReady: (handle: Handle) => void }) {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })

  const actions = useSessionActions({
    activeSessionId: null,
    activeSessionIdRef: ref<string | null>(null),
    busyRef: ref(false),
    creatingSessionRef: ref(false),
    ensureSessionState: () => ({}) as ClientSessionState,
    getRouteToken: () => 'token',
    getRoutedStoredSessionId: () => null,
    navigate: vi.fn() as never,
    requestGateway: vi.fn().mockResolvedValue(undefined),
    resetViewSync: vi.fn(),
    routedSessionId: null,
    runtimeIdByStoredSessionIdRef: ref(new Map<string, string>()),
    selectedStoredSessionId: null,
    selectedStoredSessionIdRef: ref<string | null>(null),
    sessionStateByRuntimeIdRef: ref(new Map<string, ClientSessionState>()),
    syncSessionStateToView: vi.fn(),
    updateSessionState: () => ({}) as ClientSessionState
  })

  useEffect(() => {
    onReady({ removeSession: actions.removeSession })
  }, [actions, onReady])

  return null
}

async function mountHarness(): Promise<Handle> {
  let handle: Handle | undefined
  render(<Harness onReady={h => (handle = h)} />)
  await waitFor(() => expect(handle).toBeDefined())

  return handle as Handle
}

const AMBIENT: Pick<ClarifyDraftScope, 'gateway' | 'profile'> = { gateway: 'ambient:local', profile: 'default' }

function seed(scope: ClarifyDraftScope, requestId: string, storedSessionId: string) {
  window.localStorage.setItem(
    clarifyDraftKey(scope, requestId),
    JSON.stringify({
      ...scope,
      drafts: { q0: { choices: [], revision: 1, text: `draft of ${storedSessionId}` } },
      questions: [{ choices: null, multiSelect: false, qid: 'q0', question: 'Opening line?' }],
      requestId,
      savedAt: 1,
      server: 'saved',
      sessionId: 'runtime-x',
      storedSessionId,
      toolCallId: 'call-a',
      v: 2
    })
  )
}

const draftKeys = () =>
  Object.keys(window.localStorage)
    .filter(key => key.startsWith('hermes.clarifyDrafts'))
    .sort()

describe('removeSession × clarify drafts', () => {
  const doomed = { ...AMBIENT, session: 'stored:arch-1' }
  const kept = { ...AMBIENT, session: 'stored:arch-2' }
  // Same stored and request ids, another gateway and profile: an unrelated conversation.
  const elsewhere = { gateway: 'connection:gateway-b', profile: 'work', session: 'stored:arch-1' }

  beforeEach(() => {
    window.localStorage.clear()
    resetClarifyDraftsForTests()
    setSessions([])
    $archivedSessions.set([archivedSession('arch-1'), archivedSession('arch-2')])
    vi.mocked(deleteSession).mockReset()
    seed(doomed, 'srq-aaaaaaaaaaaa', 'arch-1')
    seed(doomed, 'srq-cccccccccccc', 'arch-1')
    seed(kept, 'srq-bbbbbbbbbbbb', 'arch-2')
    seed(elsewhere, 'srq-aaaaaaaaaaaa', 'arch-1')
  })

  afterEach(() => {
    cleanup()
    setSessions([])
    $archivedSessions.set([])
    resetClarifyDraftsForTests()
    window.localStorage.clear()
  })

  it("deleting a session clears exactly that session's device drafts", async () => {
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })
    const handle = await mountHarness()

    await act(() => handle.removeSession('arch-1'))

    expect(draftKeys()).toEqual(
      [clarifyDraftKey(kept, 'srq-bbbbbbbbbbbb'), clarifyDraftKey(elsewhere, 'srq-aaaaaaaaaaaa')].sort()
    )
  })

  it('a failed delete keeps every draft', async () => {
    vi.mocked(deleteSession).mockRejectedValue(new Error('backend down'))
    const handle = await mountHarness()
    const before = draftKeys()

    await act(() => handle.removeSession('arch-1'))

    expect(draftKeys()).toEqual(before)
  })
})
