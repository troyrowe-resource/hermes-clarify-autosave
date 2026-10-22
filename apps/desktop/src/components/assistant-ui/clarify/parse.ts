import { normalizeChoices } from '@/store/clarify'

import { parseMaybeObject } from '../tool/fallback-model/format'

export interface ClarifyArgs {
  questions?: { question: string; choices?: string[] | null; multiSelect?: boolean }[]
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]

  return typeof value === 'string' ? value : undefined
}

export function readClarifyArgs(args: unknown): ClarifyArgs {
  const row = parseMaybeObject(args)

  if (!Array.isArray(row.questions)) {
    return {}
  }

  // Entries are normalized leniently here (qid comes from the gateway request, not args).
  const questions = row.questions
    .map(entry => {
      const item = parseMaybeObject(entry)
      const text = stringField(item, 'question')

      if (!text) {
        return null
      }

      const itemChoices = normalizeChoices(item.choices)

      return {
        choices: itemChoices.length > 0 ? itemChoices : null,
        multiSelect: item.multi_select === true && itemChoices.length > 0,
        question: text
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  return questions.length > 0 ? { questions } : {}
}

export interface ClarifyResponse {
  question?: string
  answer?: string | string[]
  unanswered: boolean
}

/** One unsent draft the tool result reported beside (never inside) `responses`. */
export interface ClarifyDraftRow {
  questionIndex: number
  /** The question's qid, when the backend reports it: identity, never the question text. */
  questionId?: string
  /** The draft's revision, when known (1..2^53-1); absent = unknown, never invented. */
  revision?: number
  choices: string[]
  text: string
}

const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER

function readDrafts(raw: unknown): ClarifyDraftRow[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap(entry => {
    const item = parseMaybeObject(entry)
    const index = item.question_index
    const choices = Array.isArray(item.selected_choices) ? item.selected_choices.map(String) : []
    const text = typeof item.typed_text === 'string' ? item.typed_text : ''

    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return []
    }

    const row: ClarifyDraftRow = { choices, questionIndex: index, text }

    if (typeof item.question_id === 'string' && item.question_id) {
      row.questionId = item.question_id
    }

    if (validRevision(item.revision)) {
      row.revision = item.revision
    }

    return [row]
  })
}

/** Parse clarify tool JSON (`responses` array, and any unsent `drafts`). */
export function readClarifyResult(result: unknown): {
  drafts: ClarifyDraftRow[]
  /** `drafts_durable`: true = every reported draft is on the server's disk, false = not, absent = unknown. */
  draftsDurable?: boolean
  outcome?: string
  /** The exact request the result settled, when the backend reports it (opaque, never normalised). */
  requestId?: string
  responses: ClarifyResponse[]
} {
  const row = parseMaybeObject(result)

  if (!Array.isArray(row.responses)) {
    return { drafts: [], responses: [] }
  }

  // `drafts_request_id` is the backend's draft correlation; `request_id` if a producer names it directly.
  const requestId = [row.drafts_request_id, row.request_id].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  )

  const outcome = typeof row.outcome === 'string' ? row.outcome : undefined

  const responses = row.responses.map((entry): ClarifyResponse => {
    const item = parseMaybeObject(entry)
    const answer = item.user_response

    return {
      answer: Array.isArray(answer) ? answer.map(String) : typeof answer === 'string' ? answer : undefined,
      question: stringField(item, 'question'),
      unanswered: item.status === 'unanswered'
    }
  })

  // `drafts_submitted: false` is the only shape a draft list is read from.
  const drafts = row.drafts_submitted === false ? readDrafts(row.drafts) : []

  const draftsDurable = typeof row.drafts_durable === 'boolean' ? row.drafts_durable : undefined

  return { drafts, draftsDurable, outcome, requestId, responses }
}
