import { atom } from 'nanostores'

import { isMissingRpcMethod } from '@/lib/gateway-rpc'

import { bareChoice, type ClarifyQuestion, type ClarifyRequest } from './clarify'
import { $gateway, activeGatewayConnectionId, activeGatewayProfileKey } from './gateway'
import { normalizeProfileKey } from './profile'
import { ambientGatewayOwnsEverySession } from './session-owner-resolution'
import { isSessionOwnerRoute, type SessionOwnerScope } from './session-request-router'
import { knownOwnerForSession, requestForOwnedSession, storedSessionIdForRuntimeId } from './session-states'

/**
 * Unsent clarify drafts: what the user picked or typed on a live batch card,
 * saved WITHOUT answering it.
 *
 * Two copies, each with its own authority:
 * - this device (renderer memory at once, mirrored to localStorage on every
 *   edit) holds the newest keystrokes, so a network loss, an old backend or a
 *   timeout inside the debounce window loses nothing on this machine;
 * - the backend (`clarify.draft`, debounced) holds what the assistant is told
 *   when the wait ends without a submit, and survives a backend restart
 *   (`clarify.drafts` reads it back, `clarify.drafts.discard` drops it).
 *
 * Identity is the COMPLETE scope: owning gateway + profile + session + exact
 * request id (+ question id inside it). Every storage key, memory map, timer,
 * status entry, read and discard is keyed by it, and every read re-checks each
 * field of the stored record. The owner comes from the app's own ownership
 * ladder (`knownOwnerForSession`), cross-checked with the source the request
 * actually arrived on; any disagreement or gap resolves to NO scope, and with
 * no scope nothing is stored, read or sent. Question text and choices are never
 * identity: identical batches recur.
 *
 * A draft is never `clarify.lock`: it cannot complete the batch, and Confirm
 * (the locks) supersedes it. Revisions are per question and strictly
 * increasing (a millisecond floor), so a slow earlier save can never
 * overwrite a later edit on the server (it answers `stale`).
 */

export interface ClarifyDraftStage {
  /** Bare choice labels (no "(Recommended)" suffix): the exact selection. */
  choices: string[]
  text: string
}

export interface ClarifyDraftEntry extends ClarifyDraftStage {
  revision: number
}

/** The registry source a clarify request arrived on (`ScopedServerRequest`), captured at creation. */
export interface ClarifyDraftOwner {
  connectionId: null | string
  profile: string
}

/** The complete identity a device copy is stored under. All fields are exact, never inferred from content. */
export interface ClarifyDraftScope {
  /** `connection:<id>`, `profile-pool` (a bare-profile owner) or `ambient:<id|local>` (sole legacy backend). */
  gateway: string
  profile: string
  /** `stored:<id>` when the durable session id is known, else `runtime:<id>`. */
  session: string
}

/** Last known server state of one request's drafts, for the card's status line. */
export type ClarifyDraftServerState = 'device-only' | 'saved' | 'unavailable'

export interface StoredClarifyDrafts {
  v: 2
  gateway: string
  profile: string
  session: string
  requestId: string
  /** Runtime session id that raised the request. */
  sessionId: null | string
  /** Durable session id when the renderer knew it. */
  storedSessionId: null | string
  /** The transcript tool call that rendered this request's card (exact association after a reload). */
  toolCallId: null | string
  questions: ClarifyQuestion[]
  drafts: Record<string, ClarifyDraftEntry>
  savedAt: number
  server: ClarifyDraftServerState
  /** Per question, the newest revision the server acknowledged holding. */
  acked?: Record<string, number>
  /** Per question, the revision the server confirmed ON DISK (`durable: true`); absent = never confirmed. */
  durable?: Record<string, number>
}

const KEY_PREFIX = 'hermes.clarifyDrafts.v2/'
export const CLARIFY_DRAFT_SAVE_DELAY_MS = 600

/** Server state per storage key (scope + request). */
export const $clarifyDraftServerState = atom<Record<string, ClarifyDraftServerState>>({})

