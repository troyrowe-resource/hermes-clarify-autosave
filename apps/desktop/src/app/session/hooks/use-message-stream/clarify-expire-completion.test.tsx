import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearClarifyRequest } from '@/store/clarify'
import { resetServerRequestsForTests } from '@/store/server-requests'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

// A clarify wait that times out is withdrawn (`request.cancel`) and then completed by the backend
// (`tool.complete`, carrying the drafts the assistant was told). The cancel projects a provisional
// "skipped" result onto the card at once; the real completion must REPLACE it in place. It used to append a
// second card (the projected part now "had a result", so nothing owned the completion), which showed two
// stacked settled cards until the turn ended.

const SID = 'session-1'
const QUESTIONS = [{ choices: ['Coffee', 'Tea'], qid: 'q0', question: 'Pick a drink?' }, { qid: 'q1', question: 'Anything else?' }]
const ARGS = { questions: [{ choices: ['Coffee', 'Tea'], question: 'Pick a drink?' }, { question: 'Anything else?' }] }

const TIMED_OUT = {
  drafts: [{ question_id: 'q0', question_index: 0, selected_choices: ['Tea'], typed_text: '' }],
  drafts_submitted: false,
  outcome: 'timed_out',
  responses: [
    { choices_offered: ['Coffee', 'Tea'], question: 'Pick a drink?', status: 'unanswered', user_response: null },
    { choices_offered: null, question: 'Anything else?', status: 'unanswered', user_response: null }
  ]
}

let stream: MessageStreamHarness

const toolStart = (tool_id: string) =>
  act(() => stream.handleEvent({ payload: { args: ARGS, name: 'clarify', tool_id }, session_id: SID, type: 'tool.start' }))

const clarifyRequest = (request_id: string) =>
  act(() => void stream.handleRequest('clarify', { questions: QUESTIONS, session_id: SID }, request_id))

const cancel = (requestId: string) =>
  act(() =>
    stream.handleEvent({
      payload: { id: requestId, method: 'clarify', reason: 'timeout' },
      session_id: SID,
      type: 'request.cancel'
    })
  )

const toolComplete = (tool_id: string, result: Record<string, unknown> = TIMED_OUT) =>
  act(() =>
    stream.handleEvent({ payload: { args: ARGS, name: 'clarify', result, tool_id }, session_id: SID, type: 'tool.complete' })
  )

const clarifyParts = () =>
  (stream.state().messages ?? [])
    .flatMap(message => message.parts)
    .filter(part => part.type === 'tool-call' && part.toolName === 'clarify')

describe('a timed-out clarify card', () => {
  beforeEach(() => {
    clearClarifyRequest()
    resetServerRequestsForTests()
    stream = renderMessageStream(SID)
  })

  afterEach(() => {
    cleanup()
    clearClarifyRequest()
    resetServerRequestsForTests()
    vi.restoreAllMocks()
  })

  it('is settled by the backend completion in place: one card after the cancel and the tool.complete', () => {
    toolStart('call-provider')
    clarifyRequest('srq-1')
    cancel('srq-1')

    // The cancel alone settles the card provisionally.
    expect(clarifyParts()).toHaveLength(1)
    expect(clarifyParts()[0]).toHaveProperty('result')

    toolComplete('call-provider')

    const parts = clarifyParts()
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ toolCallId: 'call-provider', result: { drafts_submitted: false, outcome: 'timed_out' } })
    expect((stream.state().messages ?? []).filter(message => message.role === 'assistant')).toHaveLength(1)
  })

  it('is still one card when the completion arrives long after the cancel', () => {
    toolStart('call-provider')
    clarifyRequest('srq-1')
    cancel('srq-1')
    act(() => stream.handleEvent({ payload: { text: 'thinking…' }, session_id: SID, type: 'message.delta' }))
    toolComplete('call-provider')

    expect(clarifyParts()).toHaveLength(1)
    expect(clarifyParts()[0]).toMatchObject({ result: { outcome: 'timed_out' } })
  })

  it('still gives a genuine second clarify call its own card', () => {
    toolStart('call-first')
    clarifyRequest('srq-1')
    cancel('srq-1')
    toolComplete('call-first')

    toolStart('call-second')
    clarifyRequest('srq-2')

    const parts = clarifyParts()
    expect(parts.map(part => part.type === 'tool-call' && part.toolCallId)).toEqual(['call-first', 'call-second'])
    expect(parts[0]).toMatchObject({ result: { outcome: 'timed_out' } })
    expect(parts[1]).not.toHaveProperty('result')

    cancel('srq-2')
    toolComplete('call-second', { ...TIMED_OUT, drafts: [] })

    expect(clarifyParts()).toHaveLength(2)
    expect(clarifyParts()[1]).toMatchObject({ toolCallId: 'call-second', result: { outcome: 'timed_out' } })
  })
})
