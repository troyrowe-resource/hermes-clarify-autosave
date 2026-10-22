import { JsonRpcGatewayError } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetClarifyBatchForTests, submitWithClarifyBatch } from '@/store/clarify-batch'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import { runRewindSubmit } from './rewind'

// An edit, a regenerate and a restore are `prompt.submit` too, and a turn they start is asked clarify questions like
// any other. They differ in one way that matters here: the canonical client sends them as the owner's
// `session.rewind` and THEN the submit, so a submit that was refused before admission cannot simply be sent again
// without the key (the second attempt would rewind a second time, against rows the first one already replaced). They
// therefore offer the key only to an owner that already accepted it on an ordinary submit, and never resend.

const CANONICAL = 'ws://127.0.0.1:1/api/ws?native_dial=unminted'
const LEGACY = 'ws://127.0.0.1:2/api/ws?token=t'
const SCOPE_KEY = JSON.stringify(['local', 'default'])

type Params = Record<string, unknown>

interface Call {
  method: string
  params?: Params
}

const connect = (wsUrl: string) =>
  $connection.set({ baseUrl: 'http://127.0.0.1:1', connectionId: 'local', mode: 'local', token: '', wsUrl } as never)

/** An ordinary submit to this owner that carried the key and was accepted. */
const acceptedAnOrdinarySubmit = () =>
  submitWithClarifyBatch({ canonical: true, scopeKey: SCOPE_KEY }, { text: 'an earlier turn' }, async () => 'accepted')

const gateway = (calls: Call[], onSubmit?: (params: Params) => unknown) =>
  (async (method: string, params?: Params) => {
    calls.push({ method, params })

    if (method === 'prompt.submit' && onSubmit) {
      return onSubmit(params ?? {})
    }

    return { status: 'streaming' }
  }) as <T>(method: string, params?: Params, timeoutMs?: number) => Promise<T>

const rewind = (request: ReturnType<typeof gateway>) =>
  runRewindSubmit(request, 'sid', 'fixed prompt', 1, undefined, false, undefined, 13, 'typo prompt', [11, 12, 13])

const submitsOf = (calls: Call[]) => calls.filter(call => call.method === 'prompt.submit').map(call => call.params!)

const refusal = () =>
  new JsonRpcGatewayError('invalid_params', {
    code: 4001,
    data: { fields: ['clarify_batch'], reason: 'invalid_params' }
  })

beforeEach(() => {
  $activeGatewayProfile.set('default')
  resetClarifyBatchForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  $connection.set(null)
})

describe('an edit / regenerate / restore submit and the clarify batch opt-in', () => {
  it('offers clarify_batch to a canonical owner that already accepted it, on the truncating submit', async () => {
    connect(CANONICAL)
    await acceptedAnOrdinarySubmit()
    const calls: Call[] = []

    await rewind(gateway(calls))

    expect(submitsOf(calls)).toHaveLength(1)
    expect(submitsOf(calls)[0]).toMatchObject({
      clarify_batch: true,
      text: 'fixed prompt',
      truncate_before_row_id: 13
    })
  })

  it('does not offer it to an owner that has not accepted it yet: nothing could be resent after a refusal', async () => {
    connect(CANONICAL)
    const calls: Call[] = []

    await rewind(gateway(calls))

    expect(submitsOf(calls)).toHaveLength(1)
    expect(submitsOf(calls)[0]).not.toHaveProperty('clarify_batch')
  })

  it('never offers it to a legacy hermes serve', async () => {
    connect(LEGACY)
    const calls: Call[] = []

    await rewind(gateway(calls))

    expect(submitsOf(calls)[0]).not.toHaveProperty('clarify_batch')
  })

  it('surfaces a refusal unchanged and does not resend it (that would rewind again), but does not offer the key again', async () => {
    connect(CANONICAL)
    await acceptedAnOrdinarySubmit()
    const calls: Call[] = []

    await expect(
      rewind(
        gateway(calls, params => {
          if ('clarify_batch' in params) {
            throw refusal()
          }

          return { status: 'streaming' }
        })
      )
    ).rejects.toMatchObject({ code: 4001 })
    expect(submitsOf(calls)).toHaveLength(1)

    const later: Call[] = []
    await rewind(gateway(later))

    expect(submitsOf(later)).toHaveLength(1)
    expect(submitsOf(later)[0]).not.toHaveProperty('clarify_batch')
  })

  it('does not take any other failure for a refusal of the key', async () => {
    connect(CANONICAL)
    await acceptedAnOrdinarySubmit()
    const calls: Call[] = []

    await expect(
      rewind(
        gateway(calls, () => {
          throw new Error('request timed out')
        })
      )
    ).rejects.toThrow('request timed out')

    const later: Call[] = []
    await rewind(gateway(later))

    expect(submitsOf(later)[0]).toMatchObject({ clarify_batch: true })
  })
})