/**
 * What the live card may truthfully say about the NEWEST edit, per storage key:
 * - `device-only` / `saved` / `unavailable`: this device holds it (and the server does / may not / cannot);
 * - `server-only`: this device could not store it, but the server acknowledged this exact revision;
 * - `not-saved`: neither copy is known to hold it (only the open form does).
 */
export type ClarifyDraftStatus =
  'device-only' | 'not-saved' | 'saved' | 'server-only' | 'server-unconfirmed' | 'unavailable'

export const $clarifyDraftStatus = atom<Record<string, ClarifyDraftStatus>>({})

/** This renderer's copies: the authority while the app runs (localStorage mirrors it). */
const memory = new Map<string, StoredClarifyDrafts>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Storage keys finished for good (submitted, or the session deleted): nothing is stored or sent again. */
const closedRequests = new Set<string>()
/** Storage keys the SERVER closed (request ended, or its copy discarded): this device keeps saving, nothing is sent. */
const serverClosed = new Set<string>()
/** Owner gateways (`gateway\0profile`) that answered -32601: an older backend without `clarify.draft`. */
const unsupportedOwners = new Set<string>()
/** Per storage key, questions whose answer the server LOCKED: their drafts are superseded for good. */
const lockedQuestions = new Map<string, Set<string>>()
/** Storage keys whose newest edit this device's storage refused (quota, disabled storage). */
const deviceFailed = new Set<string>()

const enc = (part: string) => encodeURIComponent(part)

/** The storage key of one request's device copy under its complete scope. */
export const clarifyDraftKey = (scope: ClarifyDraftScope, requestId: string): string =>
  `${KEY_PREFIX}${[scope.gateway, scope.profile, scope.session, requestId].map(enc).join('/')}`

const ownerKey = (scope: ClarifyDraftScope) => `${scope.gateway}\u0000${scope.profile}`

const sameScope = (a: ClarifyDraftScope | null, b: ClarifyDraftScope | null): boolean =>
  Boolean(a && b && a.gateway === b.gateway && a.profile === b.profile && a.session === b.session)

/**
 * The owning gateway + profile of a session, from the app's own ownership
 * ladder, or null. `captured` (the source the live request arrived on) must
 * agree with it: a request that arrived on one gateway for a session the app
 * attributes to another is ambiguous, and stays unscoped.
 */
function ownerScope(
  sessionId: null | string,
  captured?: ClarifyDraftOwner
): null | Pick<ClarifyDraftScope, 'gateway' | 'profile'> {
  if (!sessionId) {
    return null
  }

  const owner = knownOwnerForSession(sessionId)
  let gateway: string
  let profiles: string[]

  if (isSessionOwnerRoute(owner)) {
    const connectionId = owner.connectionId.trim()

    if (!connectionId || !owner.profile?.trim()) {
      return null
    }

    gateway = `connection:${connectionId}`
    profiles = [owner.profile, owner.targetProfile ?? owner.profile].map(normalizeProfileKey)

    if (captured?.connectionId && captured.connectionId !== connectionId) {
      return null
    }
  } else if (typeof owner === 'string' && owner.trim()) {
    gateway = 'profile-pool'
    profiles = [normalizeProfileKey(owner)]
  } else if (ambientGatewayOwnsEverySession()) {
    gateway = `ambient:${activeGatewayConnectionId() ?? 'local'}`
    profiles = [normalizeProfileKey(activeGatewayProfileKey())]
  } else {
    return null
  }

  if (captured && !profiles.includes(normalizeProfileKey(captured.profile))) {
    return null
  }

  return { gateway, profile: profiles[0] }
}

/** The durable/runtime session part of a scope, or null when the two disagree. */
function sessionPart(runtimeId: null | string, storedId: null | string): null | string {
  const mapped = runtimeId ? storedSessionIdForRuntimeId(runtimeId) : null

  if (storedId && mapped && storedId !== mapped) {
    return null
  }

  const stored = storedId || mapped

  return stored ? `stored:${stored}` : runtimeId ? `runtime:${runtimeId}` : null
}

/**
 * The complete scope for a session's drafts (`sessionId` is the runtime id),
 * or null when any part is unknown or contradictory: callers then store, read
 * and send nothing.
 */
