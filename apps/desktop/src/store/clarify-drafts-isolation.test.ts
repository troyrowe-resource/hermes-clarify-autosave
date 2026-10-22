import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClarifyQuestion, ClarifyRequest } from '@/store/clarify'
import {
  CLARIFY_DRAFT_SAVE_DELAY_MS,
  clarifyDraftKey,
  type ClarifyDraftScope,
  discardClarifyDrafts,
  findClarifyDraftsForCard,
  forgetClarifyDrafts,
  markClarifyDraftsLocked,
  readClarifyDrafts,
  recallServerClarifyDrafts,
  recordClarifyDraft,
  resetClarifyDraftsForTests,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { $approvalRequests, clearApprovalRequest, setApprovalRequest } from '@/store/prompts'
import { hasOpenServerRequest, rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $sessionTiles, clearAllSessionStates } from '@/store/session-states'

// A draft belongs to ONE (gateway, profile, session, request) identity. Nothing a user typed for one
// identity may be read back, sent, closed, locked or overwritten through another, and a draft is
// never an answer to anything else the server is waiting on (an approval).

const QUESTION: ClarifyQuestion = { choices: null, multiSelect: false, qid: 'q1', question: 'Opening line?' }

const requestFor = (requestId: string, sessionId: string): ClarifyRequest => ({
  questions: [QUESTION],
  requestId,
  sessionId
})

const stage = (draft: string) => ({ choices: [], draft })

// Parts built from the same few segments, with the separators, escapes and NULs a naive `a/b/c/d` key lets
// one identity masquerade as another by moving a boundary: ('a/b', 'c', ...) vs ('a', 'b/c', ...).
const PARTS = ['a', 'b', 'a/b', 'b/a', 'a%2Fb', 'a\u0000b']

interface Identity {
  requestId: string
  scope: ClarifyDraftScope
  text: string
}

const IDENTITIES: Identity[] = PARTS.flatMap(gateway =>
  PARTS.flatMap(profile =>
    PARTS.flatMap(session =>
      PARTS.map(requestId => ({
        requestId,
        scope: { gateway, profile, session },
        text: `draft for ${JSON.stringify([gateway, profile, session, requestId])}`
      }))
    )
  )
)

const keyOf = (identity: Identity) => clarifyDraftKey(identity.scope, identity.requestId)
const draftKeys = () => Object.keys(window.localStorage).filter(key => key.startsWith('hermes.clarifyDrafts'))

/** Every identity reads back exactly the row it wrote (its own text and identity), and never another one's. */
function expectEachReadsOnlyItsOwn() {
  for (const identity of IDENTITIES) {
    const found = readClarifyDrafts(identity.scope, identity.requestId)

    expect(
      found && {
        gateway: found.gateway,
        profile: found.profile,
        requestId: found.requestId,
        session: found.session,
        text: found.drafts.q1?.text
      },
      keyOf(identity)
    ).toEqual({ ...identity.scope, requestId: identity.requestId, text: identity.text })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
})

afterEach(() => {
  vi.useRealTimers()
  clearApprovalRequest()
  clearAllSessionStates()
  resetClarifyDraftsForTests()
  resetServerRequestsForTests()
  $sessionTiles.set([])
  $gateway.set(null)
  window.localStorage.clear()
})

describe('clarify draft identity: scope keys never cross', () => {
  it('every gateway, profile, session and request combination has its own storage key', () => {
    const keys = IDENTITIES.map(keyOf)

    expect(IDENTITIES.length).toBe(PARTS.length ** 4)
    expect(new Set(keys).size).toBe(IDENTITIES.length)
  })

  it('every identity reads back only its own draft, from memory and after a reload', () => {
    for (const identity of IDENTITIES) {
      recordClarifyDraft(identity.scope, requestFor(identity.requestId, 'runtime-1'), QUESTION, stage(identity.text))
    }

    expect(draftKeys()).toHaveLength(IDENTITIES.length)
    expectEachReadsOnlyItsOwn()

    // A reload: this renderer's memory is gone, only device storage remains.
    resetClarifyDraftsForTests()
    expectEachReadsOnlyItsOwn()
  })

  it('a stored row planted under another identity key is never returned: each read re-checks the row itself', () => {
    const owner: Identity = IDENTITIES[0]
    recordClarifyDraft(owner.scope, requestFor(owner.requestId, 'runtime-1'), QUESTION, stage(owner.text))

    const row = window.localStorage.getItem(keyOf(owner)) as string
    expect(JSON.parse(row).drafts.q1.text).toBe(owner.text)
    resetClarifyDraftsForTests()

    const wrong: Identity[] = [
      { ...owner, scope: { ...owner.scope, gateway: 'connection:other' } },
      { ...owner, scope: { ...owner.scope, profile: 'other' } },
      { ...owner, scope: { ...owner.scope, session: 'stored:other' } },
      { ...owner, requestId: 'srq-other' }
    ]

    for (const identity of wrong) {
      window.localStorage.setItem(keyOf(identity), row)
      expect(readClarifyDrafts(identity.scope, identity.requestId), keyOf(identity)).toBeNull()
    }

    // Control: the genuine identity still reads its own copy.
    expect(readClarifyDrafts(owner.scope, owner.requestId)?.drafts.q1?.text).toBe(owner.text)
  })

  it('a tool-call id shared by two scopes finds each scope its own card draft and every other scope nothing', () => {
    const scopes: ClarifyDraftScope[] = [
      { gateway: 'connection:a', profile: 'default', session: 'stored:s1' },
      { gateway: 'connection:a', profile: 'work', session: 'stored:s1' },
      { gateway: 'connection:b', profile: 'default', session: 'stored:s1' },
      { gateway: 'connection:a', profile: 'default', session: 'stored:s2' }
    ]

    scopes.forEach((scope, index) => {
      // Providers that name every call `call_0` make the tool-call id repeat across conversations.
      recordClarifyDraft(scope, requestFor(`srq-${index}`, 'runtime-1'), QUESTION, stage(`text ${index}`), {
        toolCallId: 'call_0'
      })
    })

    for (const reload of [false, true]) {
      if (reload) {
        resetClarifyDraftsForTests()
      }

      scopes.forEach((scope, index) => {
        const found = findClarifyDraftsForCard({ scope, toolCallId: 'call_0' })

        expect(found?.requestId).toBe(`srq-${index}`)
        expect(found?.drafts.q1?.text).toBe(`text ${index}`)
      })

      expect(
        findClarifyDraftsForCard({
          scope: { gateway: 'connection:c', profile: 'default', session: 'stored:s1' },
          toolCallId: 'call_0'
        })
      ).toBeNull()
    }
  })

  it('an unproven or contradictory identity resolves to no scope, so nothing is stored, read or sent', () => {
    // No runtime session at all.
    expect(resolveClarifyDraftScope({ sessionId: null, storedSessionId: 'stored-1' })).toBeNull()

    // The request arrived for a profile the session is not attributed to.
    expect(
      resolveClarifyDraftScope({
        owner: { connectionId: null, profile: 'work' },
        sessionId: 'runtime-1',
        storedSessionId: 'stored-1'
      })
    ).toBeNull()

    // The renderer's two ideas of the durable session disagree.
    $sessionTiles.set([{ runtimeId: 'runtime-1', storedSessionId: 'stored-A' }])
    expect(resolveClarifyDraftScope({ sessionId: 'runtime-1', storedSessionId: 'stored-B' })).toBeNull()
    expect(resolveClarifyDraftScope({ sessionId: 'runtime-1', storedSessionId: 'stored-A' })).toMatchObject({
      session: 'stored:stored-A'
    })

    // Controls: a proven identity does resolve, and the runtime id alone is a valid (weaker) session part.
    $sessionTiles.set([])
    expect(
      resolveClarifyDraftScope({
        owner: { connectionId: null, profile: 'default' },
        sessionId: 'runtime-1',
        storedSessionId: null
      })
    ).toMatchObject({ profile: 'default', session: 'runtime:runtime-1' })

    // And with no scope the store keeps nothing and the recall refuses to ask any server.
    const request = vi.fn(async () => ({ drafts: [] }))
    $gateway.set({ request } as never)
    recordClarifyDraft(null, requestFor('srq-aaaaaaaaaaaa', 'runtime-1'), QUESTION, stage('nowhere'))
    expect(draftKeys()).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})

describe('clarify draft identity on the wire and in the lifecycle', () => {
  /** Two live conversations whose requests happen to share an id, as ids minted by two backends can. */
  function twoSessions() {
    const sent: Record<string, unknown>[] = []

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, ...params })

      return method === 'clarify.draft' ? { durable: true, revision: params.revision, status: 'ok' } : { status: 'ok' }
    })

    $gateway.set({ request } as never)

    const one = resolveClarifyDraftScope({ sessionId: 'runtime-1', storedSessionId: 'stored-1' }) as ClarifyDraftScope
    const two = resolveClarifyDraftScope({ sessionId: 'runtime-2', storedSessionId: 'stored-2' }) as ClarifyDraftScope

    return { one, request, sent, two }
  }

  const flush = () => vi.advanceTimersByTimeAsync(CLARIFY_DRAFT_SAVE_DELAY_MS + 1)

  it('each draft goes to the server under its own session and request, never another one', async () => {
    const { one, sent, two } = twoSessions()

    recordClarifyDraft(one, requestFor('srq-shared', 'runtime-1'), QUESTION, stage('for session one'), {
      storedSessionId: 'stored-1'
    })
    recordClarifyDraft(two, requestFor('srq-shared', 'runtime-2'), QUESTION, stage('for session two'), {
      storedSessionId: 'stored-2'
    })
    await flush()

    expect(sent.map(({ method, request_id, session_id, text }) => [method, session_id, request_id, text])).toEqual([
      ['clarify.draft', 'runtime-1', 'srq-shared', 'for session one'],
      ['clarify.draft', 'runtime-2', 'srq-shared', 'for session two']
    ])
    expect(readClarifyDrafts(one, 'srq-shared')?.drafts.q1?.text).toBe('for session one')
    expect(readClarifyDrafts(two, 'srq-shared')?.drafts.q1?.text).toBe('for session two')
  })

  it('submitting or discarding one conversation request never closes, locks or removes the same id elsewhere', async () => {
    const { one, sent, two } = twoSessions()

    recordClarifyDraft(one, requestFor('srq-shared', 'runtime-1'), QUESTION, stage('one, first'), {
      storedSessionId: 'stored-1'
    })
    recordClarifyDraft(two, requestFor('srq-shared', 'runtime-2'), QUESTION, stage('two, first'), {
      storedSessionId: 'stored-2'
    })

    // Session one answers (or is locked): its pending autosave is dropped and its copy forgotten.
    forgetClarifyDrafts(one, 'srq-shared')
    markClarifyDraftsLocked(one, 'srq-shared', ['q1'])
    await flush()

    expect(sent.map(({ method, session_id }) => [method, session_id])).toEqual([['clarify.draft', 'runtime-2']])
    expect(readClarifyDrafts(one, 'srq-shared')).toBeNull()
    expect(readClarifyDrafts(two, 'srq-shared')?.drafts.q1?.text).toBe('two, first')

    // Session two is neither closed nor locked: it keeps saving, locally and on the server.
    recordClarifyDraft(two, requestFor('srq-shared', 'runtime-2'), QUESTION, stage('two, second'), {
      storedSessionId: 'stored-2'
    })
    await flush()
    expect(readClarifyDrafts(two, 'srq-shared')?.drafts.q1?.text).toBe('two, second')
    expect(sent.filter(row => row.method === 'clarify.draft').map(row => row.text)).toEqual(['two, first', 'two, second'])

    // And session one's explicit discard names session one only.
    await discardClarifyDrafts(one, 'srq-shared', 'runtime-1')
    expect(sent.at(-1)).toMatchObject({ method: 'clarify.drafts.discard', request_id: 'srq-shared', session_id: 'runtime-1' })
    expect(readClarifyDrafts(two, 'srq-shared')?.drafts.q1?.text).toBe('two, second')
  })

  it('a recall asks for exactly its own session and request and shows nothing the server sent for another', async () => {
    const { one, request } = twoSessions()

    // The server answers with a different request's record whatever was asked.
    request.mockImplementation(async (method: string) => ({
      drafts:
        method === 'clarify.drafts'
          ? [
              {
                drafts: { q1: { choices: [], revision: 9, text: 'belongs to another request' } },
                questions: [{ choices: null, qid: 'q1', question: 'Opening line?' }],
                request_id: 'srq-other',
                updated_at: 1
              }
            ]
          : []
    }))

    const recall = await recallServerClarifyDrafts(one, 'runtime-1', 'srq-shared')

    expect(request).toHaveBeenCalledWith('clarify.drafts', { request_id: 'srq-shared', session_id: 'runtime-1' })
    // Exact or nothing: a different request's record is never attached to this one.
    expect(recall).toEqual({ records: [], status: 'ok' })
  })
})

