'use client'

import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import {
  $clarifyDraftCardDiscards,
  $clarifyDraftCardRecalls,
  $clarifyDraftRecallUnavailable,
  clarifyDraftCardKey,
  clarifyDraftDeviceStored,
  type ClarifyDraftDiscardState,
  clarifyDraftMemoLive,
  clarifyDraftOwnerKey,
  type ClarifyDraftRecallState,
  type ClarifyDraftScope,
  clarifyDraftsText,
  discardClarifyDraftsForCard,
  findClarifyDraftsForCard,
  isBlankDraft,
  recallClarifyDraftsForCard,
  resolveClarifyDraftScope,
  type ServerClarifyDraftRecord
} from '@/store/clarify-drafts'

import type { ClarifyDraftRow, ClarifyResponse } from './parse'
import { type DraftRow, reconcileRows } from './settled-reconcile'

type Copy = ReturnType<typeof useI18n>['t']['assistant']['clarify']

const NOTE = 'text-[0.6875rem] leading-4 text-(--ui-text-tertiary)'

const DISK_COPY: Record<DraftRow['disk'], (copy: Copy) => string> = {
  confirmed: copy => copy.draftDiskConfirmed,
  'not-on-disk': copy => copy.draftDiskNotSaved,
  unknown: copy => copy.draftDiskUnknown
}

function DraftRows({ deviceOnly, rows }: { deviceOnly: boolean; rows: DraftRow[] }) {
  const { t } = useI18n()
  const copy = t.assistant.clarify

  return (
    <>
      {rows.map((row, index) => (
        <div
          className="grid gap-0.5"
          data-clarify-draft=""
          data-clarify-draft-disk={row.disk}
          data-clarify-draft-transcript={row.transcript}
          key={`${index}-${row.question}`}
        >
          <span className="whitespace-pre-wrap text-[0.75rem] font-medium">{row.question}</span>
          {row.choices.length > 0 ? (
            <span className="whitespace-pre-wrap text-[0.75rem] text-(--ui-text-secondary)">
              {row.choices.join(', ')}
            </span>
          ) : null}
          {row.text.trim() ? (
            <span className="whitespace-pre-wrap text-[0.75rem] text-(--ui-text-secondary)">{row.text}</span>
          ) : null}
          {row.transcript === 'received' || deviceOnly ? null : (
            <span
              className="text-[0.6875rem] italic text-(--ui-text-tertiary)"
              data-clarify-draft-device-only={row.transcript}
            >
              {row.transcript === 'older' ? copy.draftNewerOnDevice : copy.draftNotInTranscript}
            </span>
          )}
          <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{DISK_COPY[row.disk](copy)}</span>
        </div>
      ))}
    </>
  )
}

const IDLE: ClarifyDraftRecallState = { status: 'idle' }

/**
 * The settled card's exact draft identity: this view's owner gateway + profile +
 * session, and the card's request id (or its unique tool-call association).
 * Never question text.
 */
function useSettledDraftIdentity(requestId: string | undefined, toolCallId: string | undefined) {
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId) ?? null
  const storedId = useStore(view.$storedId) ?? null

  const scope = useMemo(
    () => resolveClarifyDraftScope({ sessionId: runtimeId, storedSessionId: storedId }),
    [runtimeId, storedId]
  )

  const device = useMemo(
    () => findClarifyDraftsForCard({ requestId, scope, toolCallId }),
    [requestId, scope, toolCallId]
  )

  // The exact request this card settled: its result's / live id, else the device copy's exact association.
  const exactRequestId = requestId ?? device?.requestId ?? null

  // What the card's recall and discard have done is kept under this key, not in the component: the card is mounted
  // again when its message is replaced at the end of a turn.
  return { cardKey: clarifyDraftCardKey(scope, exactRequestId, toolCallId), device, exactRequestId, runtimeId, scope }
}

/**
 * Explicit, read-only durable recall (`clarify.drafts`) for this owned session. With
 * an exact request id the one record is merged by revision; without one, the
 * session's records are listed apart, never attached to this card.
 */
