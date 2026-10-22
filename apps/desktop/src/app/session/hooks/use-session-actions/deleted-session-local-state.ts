import { purgeInFlightTurnJournals } from '@/lib/inflight-turn-journal'
import { purgeClarifyDraftsForDeletedSession } from '@/store/clarify-drafts'
import { clearQueuedPrompts } from '@/store/composer-queue'
import { prunePreviewTabsForSession } from '@/store/preview'
import { type SessionOwnerScope } from '@/store/session-request-router'
import { forgetSessionUnread } from '@/store/session-unread'
import { dropTranscriptTailEverywhere } from '@/store/transcript-tail-cache'

/**
 * A session delete LANDED (the RPC resolved): drop the renderer-local state the
 * deleted conversation owned. Only after the RPC — the optimistic eviction in
 * removeSession can roll back, and a rolled-back row must keep its watermark,
 * queued prompts, journal, drafts and preview tabs.
 */
export function purgeDeletedSessionLocalState({
  closingRuntimeId,
  owner,
  profile,
  removedIds,
  storedSessionId
}: {
  closingRuntimeId: null | string
  owner: SessionOwnerScope
  profile?: null | string
  /** Every id the delete holds: the stored tip, the row id, the lineage root. */
  removedIds: readonly (null | string | undefined)[]
  storedSessionId: string
}): void {
  dropTranscriptTailEverywhere(storedSessionId)
  forgetSessionUnread(removedIds, profile)
  clearQueuedPrompts(storedSessionId)
  // The journaled in-flight tail holds this session's prompt and tool calls in
  // localStorage; a deleted session must not leave that copy behind to age out
  // on its own. Pass every id the delete holds plus the closing runtime id — the
  // journal keys on the stored id.
  purgeInFlightTurnJournals([...removedIds, closingRuntimeId])
  // Its unsent clarify drafts (this device's copies) go with it; the backend drops its own on delete.
  purgeClarifyDraftsForDeletedSession([...removedIds, closingRuntimeId], owner)

  // Preview tabs are session-owned: drop them with the session (pinned tabs
  // survive — they belong to the workspace, not the session).
  for (const id of removedIds) {
    if (id) {
      prunePreviewTabsForSession(id)
    }
  }
}