export function resolveClarifyDraftScope(options: {
  owner?: ClarifyDraftOwner
  sessionId: null | string
  storedSessionId: null | string
}): ClarifyDraftScope | null {
  const owner = ownerScope(options.sessionId, options.owner)
  const session = sessionPart(options.sessionId, options.storedSessionId)

  return owner && session ? { ...owner, session } : null
}

function isEntry(value: unknown): value is StoredClarifyDrafts {
  const row = value as null | StoredClarifyDrafts

  return Boolean(
    row &&
    row.v === 2 &&
    typeof row.requestId === 'string' &&
    typeof row.gateway === 'string' &&
    typeof row.profile === 'string' &&
    typeof row.session === 'string' &&
    Array.isArray(row.questions) &&
    row.drafts &&
    typeof row.drafts === 'object'
  )
}

const belongs = (entry: StoredClarifyDrafts, scope: ClarifyDraftScope, requestId: string): boolean =>
  entry.requestId === requestId &&
  entry.gateway === scope.gateway &&
  entry.profile === scope.profile &&
  entry.session === scope.session

function readStored(key: string): null | StoredClarifyDrafts {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) || 'null')

    return isEntry(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readEntry(scope: ClarifyDraftScope, requestId: string): null | StoredClarifyDrafts {
  const key = clarifyDraftKey(scope, requestId)
  const entry = memory.get(key) ?? readStored(key)

  return entry && belongs(entry, scope, requestId) ? entry : null
}

function removeEntry(key: string): void {
  memory.delete(key)
  deviceFailed.delete(key)
  refreshStatus(key)

  try {
    window.localStorage.removeItem(key)
  } catch {
    // Best effort.
  }
}

/** Every device copy this renderer can see (memory first, then storage). */
function allEntries(): { entry: StoredClarifyDrafts; key: string }[] {
  const seen = new Map<string, StoredClarifyDrafts>(memory)

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)

      if (key?.startsWith(KEY_PREFIX) && !seen.has(key)) {
        const entry = readStored(key)

        if (entry) {
          seen.set(key, entry)
        }
      }
    }
  } catch {
    // Storage unreadable: memory is what there is.
  }

  return [...seen].map(([key, entry]) => ({ entry, key }))
}

function refreshStatus(key: string): void {
  const entry = memory.get(key)
  const current = $clarifyDraftStatus.get()

  if (!entry) {
    if (key in current) {
      const next = { ...current }
      delete next[key]
      $clarifyDraftStatus.set(next)
    }

    return
  }

  const server = $clarifyDraftServerState.get()[key] ?? entry.server
  const qids = Object.keys(entry.drafts)
  // `saved` means ON THE SERVER'S DISK for exactly this device's newest revision of every question.
  const onDisk = qids.length > 0 && qids.every(qid => serverDurablyHoldsDraft(entry, qid))
  const held = qids.length > 0 && qids.every(qid => serverHoldsDraft(entry, qid))

  const status: ClarifyDraftStatus = deviceFailed.has(key)
    ? onDisk
      ? 'server-only'
      : 'not-saved'
    : server === 'unavailable'
      ? 'unavailable'
      : onDisk
        ? 'saved'
        : held
          ? 'server-unconfirmed'
          : 'device-only'

  if (current[key] !== status) {
    $clarifyDraftStatus.set({ ...current, [key]: status })
  }
}

function writeEntry(entry: StoredClarifyDrafts): void {
  const key = clarifyDraftKey(entry, entry.requestId)
  // Memory first: a storage failure must never lose what this renderer holds.
  memory.set(key, entry)

  try {
    window.localStorage.setItem(key, JSON.stringify(entry))
    deviceFailed.delete(key)
  } catch {
    // Quota / disabled storage. The older stored copy (if any) is left as it is, never deleted,
    // and the status line stops claiming this device holds the newest edit.
    deviceFailed.add(key)
  }

  refreshStatus(key)
}

function setServerState(scope: ClarifyDraftScope, requestId: string, state: ClarifyDraftServerState): void {
  const key = clarifyDraftKey(scope, requestId)
  const current = $clarifyDraftServerState.get()

  if (current[key] !== state) {
    $clarifyDraftServerState.set({ ...current, [key]: state })
  }

  const entry = closedRequests.has(key) ? null : readEntry(scope, requestId)

  if (entry && entry.server !== state) {
    writeEntry({ ...entry, server: state })
  } else {
    refreshStatus(key)
  }
}