function useClarifyDraftRecall(
  scope: ClarifyDraftScope | null,
  runtimeId: null | string,
  exactRequestId: null | string,
  cardKey: null | string
) {
  const recallUnavailable = useStore($clarifyDraftRecallUnavailable)
  const recalls = useStore($clarifyDraftCardRecalls)
  const recall = (cardKey && recalls[cardKey]) || IDLE
  const ownerUnavailable = Boolean(scope && clarifyDraftMemoLive(recallUnavailable[clarifyDraftOwnerKey(scope)]))
  const exactRecord = recall.status === 'ok' && exactRequestId ? (recall.records[0] ?? null) : null

  const recallNow = () => {
    if (cardKey) {
      void recallClarifyDraftsForCard(cardKey, scope, runtimeId, exactRequestId)
    }
  }

  return {
    canRecall: Boolean(cardKey && runtimeId) && !ownerUnavailable && !exactRecord,
    exactRecord,
    listing: recall.status === 'ok' && !exactRequestId ? recall.records : null,
    recall,
    recallNow,
    unavailable: recall.status === 'unavailable' || ownerUnavailable
  }
}

type DraftRecall = ReturnType<typeof useClarifyDraftRecall>

/** The recall button and its truthful outcome lines. */
function DraftRecallControls({ exactRequestId, recall }: { exactRequestId: null | string; recall: DraftRecall }) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const { status } = recall.recall

  return (
    <>
      {recall.canRecall ? (
        <Button
          disabled={status === 'loading'}
          onClick={recall.recallNow}
          size="micro"
          type="button"
          variant="ghost"
        >
          {status === 'loading' ? copy.draftsRecalling : copy.draftsRecall}
        </Button>
      ) : null}
      {recall.unavailable ? (
        <p className={NOTE} data-clarify-drafts-recall="unavailable">
          {copy.draftsRecallUnavailable}
        </p>
      ) : null}
      {status === 'error' ? (
        <p className={NOTE} data-clarify-drafts-recall="error">
          {copy.draftsRecallFailed}
        </p>
      ) : null}
      {status === 'ok' && exactRequestId && !recall.exactRecord ? (
        <p className={NOTE} data-clarify-drafts-recall="none">
          {copy.draftsRecallNone}
        </p>
      ) : null}
      {recall.listing ? <SessionDraftListing records={recall.listing} /> : null}
    </>
  )
}

/** Exactly what a discard removed (never more than the server confirmed). */
function DiscardedNotice({ discarded }: { discarded: ClarifyDraftDiscardState }) {
  const { t } = useI18n()
  const copy = t.assistant.clarify

  return (
    <p className={NOTE} data-clarify-drafts-discarded="" role="status">
      {discarded === 'pending' ? copy.draftsDiscarding : copy.draftsDiscarded(discarded.device, discarded.server)}
    </p>
  )
}

/** The draft panel's header and notices: heading, copy / discard, who has seen them, device storage. */
function DraftsHeader({
  canDiscard,
  deviceOnly,
  memoryOnly,
  onDiscard,
  rows
}: {
  canDiscard: boolean
  deviceOnly: boolean
  memoryOnly: boolean
  onDiscard: () => void
  rows: DraftRow[]
}) {
  const { t } = useI18n()
  const copy = t.assistant.clarify

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-[0.75rem] font-medium text-(--ui-text-secondary)">{copy.draftsHeading}</span>
        <CopyButton appearance="inline" label={copy.draftsCopy} showLabel text={() => clarifyDraftsText(rows)} />
        {canDiscard ? (
          <Button onClick={onDiscard} size="micro" type="button" variant="ghost">
            {copy.draftsDiscard}
          </Button>
        ) : null}
      </div>
      <p className={NOTE}>{deviceOnly ? copy.draftsDeviceOnlyNotice : copy.draftsAssistantNotice}</p>
      {memoryOnly ? (
        <p
          className="text-[0.6875rem] font-medium leading-4 text-(--ui-text-secondary)"
          data-clarify-drafts-memory-only=""
        >
          {copy.draftsMemoryOnlyNotice}
        </p>
      ) : null}
    </>
  )
}

/**
 * The unsent drafts of a batch that ended without a submit: the server's copy
 * (what the assistant was told), this device's copy (the newest keystrokes,
 * and the only copy when the backend could not autosave), and on request the
 * backend's DURABLE record (`clarify.drafts`), which survives an app restart
 * that lost this device's copy. Readable, copyable and discardable; never
 * re-sent, never restored into a form and never shown as answers. The request
 * has ended, so nothing here can still answer it.
 */
