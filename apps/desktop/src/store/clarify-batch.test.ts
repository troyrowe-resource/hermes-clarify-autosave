import { JsonRpcGatewayError } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $clarifyBatchAccepted,
  $clarifyBatchRefusals,
  isClarifyBatchRefusal,
  offerClarifyBatch,
  REFUSAL_TTL_MS,
  resetClarifyBatchForTests,
  submitKnownClarifyBatch,
  submitWithClarifyBatch
} from './clarify-batch'

const OWNER = { canonical: true, scopeKey: '["local","default"]' }

// An owner whose closed `prompt.submit` key set predates the field (gateway/session_controls.py).
const refusal = (fields?: string[]) =>
  new JsonRpcGatewayError('invalid_params', {
    code: 4001,
    data: { reason: 'invalid_params', ...(fields ? { fields } : {}) }
  })

beforeEach(() => {
  resetClarifyBatchForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('isClarifyBatchRefusal', () => {
  it.each([
    ['a contract check naming the key', refusal(['clarify_batch']), true],
    ['a contract check naming several keys, this one among them', refusal(['queued', 'clarify_batch']), true],
    ['a hand-written allowlist that names nothing', refusal(), true],
    ['a strict legacy contract naming the key', Object.assign(new Error('clarify_batch: Extra inputs'), { code: 4000 }), true],
    ['a refusal of other keys only', refusal(['attachments']), false],
    ['a legacy refusal of another key', Object.assign(new Error('submission_id: Extra inputs'), { code: 4000 }), false],
    ['a busy refusal', new JsonRpcGatewayError('busy', { code: 4001, data: { reason: 'busy' } }), false],
    ['a timeout', new Error('request timed out: prompt.submit'), false],
    ['a non-error', 'invalid_params', false]
  ])('%s', (_name, error, expected) => {
    expect(isClarifyBatchRefusal(error)).toBe(expected)
  })
})

describe('submitWithClarifyBatch', () => {
  it('offers the key to a canonical owner, leaving the caller params untouched', async () => {
    const params = { session_id: 's1', submission_id: 'sub-1', text: 'hi' }
    const send = vi.fn(async (sent: Record<string, unknown>) => sent)

    await expect(submitWithClarifyBatch(OWNER, params, send)).resolves.toMatchObject({ clarify_batch: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(params).not.toHaveProperty('clarify_batch')
  })

  it('never offers it to a non-canonical owner', async () => {
    const send = vi.fn(async (sent: Record<string, unknown>) => sent)

    await submitWithClarifyBatch({ ...OWNER, canonical: false }, { submission_id: 'sub-1' }, send)
    expect(send.mock.calls[0][0]).not.toHaveProperty('clarify_batch')
  })

  it('resends ONCE without the key under the same submission id, and remembers the owner only after that succeeded', async () => {
    const send = vi.fn(async (sent: Record<string, unknown>) => {
      if ('clarify_batch' in sent) {
        throw refusal(['clarify_batch'])
      }

      return { admission_id: sent.submission_id, status: 'started' }
    })

    await expect(submitWithClarifyBatch(OWNER, { submission_id: 'sub-1', text: 'hi' }, send)).resolves.toMatchObject({
      admission_id: 'sub-1'
    })
    expect(send.mock.calls.map(([sent]) => ['clarify_batch' in sent, sent.submission_id])).toEqual([
      [true, 'sub-1'],
      [false, 'sub-1']
    ])
    expect($clarifyBatchRefusals.get()[OWNER.scopeKey]).toBeGreaterThan(Date.now())

    // The next submit goes straight to the plain form: no second probe of an owner that said no.
    send.mockClear()
    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-2' }, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).not.toHaveProperty('clarify_batch')
  })

  it('has no second fallback loop: a failing resend surfaces, and blames nobody', async () => {
    const send = vi.fn(async (sent: Record<string, unknown>) => {
      throw 'clarify_batch' in sent ? refusal(['clarify_batch']) : refusal(['clarify_batch', 'text'])
    })

    await expect(submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, send)).rejects.toMatchObject({ code: 4001 })
    expect(send).toHaveBeenCalledTimes(2)
    expect($clarifyBatchRefusals.get()).toEqual({})
    expect(offerClarifyBatch(true, OWNER.scopeKey)).toBe(true)
  })

  it('surfaces any other refusal unchanged, with no resend and no memory', async () => {
    const send = vi.fn(async () => {
      throw refusal(['attachments'])
    })

    await expect(submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, send)).rejects.toMatchObject({ code: 4001 })
    expect(send).toHaveBeenCalledTimes(1)
    expect($clarifyBatchRefusals.get()).toEqual({})
  })

  it('keeps one owner independent of another', async () => {
    const send = vi.fn(async (sent: Record<string, unknown>) => {
      if ('clarify_batch' in sent && sent.session_id === 'old') {
        throw refusal(['clarify_batch'])
      }

      return sent
    })

    await submitWithClarifyBatch(OWNER, { session_id: 'old' }, send)
    expect(offerClarifyBatch(true, OWNER.scopeKey)).toBe(false)
    expect(offerClarifyBatch(true, '["other","default"]')).toBe(true)
  })

  it('offers the key again once the remembered refusal expires (an upgraded owner)', async () => {
    vi.useFakeTimers()
    $clarifyBatchRefusals.set({ [OWNER.scopeKey]: Date.now() + REFUSAL_TTL_MS })
    expect(offerClarifyBatch(true, OWNER.scopeKey)).toBe(false)

    vi.advanceTimersByTime(REFUSAL_TTL_MS + 1)
    expect(offerClarifyBatch(true, OWNER.scopeKey)).toBe(true)
  })
})

describe('what the owner has accepted', () => {
  it('is remembered when a submit that carried the key was accepted, and forgotten when the owner refuses it', async () => {
    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, async sent => sent)
    expect($clarifyBatchAccepted.get()).toEqual({ [OWNER.scopeKey]: true })

    // The owner was replaced by an older one that predates the field.
    $clarifyBatchRefusals.set({})

    const send = vi.fn(async (sent: Record<string, unknown>) => {
      if ('clarify_batch' in sent) {
        throw refusal(['clarify_batch'])
      }

      return sent
    })

    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-2' }, send)
    expect($clarifyBatchAccepted.get()).toEqual({})
  })

  it('is not taken from a submit that was sent without the key', async () => {
    await submitWithClarifyBatch({ ...OWNER, canonical: false }, { submission_id: 'sub-1' }, async sent => sent)
    expect($clarifyBatchAccepted.get()).toEqual({})
  })
})

describe('submitKnownClarifyBatch (a submit that cannot be resent)', () => {
  it('sends the plain form to an owner that has not accepted the key, and learns nothing from it', async () => {
    const send = vi.fn(async (sent: Record<string, unknown>) => sent)

    await submitKnownClarifyBatch(OWNER, { text: 'hi' }, send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).not.toHaveProperty('clarify_batch')
    expect($clarifyBatchAccepted.get()).toEqual({})
  })

  it('offers the key to an owner that accepted it, leaving the caller params untouched', async () => {
    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, async sent => sent)
    const params = { text: 'hi' }
    const send = vi.fn(async (sent: Record<string, unknown>) => sent)

    await expect(submitKnownClarifyBatch(OWNER, params, send)).resolves.toMatchObject({ clarify_batch: true })
    expect(params).not.toHaveProperty('clarify_batch')
  })

  it('never offers it to a non-canonical owner, or to one that refused it', async () => {
    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, async sent => sent)
    const send = vi.fn(async (sent: Record<string, unknown>) => sent)

    await submitKnownClarifyBatch({ ...OWNER, canonical: false }, {}, send)
    $clarifyBatchRefusals.set({ [OWNER.scopeKey]: Date.now() + REFUSAL_TTL_MS })
    await submitKnownClarifyBatch(OWNER, {}, send)

    send.mock.calls.forEach(([sent]) => expect(sent).not.toHaveProperty('clarify_batch'))
  })

  it('does not resend a refusal: it is remembered, surfaced unchanged, and the key is not offered again', async () => {
    await submitWithClarifyBatch(OWNER, { submission_id: 'sub-1' }, async sent => sent)

    const send = vi.fn(async (sent: Record<string, unknown>) => {
      if ('clarify_batch' in sent) {
        throw refusal(['clarify_batch'])
      }

      return sent
    })

    await expect(submitKnownClarifyBatch(OWNER, { text: 'hi' }, send)).rejects.toMatchObject({ code: 4001 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(offerClarifyBatch(true, OWNER.scopeKey)).toBe(false)
    expect($clarifyBatchAccepted.get()).toEqual({})
  })
})