/**
 * Record what the server said it holds for one question: `held` is the revision it holds
 * (ours for `ok`, its own for `stale`), `durable` whether THAT revision is on its disk.
 * Only `durable === true` is proof; false and absent never are.
 */
function noteAcknowledged(
  scope: ClarifyDraftScope,
  requestId: string,
  qid: string,
  held: number,
  durable: boolean
): void {
  const entry = closedRequests.has(clarifyDraftKey(scope, requestId)) ? null : readEntry(scope, requestId)

  if (!entry) {
    return
  }

  const acked = held >= (entry.acked?.[qid] ?? 0) ? { ...entry.acked, [qid]: held } : entry.acked

  // Replies to overlapping saves can arrive out of order: a late disk confirmation for an OLDER revision must not
  // take back the newer one already confirmed.
  const onDisk = durable && held >= (entry.durable?.[qid] ?? 0) ? { ...entry.durable, [qid]: held } : entry.durable

  writeEntry({ ...entry, acked, durable: onDisk })
}

/** Whether the server holds EXACTLY this device's newest revision of the question (in memory at least). */
export const serverHoldsDraft = (entry: StoredClarifyDrafts, qid: string): boolean =>
  entry.drafts[qid] !== undefined && entry.acked?.[qid] === entry.drafts[qid].revision

/** Whether the server confirmed EXACTLY this device's newest revision of the question on its disk. */
export const serverDurablyHoldsDraft = (entry: StoredClarifyDrafts, qid: string): boolean =>
  entry.drafts[qid] !== undefined && entry.durable?.[qid] === entry.drafts[qid].revision

/** Whether this device's storage holds the renderer's newest copy (false after a quota / storage failure). */
export const clarifyDraftDeviceStored = (scope: ClarifyDraftScope | null, requestId: string): boolean =>
  Boolean(scope) && !deviceFailed.has(clarifyDraftKey(scope as ClarifyDraftScope, requestId))

export const isBlankDraft = (draft: ClarifyDraftStage | undefined): boolean =>
  !draft || (draft.choices.length === 0 && !draft.text.trim())

/** The device copy of one request's drafts under its exact scope, or null. */
export const readClarifyDrafts = (scope: ClarifyDraftScope | null, requestId: string): null | StoredClarifyDrafts =>
  scope ? readEntry(scope, requestId) : null

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

interface DraftTarget {
  owner?: ClarifyDraftOwner
  request: ClarifyRequest
  scope: ClarifyDraftScope
  storedSessionId: null | string
}

/**
 * Save one question's staged state: on this device now, on the server after a
 * short pause. `stage.choices` are the card's labels; they are stored bare.
 * Nothing is stored without a complete scope.
 */
export function recordClarifyDraft(
  scope: ClarifyDraftScope | null,
  request: ClarifyRequest,
  question: ClarifyQuestion,
  stage: { choices: string[]; draft: string },
  options: { storedSessionId?: null | string; toolCallId?: null | string } = {}
): void {
  const key = scope ? clarifyDraftKey(scope, request.requestId) : ''

  if (!scope || closedRequests.has(key) || lockedQuestions.get(key)?.has(question.qid)) {
    return
  }

  const previous = readEntry(scope, request.requestId)
  const prior = previous?.drafts[question.qid]
  const choices = stage.choices.map(bareChoice)

  if (
    prior
      ? prior.text === stage.draft && sameList(prior.choices, choices)
      : isBlankDraft({ choices, text: stage.draft })
  ) {
    return
  }

  const revision = Math.max(Date.now(), (prior?.revision ?? 0) + 1)

  writeEntry({
    acked: previous?.acked,
    durable: previous?.durable,
    drafts: { ...previous?.drafts, [question.qid]: { choices, revision, text: stage.draft } },
    gateway: scope.gateway,
    profile: scope.profile,
    questions: request.questions,
    requestId: request.requestId,
    savedAt: Date.now(),
    server: previous?.server ?? 'device-only',
    session: scope.session,
    sessionId: request.sessionId,
    storedSessionId: options.storedSessionId ?? previous?.storedSessionId ?? null,
    toolCallId: previous?.toolCallId ?? options.toolCallId ?? null,
    v: 2
  })

  scheduleServerSave(
    { owner: request.owner, request, scope, storedSessionId: options.storedSessionId ?? null },
    question.qid
  )
}