export function ClarifyDrafts({
  requestId,
  responses,
  serverDrafts,
  serverDraftsDurable,
  toolCallId
}: {
  requestId?: string
  responses: ClarifyResponse[]
  serverDrafts: ClarifyDraftRow[]
  serverDraftsDurable?: boolean
  toolCallId?: string
}) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const { cardKey, device, exactRequestId, runtimeId, scope } = useSettledDraftIdentity(requestId, toolCallId)
  const recall = useClarifyDraftRecall(scope, runtimeId, exactRequestId, cardKey)
  const discards = useStore($clarifyDraftCardDiscards)
  const discarded = (cardKey && discards[cardKey]) || null

  const rows = reconcileRows(responses, {
    device,
    record: recall.exactRecord,
    terminal: serverDrafts,
    terminalDurable: serverDraftsDurable
  })

  const discardNow = () => {
    if (cardKey) {
      void discardClarifyDraftsForCard(cardKey, scope, exactRequestId ?? '', runtimeId)
    }
  }

  if (!responses.some(row => row.unanswered)) {
    return null
  }

  if (discarded) {
    return <DiscardedNotice discarded={discarded} />
  }

  const controls = <DraftRecallControls exactRequestId={exactRequestId} recall={recall} />

  if (rows.length === 0) {
    const shown = recall.canRecall || recall.unavailable || recall.recall.status !== 'idle'

    return shown ? (
      <div className="grid gap-1.5" data-clarify-drafts-recall="">
        {controls}
      </div>
    ) : null
  }

  const deviceOnly = rows.every(row => row.transcript === 'none')
  // This device's copy exists but its storage refused the newest write: only this window holds it.
  const memoryOnly = Boolean(device && exactRequestId && !clarifyDraftDeviceStored(scope, device.requestId))

  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-(--ui-border) px-2.5 py-2"
      data-clarify-drafts={deviceOnly ? 'device' : 'server'}
      data-clarify-drafts-recovered={recall.exactRecord ? 'exact' : undefined}
    >
      <DraftsHeader
        canDiscard={Boolean(exactRequestId && (device || recall.exactRecord))}
        deviceOnly={deviceOnly}
        memoryOnly={memoryOnly}
        onDiscard={discardNow}
        rows={rows}
      />
      <DraftRows deviceOnly={deviceOnly} rows={rows} />
      <p className={NOTE}>{copy.draftsContinue}</p>
      {controls}
    </div>
  )
}

/**
 * Every durable draft record of this conversation, newest first, for a card
 * that has no exact request id. Listed explicitly and labelled: identical
 * questions recur, so none is matched to this card by its text.
 */
function SessionDraftListing({ records }: { records: ServerClarifyDraftRecord[] }) {
  const { t } = useI18n()
  const copy = t.assistant.clarify

  return (
    <div className="grid gap-2" data-clarify-drafts-recovered="session">
      <p className={NOTE}>{records.length > 0 ? copy.draftsListNotice : copy.draftsListNone}</p>
      {records.map(record => {
        const rows = record.questions.flatMap((question): DraftRow[] => {
          const draft = record.drafts[question.qid]

          return draft && !isBlankDraft(draft)
            ? [
                {
                  choices: draft.choices,
                  disk: 'confirmed' as const,
                  question: question.question,
                  text: draft.text,
                  transcript: 'none' as const
                }
              ]
            : []
        })

        return (
          <div
            className="grid gap-1 rounded-md border border-dashed border-(--ui-border) px-2 py-1.5"
            data-clarify-drafts-record={record.requestId}
            key={record.requestId}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 text-[0.6875rem] text-(--ui-text-tertiary)">
                {record.updatedAt ? new Date(record.updatedAt * 1000).toLocaleString() : record.requestId}
              </span>
              <CopyButton appearance="inline" label={copy.draftsCopy} showLabel text={() => clarifyDraftsText(rows)} />
            </div>
            <DraftRows deviceOnly rows={rows} />
          </div>
        )
      })}
    </div>
  )
}
