'use client'

import { useStore } from '@nanostores/react'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useI18n } from '@/i18n'
import { bareChoice, type ClarifyQuestion, type ClarifyRequest } from '@/store/clarify'
import {
  $clarifyDraftStatus,
  type ClarifyDraftEntry,
  clarifyDraftKey,
  type ClarifyDraftScope,
  type ClarifyDraftStatus,
  isBlankDraft,
  readClarifyDrafts,
  recordClarifyDraft,
  resendClarifyDraft,
  resolveClarifyDraftScope
} from '@/store/clarify-drafts'

import { emptyStage } from './core/question-block'

/** One question's staged state on the live card (choice labels + typed text). */
export type ClarifyStage = { choices: string[]; draft: string }

type Copy = ReturnType<typeof useI18n>['t']['assistant']['clarify']

/**
 * The live card's unsent-draft autosave (`store/clarify-drafts.ts`): resolve the
 * complete draft scope, restore the newest saved draft of the SAME request
 * (never a new one), and save every edited question as a draft — never a lock.
 * Call it after the card's locked-answer replay effect, so a locked answer is
 * staged first and a draft never overrides it.
 */
export function useClarifyDraftAutosave({
  liveQuestions,
  request,
  setStaged,
  staged,
  toolCallId
}: {
  liveQuestions: ClarifyQuestion[]
  request: ClarifyRequest | null
  setStaged: Dispatch<SetStateAction<Record<string, ClarifyStage>>>
  staged: Record<string, ClarifyStage>
  toolCallId?: string
}): { draftScope: ClarifyDraftScope | null; draftStatus?: ClarifyDraftStatus; markDirty: (qid: string) => void } {
  const storedSessionId = useStore(useSessionView().$storedId) ?? null

  // The complete draft identity (owner gateway + profile + session + request), or null when any
  // part is unproven: then nothing is stored or sent, and the card says so.
  const draftScope = useMemo(
    () =>
      request
        ? resolveClarifyDraftScope({ owner: request.owner, sessionId: request.sessionId, storedSessionId })
        : null,
    [request, storedSessionId]
  )

  const draftKey = draftScope && request ? clarifyDraftKey(draftScope, request.requestId) : ''
  const draftStatus = useStore($clarifyDraftStatus)[draftKey]

  // Saved drafts come back on a remount, reload or reconnect of the SAME request
  // (never a new one): the newest of the server's replay and this device's copy,
  // for questions without a locked answer and not already edited here.
  useEffect(() => {
    if (!request?.requestId) {
      return
    }

    const local = readClarifyDrafts(draftScope, request.requestId)?.drafts ?? {}
    const remote = request.drafts ?? {}

    // Keystrokes the server never acknowledged (typed offline, or lost in the save pause) go out again each time
    // the request is delivered. A reconnect usually leaves the card mounted, so this cannot wait for a remount.
    for (const question of liveQuestions) {
      const mine = local[question.qid]

      if (
        mine &&
        !isBlankDraft(mine) &&
        request.lockedAnswers?.[question.qid] === undefined &&
        (remote[question.qid]?.revision ?? 0) < mine.revision
      ) {
        resendClarifyDraft(draftScope, request, question.qid, storedSessionId)
      }
    }

    setStaged(current => {
      const next = { ...current }

      for (const question of liveQuestions) {
        const best = newestDraft(local[question.qid], remote[question.qid])

        if (
          !best ||
          isBlankDraft(best) ||
          current[question.qid] ||
          request.lockedAnswers?.[question.qid] !== undefined
        ) {
          continue
        }

        next[question.qid] = {
          choices: (question.choices ?? []).filter(choice => best.choices.includes(bareChoice(choice))),
          draft: best.text
        }
      }

      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request, and per delivery (a reconnect replay)
  }, [request?.requestId, request?.receivedAt, request?.drafts, draftKey])

  // Questions the user edited since the last autosave pass.
  const dirtyRef = useRef(new Set<string>())

  useEffect(() => {
    if (!request?.requestId || dirtyRef.current.size === 0) {
      return
    }

    for (const qid of dirtyRef.current) {
      const question = liveQuestions.find(entry => entry.qid === qid)

      if (question) {
        recordClarifyDraft(draftScope, request, question, staged[qid] ?? emptyStage, { storedSessionId, toolCallId })
      }
    }

    dirtyRef.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on edits; the request is read fresh
  }, [staged])

  const markDirty = useCallback((qid: string) => {
    dirtyRef.current.add(qid)
  }, [])

  return { draftScope, draftStatus, markDirty }
}

/** What the status line says for each draft status (never more than the stores confirmed). */
const STATUS_COPY: Record<ClarifyDraftStatus, (copy: Copy) => string> = {
  'device-only': copy => copy.draftDeviceOnly,
  'not-saved': copy => copy.draftNotSaved,
  saved: copy => copy.draftSaved,
  'server-only': copy => copy.draftServerOnly,
  'server-unconfirmed': copy => copy.draftServerUnconfirmed,
  unavailable: copy => copy.draftServerUnavailable
}

const hasStagedContent = (staged: Record<string, ClarifyStage>) =>
  Object.values(staged).some(stage => !isBlankDraft({ choices: stage.choices, text: stage.draft }))

/** The live card's draft status line: unscoped (nothing saved), or the store's truthful status. */
export function ClarifyDraftStatusLine({
  draftScope,
  draftStatus,
  ready,
  staged
}: {
  draftScope: ClarifyDraftScope | null
  draftStatus?: ClarifyDraftStatus
  ready: boolean
  staged: Record<string, ClarifyStage>
}) {
  const { t } = useI18n()
  const copy = t.assistant.clarify

  if (!ready) {
    return null
  }

  if (!draftScope) {
    return hasStagedContent(staged) ? (
      <span
        className="text-[0.6875rem] font-medium leading-4 text-(--ui-text-secondary)"
        data-clarify-draft-state="unscoped"
        role="status"
      >
        {copy.draftNotSavedOwner}
      </span>
    ) : null
  }

  if (!draftStatus) {
    return null
  }

  return (
    <span
      className={
        draftStatus === 'not-saved'
          ? 'text-[0.6875rem] font-medium leading-4 text-(--ui-text-secondary)'
          : 'text-[0.6875rem] leading-4 text-(--ui-text-tertiary)'
      }
      data-clarify-draft-state={draftStatus}
      role="status"
    >
      {STATUS_COPY[draftStatus](copy)}
    </span>
  )
}

/** The newer of two saved drafts of one question (by revision). */
function newestDraft(a?: ClarifyDraftEntry, b?: ClarifyDraftEntry): ClarifyDraftEntry | undefined {
  if (!a || !b) {
    return a ?? b
  }

  return a.revision >= b.revision ? a : b
}
