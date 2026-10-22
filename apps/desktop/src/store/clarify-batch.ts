import { atom } from 'nanostores'

/**
 * Batch clarify opt-in.
 *
 * The clarify tool asks one to five questions in a single call. A canonical owner delivers them as ONE
 * request (the batch form: a single Confirm, and the unsent picks and typed text autosaved as drafts the
 * server keeps, `store/clarify-drafts.ts`) only for a turn whose submitter declares `clarify_batch` on
 * `prompt.submit` (`gateway/session_cli_turn.py::clarify_batch_turn`). A viewer that never asks gets one card
 * per question, and no server-side drafts at all. The classic CLI always asked; the Desktop did not.
 *
 * One ordered decision per submit:
 *  1. Not a canonical owner: never sent. A legacy `hermes serve` batches by itself and refuses an unknown
 *     `prompt.submit` key (4000).
 *  2. A canonical owner: sent, unless that owner refused it within the last {@link REFUSAL_TTL_MS}.
 *  3. A canonical owner that predates the field refuses it before admitting anything (4001 `invalid_params`).
 *     The submit is resent ONCE without the key, under the SAME submission id, and the owner is remembered as
 *     unsupported only after that resend was accepted. Any other refusal surfaces unchanged and blames no one.
 *
 * The memory is bounded: a runtime upgrade restarts the owner under the same route, so the key is offered
 * again after the TTL instead of staying off until the app is reloaded.
 *
 * An edit, a regenerate and a restore are different: the canonical client sends the owner's `session.rewind` and
 * THEN the submit, so a refused submit cannot be resent (it would rewind a second time, against rows the first
 * rewind already replaced). {@link submitKnownClarifyBatch} offers them the key only after an ordinary submit proved
 * the owner takes it, and never resends.
 */
export const REFUSAL_TTL_MS = 10 * 60_000

/** Owner scope key (`SubmissionDestination.scopeKey`) → epoch ms until which the owner is treated as not batching. */
export const $clarifyBatchRefusals = atom<Record<string, number>>({})

/** Owner scope keys whose owner accepted a submit that carried the key: proof it takes it. A refusal removes it. */
export const $clarifyBatchAccepted = atom<Record<string, true>>({})

/** Whether the owner this submit goes to should be offered `clarify_batch`. */
export function offerClarifyBatch(canonicalOwner: boolean, scopeKey: string, now = Date.now()): boolean {
  return canonicalOwner && ($clarifyBatchRefusals.get()[scopeKey] ?? 0) <= now
}

/** A canonical owner's refusal of the `clarify_batch` key (before any admission), not of something else. */
export function isClarifyBatchRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const { code, data, message } = error as { code?: unknown; data?: unknown; message?: unknown }
  const text = typeof message === 'string' ? message : ''
  const { fields, reason } = (data ?? {}) as { fields?: unknown; reason?: unknown }

  if (code === 4001 && (reason === 'invalid_params' || text === 'invalid_params')) {
    // `fields` names the keys the owner's contract check refused; an owner whose hand-written allowlist
    // predates the contract answers a bare `invalid_params`.
    return !Array.isArray(fields) || fields.includes('clarify_batch')
  }

  return code === 4000 && /clarify_batch/.test(text)
}

function rememberRefusal(scopeKey: string, now: number): void {
  console.warn('[clarify-batch] owner refused clarify_batch; its clarify questions stay one card each', { scopeKey })
  $clarifyBatchRefusals.set({ ...$clarifyBatchRefusals.get(), [scopeKey]: now + REFUSAL_TTL_MS })
  $clarifyBatchAccepted.set(Object.fromEntries(Object.entries($clarifyBatchAccepted.get()).filter(([key]) => key !== scopeKey)))
}

function rememberAcceptance(scopeKey: string): void {
  if (!$clarifyBatchAccepted.get()[scopeKey]) {
    $clarifyBatchAccepted.set({ ...$clarifyBatchAccepted.get(), [scopeKey]: true })
  }
}

/**
 * `prompt.submit` through the ladder above. `send` performs one RPC with the params it is given; the key is
 * added here, never stored in the caller's retained params.
 */
export async function submitWithClarifyBatch<T>(
  owner: { canonical: boolean; scopeKey: string },
  params: Record<string, unknown>,
  send: (params: Record<string, unknown>) => Promise<T>
): Promise<T> {
  if (!offerClarifyBatch(owner.canonical, owner.scopeKey)) {
    return send(params)
  }

  try {
    const accepted = await send({ ...params, clarify_batch: true })

    rememberAcceptance(owner.scopeKey)

    return accepted
  } catch (error) {
    if (!isClarifyBatchRefusal(error)) {
      throw error
    }
  }

  // Refused before admission, so nothing ran: one resend without the key (same submission id) is not a second turn.
  const accepted = await send(params)

  rememberRefusal(owner.scopeKey, Date.now())

  return accepted
}

/**
 * `prompt.submit` for a path that cannot be resent after a refusal (an edit, a regenerate, a restore: see the top of
 * this file). The key is offered only to an owner that already accepted it; a refusal after all (the owner was replaced
 * by an older one) is remembered, so the key is not offered again, and surfaces unchanged.
 */
export async function submitKnownClarifyBatch<T>(
  owner: { canonical: boolean; scopeKey: string },
  params: Record<string, unknown>,
  send: (params: Record<string, unknown>) => Promise<T>
): Promise<T> {
  if (!offerClarifyBatch(owner.canonical, owner.scopeKey) || !$clarifyBatchAccepted.get()[owner.scopeKey]) {
    return send(params)
  }

  try {
    return await send({ ...params, clarify_batch: true })
  } catch (error) {
    if (isClarifyBatchRefusal(error)) {
      rememberRefusal(owner.scopeKey, Date.now())
    }

    throw error
  }
}

/** Tests: forget every remembered refusal and acceptance. */
export function resetClarifyBatchForTests(): void {
  $clarifyBatchRefusals.set({})
  $clarifyBatchAccepted.set({})
}
