import {
  isBlankDraft,
  type ServerClarifyDraftRecord,
  serverDurablyHoldsDraft,
  type StoredClarifyDrafts
} from '@/store/clarify-drafts'

import type { ClarifyDraftRow, ClarifyResponse } from './parse'

/** One unsent draft row on a settled card. */
export interface DraftRow {
  choices: string[]
  question: string
  /**
   * What the ASSISTANT received in this transcript: this exact version ('received'), an
   * older one ('older'), or nothing ('none'). Says nothing about storage.
   */
  transcript: 'none' | 'older' | 'received'
  /**
   * Whether the server confirmed THIS version on its disk: 'confirmed' (durable true or
   * read back from the durable store), 'not-on-disk' (the server said false), 'unknown'.
   */
  disk: 'confirmed' | 'not-on-disk' | 'unknown'
  text: string
}

type DraftVersion = { choices: string[]; revision?: number; text: string }

/** One copy of a question's draft and where it came from. */
type Candidate = { draft: DraftVersion; source: 'device' | 'record' | 'terminal' }

interface QuestionSources {
  device: null | StoredClarifyDrafts
  qid?: string
  /** The durable record's copy (`clarify.drafts`), when recalled. */
  stored?: DraftVersion
  /** The terminal tool result's copy (what the assistant was told). */
  told?: ClarifyDraftRow
  terminalDurable?: boolean
}

const sameContent = (a: { choices: string[]; text: string }, b: { choices: string[]; text: string }) =>
  a.text === b.text && a.choices.join('\n') === b.choices.join('\n')

/** The terminal row for one question: by question id when both sides know it, else by position. */
function terminalRowFor(terminal: ClarifyDraftRow[], qid: string | undefined, index: number) {
  return terminal.find(entry => (qid && entry.questionId ? entry.questionId === qid : entry.questionIndex === index))
}

/** Every copy of the question's draft, device first (ties keep the device copy). */
function candidatesFor({ device, qid, stored, told }: QuestionSources): Candidate[] {
  const local = qid ? device?.drafts[qid] : undefined

  return [
    ...(local ? [{ draft: local, source: 'device' as const }] : []),
    ...(stored ? [{ draft: stored, source: 'record' as const }] : []),
    ...(told ? [{ draft: told, source: 'terminal' as const }] : [])
  ]
}

/** A copy without a revision is unknown-age: it never beats a copy whose revision is known. */
const ageOf = (candidate: Candidate) => candidate.draft.revision ?? -1

/** The newest copy by revision; the earliest listed wins a tie. */
function newestCandidate(candidates: Candidate[]): Candidate | null {
  return candidates.reduce<Candidate | null>((best, next) => (!best || ageOf(next) > ageOf(best) ? next : best), null)
}

const sameRevision = (copy: DraftVersion | undefined, revision: number | undefined) =>
  revision !== undefined && copy?.revision === revision

/** Whether the assistant received the shown version (from the terminal result alone). */
function transcriptOf(told: ClarifyDraftRow | undefined, pick: Candidate): DraftRow['transcript'] {
  if (!told) {
    return 'none'
  }

  const received =
    pick.source === 'terminal' || sameRevision(told, pick.draft.revision) || sameContent(told, pick.draft)

  return received ? 'received' : 'older'
}

/** The terminal result's own disk claim (`drafts_durable`): true, false, or absent = unknown. */
function terminalDiskOf(terminalDurable: boolean | undefined): DraftRow['disk'] {
  if (terminalDurable === undefined) {
    return 'unknown'
  }

  return terminalDurable ? 'confirmed' : 'not-on-disk'
}

/** Whether the server confirmed the shown version on disk; never inferred from transcript presence. */
function diskOf(sources: QuestionSources, pick: Candidate): DraftRow['disk'] {
  const { device, qid, stored, terminalDurable, told } = sources
  const revision = pick.draft.revision

  if (pick.source === 'record' || sameRevision(stored, revision)) {
    return 'confirmed'
  }

  if (pick.source === 'device' && device && qid && serverDurablyHoldsDraft(device, qid)) {
    return 'confirmed'
  }

  return pick.source === 'terminal' || sameRevision(told, revision) ? terminalDiskOf(terminalDurable) : 'unknown'
}

/**
 * Per unanswered question, the NEWEST of this device's copy, the durable record (when
 * recalled) and the terminal tool result, by revision. A terminal row without a revision
 * is unknown-age and never beats a copy whose revision is known; ties keep the device
 * copy. A newest CLEARED copy means no draft (no resurrection). Rows match by question
 * id (or position inside the exact request), never by question text.
 */
export function reconcileRows(
  responses: ClarifyResponse[],
  sources: {
    device: null | StoredClarifyDrafts
    record?: null | ServerClarifyDraftRecord
    terminal: ClarifyDraftRow[]
    terminalDurable?: boolean
  }
): DraftRow[] {
  const { device, record, terminal, terminalDurable } = sources

  return responses.flatMap((row, index): DraftRow[] => {
    if (!row.unanswered) {
      return []
    }

    const qid = device?.questions[index]?.qid ?? record?.questions[index]?.qid

    const question: QuestionSources = {
      device,
      qid,
      stored: qid ? record?.drafts[qid] : undefined,
      terminalDurable,
      told: terminalRowFor(terminal, qid, index)
    }

    const pick = newestCandidate(candidatesFor(question))

    if (!pick || isBlankDraft(pick.draft)) {
      return []
    }

    return [
      {
        choices: pick.draft.choices,
        disk: diskOf(question, pick),
        question: row.question ?? '',
        text: pick.draft.text,
        transcript: transcriptOf(question.told, pick)
      }
    ]
  })
}
