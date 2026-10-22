'use client'

import { useStore } from '@nanostores/react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { MessageQuestion } from '@/lib/icons'
import {
  bareChoice,
  type ClarifyQuestion,
  type ClarifyRequest,
  clearClarifyRequest,
  skipClarify
} from '@/store/clarify'
import { cancelClarifyDraftSaves, forgetClarifyDrafts, markClarifyDraftsLocked } from '@/store/clarify-drafts'
import { $gateway } from '@/store/gateway'
import { reconnectAction } from '@/store/gateway-reconnect'
import { notifyError } from '@/store/notifications'
import { forgetServerRequest } from '@/store/server-requests'
import { requestForOwnedSession } from '@/store/session-states'

import { ClarifyConfirmBar } from './core/confirm-bar'
import { emptyStage, QuestionBlock } from './core/question-block'
import { CLARIFY_ICON_CLASS, ClarifyShell } from './core/shell'
import { useClarifyKeys } from './core/use-clarify-keys'
import type { ClarifyArgs } from './parse'
import { ClarifyDraftStatusLine, type ClarifyStage, useClarifyDraftAutosave } from './pending-drafts'
import { handleClarifySubmitShortcut } from './submit-shortcut'
import { UndeliveredNotice } from './undelivered-notice'

/** Live batch card: all questions at once, staged locally, ONE confirm.
 * Picks and typed text stay editable until the user presses the single
 * "Confirm and continue" button, which sends the per-question locks
 * back-to-back and completes the batch. Until then every edit is autosaved
 * as an unsent DRAFT (`store/clarify-drafts.ts`: this device at once, the
 * server's `clarify.draft` after a pause), which never answers anything, so a
 * timeout or a lost connection cannot take the user's typing with it. The
 * per-question wire protocol is unchanged (the TUI/CLI still lock
 * incrementally); this card just batches its locks at the end. */