/** Push a restored device copy that the server has not acknowledged (a reconnect after lost keystrokes). */
export const resendClarifyDraft = (
  scope: ClarifyDraftScope | null,
  request: ClarifyRequest,
  qid: string,
  storedSessionId: null | string = null
): void => {
  if (scope) {
    scheduleServerSave({ owner: request.owner, request, scope, storedSessionId }, qid)
  }
}

function scheduleServerSave(target: DraftTarget, qid: string): void {
  const key = `${clarifyDraftKey(target.scope, target.request.requestId)}\u0000${qid}`
  const pending = timers.get(key)

  if (pending) {
    clearTimeout(pending)
  }

  // The owner gateway is fixed NOW: a session / gateway switch during the pause must not
  // carry this draft to whichever server is ambient when the timer fires.
  const gateway = $gateway.get()

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void sendDraft(target, qid, gateway)
    }, CLARIFY_DRAFT_SAVE_DELAY_MS)
  )
}

interface DraftReply {
  durable?: boolean | null
  revision?: null | number
  status?: string
}

async function sendDraft(target: DraftTarget, qid: string, gateway: ReturnType<typeof $gateway.get>): Promise<void> {
  const { request, scope } = target
  const key = clarifyDraftKey(scope, request.requestId)
  const draft = readEntry(scope, request.requestId)?.drafts[qid]

  if (!draft || closedRequests.has(key) || serverClosed.has(key)) {
    return
  }

  if (unsupportedOwners.has(ownerKey(scope))) {
    setServerState(scope, request.requestId, 'unavailable')

    return
  }

  const now = resolveClarifyDraftScope({
    owner: target.owner,
    sessionId: request.sessionId,
    storedSessionId: target.storedSessionId
  })

  // An ambient (sole legacy backend) scope is only that backend while the same socket is ambient.
  const ambientMoved = scope.gateway.startsWith('ambient:') && $gateway.get() !== gateway

  if (!gateway || !request.sessionId || !sameScope(now, scope) || ambientMoved) {
    // The owner moved (or is no longer provable) since the edit: keep the device copy, send nothing.
    setServerState(scope, request.requestId, 'device-only')

    return
  }

  try {
    const reply = await requestForOwnedSession<DraftReply>(
      request.sessionId,
      gateway.request.bind(gateway) as typeof gateway.request,
      'clarify.draft',
      {
        choices: draft.choices,
        question_id: qid,
        request_id: request.requestId,
        revision: draft.revision,
        session_id: request.sessionId,
        text: draft.text
      }
    )

    if (reply?.status === 'ok' || reply?.status === 'stale') {
      // `ok` holds our revision; `stale` holds ITS revision (maybe another viewer's). Either way only
      // `durable === true` says that held revision is on disk: staleness alone proves nothing.
      const held = reply.status === 'ok' ? draft.revision : typeof reply.revision === 'number' ? reply.revision : 0

      noteAcknowledged(scope, request.requestId, qid, held, reply.durable === true)
      setServerState(scope, request.requestId, 'saved')
    } else if (reply?.status === 'discarded') {
      // The server copy was explicitly discarded: final, never re-saved there. This device's copy stays.
      serverClosed.add(key)
      setServerState(scope, request.requestId, 'device-only')
    } else if (reply?.status === 'expired') {
      // The request ended (or is not this session's): the device copy is all there is.
      serverClosed.add(key)
      setServerState(scope, request.requestId, 'device-only')
    }
    // `locked`: the answer already won on the server; nothing to save.
  } catch (error) {
    if (isMissingRpcMethod(error)) {
      // An older backend: keep the device copy, say so, never retry against it.
      unsupportedOwners.add(ownerKey(scope))
      setServerState(scope, request.requestId, 'unavailable')

      return
    }

    // Transient (network, reconnect): the next edit tries again; the device copy stands.
    setServerState(scope, request.requestId, 'device-only')
  }
}