describe('clarify drafts never touch an approval request', () => {
  it('saving, recalling, discarding, locking and forgetting drafts leave a pending approval and its server request alone', async () => {
    const methods: string[] = []

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      methods.push(method)

      if (method === 'clarify.draft') {
        return { durable: true, revision: params.revision, status: 'ok' }
      }

      return method === 'clarify.drafts' ? { drafts: [] } : { status: 'ok' }
    })

    $gateway.set({ request } as never)

    // An approval waits in the very same session, behind its own server request.
    const approvalRespond = vi.fn()
    const approvalFail = vi.fn()

    setApprovalRequest({
      choices: ['once', 'session', 'deny'],
      command: 'rm -rf build',
      description: 'Delete the build directory',
      requestId: 'approval-queue-1',
      serverRequestId: 'srq-approval-1',
      sessionId: 'runtime-1'
    })
    rememberServerRequest({ fail: approvalFail, id: 'srq-approval-1', method: 'approval', params: {}, respond: approvalRespond })
    const pending = JSON.stringify($approvalRequests.get())

    const scope = resolveClarifyDraftScope({ sessionId: 'runtime-1', storedSessionId: 'stored-1' }) as ClarifyDraftScope
    const clarify = requestFor('srq-clarify-1', 'runtime-1')

    recordClarifyDraft(scope, clarify, QUESTION, stage('draft one'), { storedSessionId: 'stored-1' })
    await vi.advanceTimersByTimeAsync(CLARIFY_DRAFT_SAVE_DELAY_MS + 1)
    recordClarifyDraft(scope, clarify, QUESTION, stage('draft one, edited'), { storedSessionId: 'stored-1' })
    await recallServerClarifyDrafts(scope, 'runtime-1', 'srq-clarify-1')
    markClarifyDraftsLocked(scope, 'srq-clarify-1', ['q1'])
    await discardClarifyDrafts(scope, 'srq-clarify-1', 'runtime-1')
    forgetClarifyDrafts(scope, 'srq-clarify-1')
    await vi.advanceTimersByTimeAsync(CLARIFY_DRAFT_SAVE_DELAY_MS + 1)

    expect(methods).toEqual(expect.arrayContaining(['clarify.draft', 'clarify.drafts', 'clarify.drafts.discard']))
    expect(methods.filter(method => !method.startsWith('clarify.draft'))).toEqual([])
    expect(JSON.stringify($approvalRequests.get())).toBe(pending)
    expect(hasOpenServerRequest('srq-approval-1')).toBe(true)
    expect(approvalRespond).not.toHaveBeenCalled()
    expect(approvalFail).not.toHaveBeenCalled()
  })
})