export function ClarifyToolPending({
  fromArgs,
  onAnswered,
  request,
  toolCallId,
  undelivered
}: {
  fromArgs?: ClarifyArgs
  onAnswered: () => void
  request: ClarifyRequest | null
  /** The transcript tool call rendering this card: stored with the drafts as their exact card association. */
  toolCallId?: string
  undelivered: boolean
}) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const gateway = useStore($gateway)
  // qids only exist on the gateway request — args are a hydration-race
  // fallback for display, never answerable (no ids to respond with).
  const liveQuestions = request?.questions ?? []
  const ready = Boolean(request?.requestId) && liveQuestions.length > 0

  // Preview items from the tool args: same question text/choices, synthetic
  // qids, shown disabled until the live request lands (or indefinitely when
  // the caller has no gateway request at all — e.g. an external tool call —
  // so the user sees the question instead of an endless spinner). ONE form
  // renders both states: every control is disabled while !ready, so nothing
  // is ever staged under a synthetic qid and the swap to live qids is clean.
  const previewQuestions: ClarifyQuestion[] = useMemo(
    () =>
      (fromArgs?.questions ?? []).map((entry, index) => ({
        choices: entry.choices ?? null,
        multiSelect: entry.multiSelect ?? false,
        qid: `args-${index}`,
        question: entry.question
      })),
    [fromArgs]
  )

  const questions = ready ? liveQuestions : previewQuestions

  const [staged, setStaged] = useState<Record<string, ClarifyStage>>({})
  const [submitting, setSubmitting] = useState(false)

  // Locked answers (a reconnect replay, or text typed in the composer) stage
  // their questions. A newly locked answer replaces what the card staged, so
  // Confirm never re-sends an older pick; an answer seen before is left alone,
  // so a later edit on the card stands.
  const [seenLocks, setSeenLocks] = useState<Record<string, null | string>>({})

  // A canonical gateway answers a batch one card at a time through the SAME
  // mounted tool row: a new live request is a new card, so the previous card's
  // submit latch, staged picks and seen locks must not carry over (that left
  // question 2 disabled behind question 1's spinner).
  const [cardRequestId, setCardRequestId] = useState(request?.requestId)

  if (request?.requestId !== cardRequestId) {
    setCardRequestId(request?.requestId)

    if (request?.requestId) {
      setSubmitting(false)
      setStaged({})
      setSeenLocks({})
    }
  }

  useEffect(() => {
    const lockedAnswers = request?.lockedAnswers

    if (!lockedAnswers) {
      return
    }

    setSeenLocks(lockedAnswers)

    setStaged(current => {
      const next = { ...current }

      for (const question of questions) {
        const answer = lockedAnswers[question.qid]

        if (answer === undefined || answer === null || seenLocks[question.qid] === answer) {
          continue
        }

        const options = question.choices ?? []
        let replayedAnswers = [answer]

        if (question.multiSelect) {
          try {
            const parsed = JSON.parse(answer)

            if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
              replayedAnswers = parsed
            }
          } catch {
            // Older/non-JSON replies remain a one-value replay below.
          }
        }

        const matchedChoices = options.filter(choice => replayedAnswers.includes(bareChoice(choice)))
        // Words that name no choice (typed in the composer) go to the free-text field as words, not JSON.
        const draft = replayedAnswers.filter(value => !options.some(choice => bareChoice(choice) === value)).join(', ')
        next[question.qid] = { choices: matchedChoices, draft }
      }

      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the replay map only
  }, [request?.lockedAnswers])

  // Unsent-draft autosave: AFTER the locked-answer replay above, so a locked answer is staged first.
  const { draftScope, draftStatus, markDirty } = useClarifyDraftAutosave({
    liveQuestions,
    request,
    setStaged,
    staged,
    toolCallId
  })

  const stageFor = (qid: string) => staged[qid] ?? emptyStage

  const stagedAnswer = useCallback(
    (question: ClarifyQuestion): string | null => {
      const stage = staged[question.qid] ?? emptyStage
      const draft = stage.draft.trim()

      if (question.multiSelect) {
        // The typed text is an additional answer, not a replacement for the
        // staged choices.
        const combined = [...stage.choices.map(bareChoice), ...(draft ? [draft] : [])]

        return combined.length > 0 ? JSON.stringify(combined) : null
      }

      if (stage.choices.length > 0) {
        return bareChoice(stage.choices[0])
      }

      return draft ? draft : null
    },
    [staged]
  )

  const answeredCount = questions.filter(q => stagedAnswer(q) !== null).length
  const canConfirm = answeredCount > 0

  const confirmAll = useCallback(async () => {
    if (!request || !gateway) {
      notifyError(
        new Error(request ? copy.gatewayDisconnected : copy.notReady),
        copy.sendFailed,
        request ? { action: reconnectAction() } : {}
      )

      return
    }

    setSubmitting(true)
    // The locks are the answers: no autosave may race them.
    cancelClarifyDraftSaves(draftScope, request.requestId)
    // Questions whose lock the server accepted: only these drafts are superseded.
    const lockedQids: string[] = []
    let refused = false

    try {
      // Sequential, not Promise.all: the LAST lock resolves the blocked
      // server request, so every earlier lock must already be accepted when
      // it lands — a reordered burst could complete the batch with a missing
      // answer. `clarify.lock` is a normal RPC; it rides the session's OWNER
      // socket (a profile / Bot Chat switch re-points ambient elsewhere).
      for (const question of questions) {
        const answer = stagedAnswer(question)

        const reply = await requestForOwnedSession<{ remaining?: string[]; status?: string }>(
          request.sessionId,
          gateway.request.bind(gateway) as typeof gateway.request,
          'clarify.lock',
          {
            answer,
            question_id: question.qid,
            request_id: request.requestId
          }
        )

        if (reply?.status === 'expired') {
          refused = true
        } else {
          lockedQids.push(question.qid)
        }
      }

      forgetServerRequest(request.requestId)

      if (refused) {
        // The request ended before every lock landed: what was not locked was not submitted.
        markClarifyDraftsLocked(draftScope, request.requestId, lockedQids)
      } else {
        forgetClarifyDrafts(draftScope, request.requestId)
      }

      triggerHaptic('submit')
      onAnswered()
      // tool.complete lands next → ClarifyToolSettled.
      clearClarifyRequest(request.requestId, request.sessionId)
    } catch (error) {
      // A failed lock leaves every unlocked draft recoverable.
      markClarifyDraftsLocked(draftScope, request.requestId, lockedQids)
      notifyError(error, copy.sendFailed)
      setSubmitting(false)
    }
  }, [copy, draftScope, gateway, onAnswered, questions, request, stagedAnswer])

  const toggleChoice = useCallback(
    (question: ClarifyQuestion, choice: string) => {
      markDirty(question.qid)
      setStaged(current => {
        const stage = current[question.qid] ?? emptyStage

        const next = question.multiSelect
          ? stage.choices.includes(choice)
            ? stage.choices.filter(value => value !== choice)
            : [...stage.choices, choice]
          : [choice]

        // Multi-select keeps the typed text alongside the toggled choices;
        // single-select stays mutually exclusive.
        return { ...current, [question.qid]: { choices: next, draft: question.multiSelect ? stage.draft : '' } }
      })
    },
    [markDirty]
  )

  const draftFor = useCallback(
    (question: ClarifyQuestion, value: string) => {
      markDirty(question.qid)
      setStaged(current => {
        const stage = current[question.qid] ?? emptyStage

        // Multi-select keeps the staged choices while the free-text field is
        // edited; single-select stays mutually exclusive.
        return { ...current, [question.qid]: { choices: question.multiSelect ? stage.choices : [], draft: value } }
      })
    },
    [markDirty]
  )

  const cancelAll = useCallback(async () => {
    if (!request) {
      return
    }

    onAnswered()
    // A response with no `answers` is the cancel-all (the plain Esc path).
    skipClarify(request)
  }, [onAnswered, request])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (ready && canConfirm) {
        void confirmAll()
      }
    },
    [canConfirm, confirmAll, ready]
  )

  const clearStage = useCallback(
    (question: ClarifyQuestion) => {
      markDirty(question.qid)
      setStaged(current => ({ ...current, [question.qid]: emptyStage }))
    },
    [markDirty]
  )

  const isStaged = useCallback((question: ClarifyQuestion) => stagedAnswer(question) !== null, [stagedAnswer])

  const formRef = useRef<HTMLFormElement | null>(null)

  const keys = useClarifyKeys({
    enabled: ready && !submitting,
    formRef,
    isStaged,
    onClear: clearStage,
    onConfirm: () => void confirmAll(),
    onToggle: toggleChoice,
    questions
  })

  const disabled = submitting || !ready

  if (questions.length === 0) {
    return (
      <ClarifyShell aria-label={copy.loadingQuestion} className="my-1.5 grid min-h-12 place-items-center" role="status">
        <Loader aria-hidden="true" className="size-6 text-(--ui-text-tertiary)" role="presentation" type="rose-curve" />
      </ClarifyShell>
    )
  }

  return (
    <form
      aria-busy={ready || undelivered ? undefined : 'true'}
      className="my-1.5 grid gap-4"
      data-clarify-batch={questions.length}
      data-clarify-batch-preview={ready ? undefined : ''}
      data-clarify-choices={ready ? questions[keys.activeQuestion]?.choices?.length || undefined : undefined}
      onKeyDownCapture={handleClarifySubmitShortcut}
      onSubmit={handleSubmit}
      ref={formRef}
    >
      {ready || undelivered ? null : (
        <span className="sr-only" role="status">
          {copy.loadingQuestion}
        </span>
      )}
      <ClarifyShell className="grid gap-3">
        <div className="flex items-start gap-2">
          <span className="flex-1 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
            {questions.length === 1 ? copy.oneQuestion : copy.questionProgress(answeredCount, questions.length)}
          </span>
          <MessageQuestion aria-hidden className={CLARIFY_ICON_CLASS} />
        </div>
        <ClarifyDraftStatusLine draftScope={draftScope} draftStatus={draftStatus} ready={ready} staged={staged} />
        {undelivered ? <UndeliveredNotice /> : null}
        {questions.map((question, index) => (
          <QuestionBlock
            cursor={ready && keys.activeQuestion === index ? keys.cursorRow : null}
            disabled={disabled}
            key={question.qid}
            onActivate={() => keys.focusQuestion(index)}
            onDraft={value => draftFor(question, value)}
            onOtherFocus={() => keys.onOtherFocus(index)}
            onPick={choiceIndex => keys.pick(index, choiceIndex)}
            question={question}
            staged={stageFor(question.qid)}
          />
        ))}
      </ClarifyShell>

      {undelivered ? null : (
        <ClarifyConfirmBar
          canConfirm={canConfirm}
          disabled={disabled}
          onSkip={() => void cancelAll()}
          submitting={submitting}
        />
      )}
    </form>
  )
}