/** Confirm is about to lock every answer: drop pending autosaves so no draft races the locks. */
export function cancelClarifyDraftSaves(scope: ClarifyDraftScope | null, requestId: string): void {
  if (!scope) {
    return
  }

  const prefix = `${clarifyDraftKey(scope, requestId)}\u0000`

  for (const [key, timer] of timers) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }
}

/**
 * Some locks succeeded (a partial or refused Confirm): exactly those questions'
 * drafts are superseded by their locked answers; every other draft stays
 * recoverable, and its pending autosave keeps running.
 */
export function markClarifyDraftsLocked(scope: ClarifyDraftScope | null, requestId: string, qids: string[]): void {
  if (!scope || qids.length === 0) {
    return
  }

  const key = clarifyDraftKey(scope, requestId)
  const locked = lockedQuestions.get(key) ?? new Set<string>()
  qids.forEach(qid => {
    locked.add(qid)
    const timer = timers.get(`${key}\u0000${qid}`)

    if (timer) {
      clearTimeout(timer)
      timers.delete(`${key}\u0000${qid}`)
    }
  })
  lockedQuestions.set(key, locked)

  const entry = readEntry(scope, requestId)

  if (!entry) {
    return
  }

  const drafts = Object.fromEntries(Object.entries(entry.drafts).filter(([qid]) => !locked.has(qid)))

  if (Object.keys(drafts).length === 0) {
    removeEntry(key)
  } else {
    writeEntry({ ...entry, drafts })
  }
}

/** The batch was submitted: its drafts are superseded by the answers. */
export function forgetClarifyDrafts(scope: ClarifyDraftScope | null, requestId: string): void {
  if (!scope) {
    return
  }

  const key = clarifyDraftKey(scope, requestId)
  cancelClarifyDraftSaves(scope, requestId)
  closedRequests.add(key)
  removeEntry(key)
}

/**
 * The device copy a settled card may show: the exact request id when the card
 * has one, else the ONE copy in this exact scope whose card was this tool call.
 * Two copies sharing a tool-call id (providers that name every call `call_0`)
 * are ambiguous and attach nothing.
 */
export function findClarifyDraftsForCard(options: {
  requestId?: null | string
  scope: ClarifyDraftScope | null
  toolCallId?: null | string
}): null | StoredClarifyDrafts {
  const { requestId, scope, toolCallId } = options

  if (!scope) {
    return null
  }

  if (requestId) {
    return readEntry(scope, requestId)
  }

  if (!toolCallId) {
    return null
  }

  const matches = allEntries().filter(
    ({ entry, key }) =>
      entry.toolCallId === toolCallId &&
      belongs(entry, scope, entry.requestId) &&
      key === clarifyDraftKey(scope, entry.requestId)
  )

  return matches.length === 1 ? matches[0].entry : null
}

/** What a discard actually removed: never reported as more than the server confirmed. */
export interface ClarifyDraftDiscardResult {
  /** This device held a copy and it is gone. */
  device: boolean
  server: 'failed' | 'missing' | 'removed' | 'unreachable' | 'unsupported'
}

/**
 * Drop a request's saved drafts, explicitly: this device's copy and the
 * server's durable record for the SAME owned session (`sessionId` is the
 * runtime id the backend has attached now, not the one that raised the
 * request). The result states exactly what was removed.
 */
export async function discardClarifyDrafts(
  scope: ClarifyDraftScope | null,
  requestId: string,
  sessionId: null | string
): Promise<ClarifyDraftDiscardResult> {
  const device = Boolean(scope && readEntry(scope, requestId))
  forgetClarifyDrafts(scope, requestId)
  const gateway = $gateway.get()

  if (!scope || !gateway || !sessionId) {
    return { device, server: 'unreachable' }
  }

  if (unsupportedOwners.has(ownerKey(scope)) || $clarifyDraftRecallUnavailable.get()[ownerKey(scope)]) {
    return { device, server: 'unsupported' }
  }

  try {
    const reply = await requestForOwnedSession<{ status?: string }>(
      sessionId,
      gateway.request.bind(gateway) as typeof gateway.request,
      'clarify.drafts.discard',
      { request_id: requestId, session_id: sessionId }
    )

    return { device, server: reply?.status === 'ok' ? 'removed' : reply?.status === 'missing' ? 'missing' : 'failed' }
  } catch (error) {
    return { device, server: isMissingRpcMethod(error) ? 'unsupported' : 'failed' }
  }
}

// ── Durable recall (`clarify.drafts`) ──────────────────────────────────────

/** One request's drafts as the backend's durable store holds them (read back after a timeout or restart). */
export interface ServerClarifyDraftRecord {
  requestId: string
  updatedAt: number
  outcome: null | string
  questions: { choices: string[] | null; qid: string; question: string }[]
  drafts: Record<string, ClarifyDraftEntry>
}

export type ClarifyDraftRecall =
  | { records: ServerClarifyDraftRecord[]; status: 'ok' }
  | { status: 'error' }
  | { status: 'unavailable' }
  | { status: 'unscoped' }

/** Owner gateways (`gateway\0profile`) whose backend has no `clarify.drafts`: recall is not offered again. */
export const $clarifyDraftRecallUnavailable = atom<Record<string, true>>({})

export const clarifyDraftOwnerKey = (scope: ClarifyDraftScope): string => ownerKey(scope)

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

function parseRecord(raw: unknown): null | ServerClarifyDraftRecord {
  const row = raw as null | Record<string, unknown>

  if (!row || typeof row !== 'object' || typeof row.request_id !== 'string' || !row.request_id) {
    return null
  }

  const drafts: Record<string, ClarifyDraftEntry> = {}

  for (const [qid, value] of Object.entries((row.drafts as Record<string, unknown>) ?? {})) {
    const draft = value as null | Record<string, unknown>

    if (draft && isStringList(draft.choices) && typeof draft.text === 'string' && typeof draft.revision === 'number') {
      drafts[qid] = { choices: draft.choices, revision: draft.revision, text: draft.text }
    }
  }

  const questions = (Array.isArray(row.questions) ? row.questions : []).flatMap(value => {
    const question = value as null | Record<string, unknown>

    return question && typeof question.qid === 'string' && typeof question.question === 'string'
      ? [
          {
            choices: isStringList(question.choices) ? question.choices : null,
            qid: question.qid,
            question: question.question
          }
        ]
      : []
  })

  return {
    drafts,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    questions,
    requestId: row.request_id,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0
  }
}

/**
 * Read the backend's durable drafts for THIS owned session (the runtime id the
 * backend attached), exactly one request's when `requestId` is given. A read
 * only: nothing is locked, sent or restored into a form. An older backend
 * (-32601) is remembered per owner and never asked again.
 */
export async function recallServerClarifyDrafts(
  scope: ClarifyDraftScope | null,
  sessionId: null | string,
  requestId?: null | string
): Promise<ClarifyDraftRecall> {
  const gateway = $gateway.get()

  if (!scope || !sessionId || !gateway) {
    return { status: 'unscoped' }
  }

  if ($clarifyDraftRecallUnavailable.get()[ownerKey(scope)]) {
    return { status: 'unavailable' }
  }

  try {
    const reply = await requestForOwnedSession<{ drafts?: unknown }>(
      sessionId,
      gateway.request.bind(gateway) as typeof gateway.request,
      'clarify.drafts',
      requestId ? { request_id: requestId, session_id: sessionId } : { session_id: sessionId }
    )

    const records = (Array.isArray(reply?.drafts) ? reply.drafts : [])
      .map(parseRecord)
      .filter((record): record is ServerClarifyDraftRecord => record !== null)
      // Exact or nothing: never trust a different request's record for this card.
      .filter(record => !requestId || record.requestId === requestId)

    return { records, status: 'ok' }
  } catch (error) {
    if (isMissingRpcMethod(error)) {
      $clarifyDraftRecallUnavailable.set({ ...$clarifyDraftRecallUnavailable.get(), [ownerKey(scope)]: true })

      return { status: 'unavailable' }
    }

    return { status: 'error' }
  }
}

/** The newer of two copies of one question's draft, by revision (a tie keeps this device's). */
export function newestClarifyDraft(
  device?: ClarifyDraftEntry,
  server?: ClarifyDraftEntry
): { draft: ClarifyDraftEntry; from: 'device' | 'server' } | null {
  if (!device && !server) {
    return null
  }

  if (device && (!server || device.revision >= server.revision)) {
    return { draft: device, from: 'device' }
  }

  return { draft: server as ClarifyDraftEntry, from: 'server' }
}

// ── Session deletion ────────────────────────────────────────────────────────

export interface ClarifyDraftPurgeResult {
  removed: number
  /** Copies naming one of the deleted ids but another (or an unprovable) owner: kept, never silently dropped. */
  retained: { key: string; reason: 'owner-mismatch' | 'owner-unknown' }[]
}

function ownerMatches(entry: StoredClarifyDrafts, owner: SessionOwnerScope): 'match' | 'mismatch' | 'unknown' {
  const profile = normalizeProfileKey(entry.profile)

  if (isSessionOwnerRoute(owner)) {
    const id = owner.connectionId.trim()
    const profiles = [owner.profile, owner.targetProfile ?? owner.profile].map(normalizeProfileKey)
    const gateways = [`connection:${id}`, `ambient:${id}`]

    return id && gateways.includes(entry.gateway) && profiles.includes(profile) ? 'match' : 'mismatch'
  }

  if (typeof owner === 'string' && owner.trim()) {
    const primary = activeGatewayConnectionId()

    const gatewayOk =
      entry.gateway === 'profile-pool' ||
      entry.gateway.startsWith('ambient:') ||
      Boolean(primary && entry.gateway === `connection:${primary}`)

    return gatewayOk && normalizeProfileKey(owner) === profile ? 'match' : 'mismatch'
  }

  // No owner named: only the sole legacy backend is provably the owner.
  return ambientGatewayOwnsEverySession() ? (entry.gateway.startsWith('ambient:') ? 'match' : 'mismatch') : 'unknown'
}

/**
 * A conversation was DELETED (the delete RPC landed): drop its device copies
 * under the deleting owner. `ids` are every id the delete holds (stored tip,
 * row id, lineage root, runtime ids). Other sessions, and the same ids under
 * another gateway or profile, are kept and reported, never silently dropped.
 */
export function purgeClarifyDraftsForDeletedSession(
  ids: readonly (null | string | undefined)[],
  owner: SessionOwnerScope
): ClarifyDraftPurgeResult {
  const wanted = new Set(ids.filter((id): id is string => Boolean(id)))
  const result: ClarifyDraftPurgeResult = { removed: 0, retained: [] }

  for (const { entry, key } of allEntries()) {
    const session = entry.session.startsWith('stored:')
      ? entry.session.slice('stored:'.length)
      : entry.session.startsWith('runtime:')
        ? entry.session.slice('runtime:'.length)
        : null

    if (!session || !wanted.has(session)) {
      continue
    }

    const verdict = ownerMatches(entry, owner)

    if (verdict === 'match') {
      cancelClarifyDraftSaves(entry, entry.requestId)
      closedRequests.add(key)
      removeEntry(key)
      result.removed += 1
    } else {
      result.retained.push({ key, reason: verdict === 'mismatch' ? 'owner-mismatch' : 'owner-unknown' })
    }
  }

  return result
}

/** Plain text of a set of drafts, for the clipboard. */
export function clarifyDraftsText(rows: { choices: string[]; question: string; text: string }[]): string {
  return rows.map(row => [row.question, row.choices.join(', '), row.text].filter(Boolean).join('\n')).join('\n\n')
}

/** Tests: forget this renderer's memory (a reload). Device storage is left alone. */
export function resetClarifyDraftsForTests(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer)
  }

  timers.clear()
  memory.clear()
  lockedQuestions.clear()
  deviceFailed.clear()
  closedRequests.clear()
  serverClosed.clear()
  unsupportedOwners.clear()
  $clarifyDraftServerState.set({})
  $clarifyDraftStatus.set({})
  $clarifyDraftRecallUnavailable.set({})
}
