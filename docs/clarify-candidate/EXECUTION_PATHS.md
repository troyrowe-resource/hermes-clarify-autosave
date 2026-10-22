# Clarify draft protection: execution-path inventory

For every route that can raise a batch `clarify` request or show a clarify card: what happens to the
user's unsent text and selections (drafts), how long they last, and what the model is told when the
wait ends without a submit.

Base for every `path:line` citation: commit `4a92978697f386d7124e81d463f3a404ac4403fd` (the first
commit of `candidate/clarify-autosave-windows`; read a file with `git show 4a929786:<path>`). Lines
drift as candidate commits land, so re-read a citation against the commit you are checking.

Status: written by worker S5 on 2026-10-22 while other workers were still changing the candidate. Their
commits and uncommitted edits landed in the shared checkout during the work; S5 did not review or verify
them, and every citation stays pinned to the base. Anything that depends on the candidate's own changes is a
placeholder: search for `LEAD:`. A route is "fixed in candidate" only when a commit and a named passing test
say so. This document does not.

## 0. How to read the evidence

| Tag | Meaning |
|---|---|
| `[code]` | Read at the cited lines at the base commit. Not executed. |
| `[probe]` | Executed by S5 in a scratch directory against a `git archive` of the base commit (Appendix A). Standard library and pydantic only. Not CI evidence and not a test of any candidate change. |
| `[CI]` | Read back from the baseline Actions run [39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224) (commit `4a92978`, job 119695038081, artifact `clarify-windows-39740118224-1`, retained 7 days). That run failed; Appendix B. |
| `[S2]` | Reported by the coordinator as verified by worker S2 on a native run plus code. S5 did not re-run it; the `[CI]`, `[code]` and `[probe]` evidence below is consistent with it. |
| `[inferred]` | A conclusion from code that nobody executed. Said so each time. |

Protection levels:

- **Server**: written to the server's disk by `DraftBook.save` (`tools/clarify_drafts.py:377-394`,
  atomic write at `174-190`), readable with `clarify.drafts`, removable with `clarify.drafts.discard`,
  and reported to the model.
- **Device**: kept only by the Desktop renderer, in memory plus a `localStorage` mirror written on
  every edit (`apps/desktop/src/store/clarify-drafts.ts:106-110`, `319-334`). No timer removes it.
- **None**: Hermes keeps nothing.

## 1. Findings in brief

1. Only two registries can hold a draft on the server, and both are batch registries built on the
   same `DraftBook`: the legacy `tui_gateway` sidecar (`tui_gateway/server_requests.py`) and the
   canonical session owner (`gateway/session_server_requests.py`). A card that is not a batch request
   has no registry, so `clarify.draft` answers `expired` for it.
2. **At base the Desktop's default local route reached neither registry.** The Desktop attaches to the
   canonical owner (`hermes gateway ensure`). The owner sends one batch request only for a turn whose
   submitter declared `clarify_batch: true`; the classic CLI declares it, the unmodified Desktop never
   did. Desktop turns therefore got one card per question, `clarify.draft` answered `expired`,
   protection was **Device**, and the model received no drafts. The native Windows test exercised this
   route, not `hermes serve`. `[S2][CI][code][probe P6, P7]`
3. The legacy sidecar route saves, persists, recalls and reports drafts in process `[probe P4b]`, and
   the owner's batch registry does the same when a turn is flagged `[probe P8]`. Neither had
   native-Windows evidence at base.
4. A compute-host child's request (turn isolation) is unreachable from the parent's draft handler:
   **Device** at base `[code][probe P4]`.
5. No in-tree client both saves drafts and triggers the one purge that exists. The purge hangs off the
   legacy `session.delete` RPC, whose only in-tree caller is the Ink TUI picker (which never saves a
   draft). The Desktop deletes through REST and the canonical `delete` mutation, which never purge
   `[code]`. The Desktop's own comment ("the backend drops its own on delete",
   `apps/desktop/src/app/session/hooks/use-session-actions/deleted-session-local-state.ts:37`) is true
   for the legacy RPC only.
6. Further gaps (lineage ids, profile rename and delete, killed turns, retention, Windows file
   protection, no owner-side replay of an open batch card) are in section 4.

## 2. Route table

(a) unsent-draft protection, (b) server save through `clarify.draft` with on-disk durability,
(c) recall `clarify.drafts` and discard `clarify.drafts.discard`, (d) what the model is told when the
wait times out. Detail and citations per route are in section 3.

| ID | Route (client, backend, card shape) | (a) Protection at base | (b) Server save | (c) Recall / discard | (d) Model told at timeout | After candidate |
|---|---|---|---|---|---|---|
| R1 | Desktop, canonical local gateway (`gateway ensure`, WebSocket `native_dial`), unmodified Desktop: one card per question | **Device** | No: `clarify.draft` answers `expired` | Refused: the card's 10-hex id is not an `srq-` id, so both verbs answer `invalid_params` `[probe P6b]`; the card shows "Could not read the drafts saved on the server"; a discard still removes the Desktop's own copy | `timed_out`, `notice: "[user did not respond within Nm]"`, every response `unanswered`, no `drafts` | <!-- LEAD: post-fix verified state of R1 (commit, test, run) --> Pending |
| R2 | Same owner, turn flagged `clarify_batch: true` (classic CLI at base; the Desktop once the candidate's change lands): one batch request, `session_owner` store | CLI: **None** (it never sends drafts). Desktop: **Server** plus Device once it declares the flag | Yes `[probe P8]`: `ok`, `durable: true` | Yes, for an attached `session:respond` viewer | `timed_out` plus `drafts`, `drafts_submitted: false`, `drafts_notice`, `drafts_request_id`, `drafts_durable`; no `notice` | <!-- LEAD: post-fix verified state of R2 --> Pending |
| R3 | Desktop on a legacy transport (no `native_dial`), `tui_gateway` sidecar in process: one batch request, `tui_gateway` store | **Server** plus Device (the Desktop only; the Ink TUI on the same sidecar is R5) | Yes `[probe P4b]` | Yes (by request id, or the session's list) | As R2 | None planned |
| R4 | R3 with `dashboard.turn_isolation: true` (default `false`): the compute-host child owns the request | **Device** | No: the parent answers `expired` `[probe P4]` | Recall finds nothing; discard answers `missing` | `timed_out`, no `drafts`, no `notice` `[probe P4]` | <!-- LEAD: post-fix verified state of the compute-host relay (commit, test) --> Pending |
| R5 | Ink TUI (`hermes --tui`): batch (sidecar) or per-question (shared gateway) | **None** | No: no client code | Not offered | Sidecar: `timed_out`, locked answers only. Shared gateway: as R1 | None planned |
| R6 | Dashboard `/chat` (embeds the Ink TUI in a PTY; `web/src` has no clarify code) | **None** | No | Not offered | As R5 | None planned |
| R7 | Classic CLI: in-process panel, or a viewer of the owner | **None** | In-process: no. Viewer: the owner opens a draft book that the CLI never calls | Not offered | `timed_out`, locked answers only | None planned |
| R8 | Other per-question viewers of the owner: ACP editors, raw WebSocket clients, `api_server` runs, managed-worker executions | **None** (the Desktop is the only client with a draft store) | No: not an `srq-` id, so `expired` | Not offered | As R1 | None planned |
| R9 | Messaging platforms (Telegram, Discord, Slack, WhatsApp, Google Chat, Photon and others): one card or numbered list per question | Not applicable: a tap or a typed reply is the answer; unsent text stays in the platform's composer | No | Not offered | As R1 | Not applicable |
| R10 | Desktop, older backend with no `clarify.draft` | **Device** ("Server autosave unavailable: draft kept on this device only") | No: `-32601` | "This server cannot recall saved drafts" | As that backend's route | None planned |
| R11 | Headless (`chat -q`, oneshot), hosted rooms, forwarded A2A peers: no card is shown | Not applicable | No | Not offered | Answered or declined at once: `undelivered` | Not applicable |

## 3. Route notes

### R1. Desktop on the canonical local gateway (one card per question)

How the Desktop gets there `[code]`

- The primary backend start runs `hermes gateway ensure --json` (`apps/desktop/electron/main.ts:12046`,
  `ensureLocalGateway(...)` at `12115`); a pooled local profile does the same (`main.ts:11638`). The
  descriptor's WebSocket URL carries `native_dial` (`apps/desktop/electron/local-gateway.ts:251`) and the
  client is canonical exactly when it does (`apps/desktop/src/api/client.ts:332`).
- `HERMES_DESKTOP_ISOLATED_BACKEND=1`, which the E2E fixture sets (`apps/desktop/e2e/fixtures.ts:213`),
  gives the app its own gateway for the sandbox home. It does not switch to `hermes serve`. The comments
  that say "isolated `hermes serve`" (`apps/desktop/e2e/clarify-drafts-native.spec.ts:4`,
  `apps/desktop/e2e/fixtures.ts:8`) are stale `[S2][code]`.

How the owner chooses batch or per-question `[code]`

- `agent.clarify_callback` is `TurnRunner._clarify_callback_sync` (`gateway/run_turn_runner.py:475`).
  Order: headless (`_finite_viewer_turn`, `545-549`), then batch only when `clarify_batch_turn(self)`
  (`551-554`), otherwise a loop that asks one question at a time (`562-577`).
- `clarify_batch_turn` needs a local-viewer turn whose submitter committed `clarify_batch` with its
  admission (`gateway/session_cli_turn.py:54-61`, `160-167`). The only in-tree sender at base is the
  classic CLI (`hermes_cli/gateway_agent.py:686-688`). Nothing under `apps/` or `ui-tui/` sets it
  (`git grep clarify_batch 4a929786 -- apps ui-tui` finds only the generated contract files and a test
  comment).
- Each per-question card is a `clarify.request` event (`gateway/session_pending_controls.py:40-51`) with
  a 10-hex `clarify_id` (`gateway/run_turn_runner.py:592`), answered with `clarify.respond`. The Desktop
  turns the event into a one-question request with `qid = prompt_id`
  (`apps/desktop/src/api/canonical-protocol.ts:23-34`, `apps/desktop/src/api/client.ts:126-176`) and
  sends its Confirm as `clarify.lock` rewritten to `clarify.respond` (`client.ts:401-407`).

What happens to a draft `[code][probe P6, P6b]`

- The card still saves to the device on every edit (`clarify-drafts.ts:412-460`; status `device-only`
  by default, line `448`) and, after 600 ms (`:90`), calls `clarify.draft` (`sendDraft`, `:501-576`).
- The owner looks the id up in `session_server_requests._open`, which only holds `srq-` requests
  (`gateway/session_server_requests.py:147-152`, `190-200`). A per-question id is not there, so
  `clarify_draft` returns `{'status': 'expired'}` (`gateway/session_clarify_draft.py:51-65`). Probe P6 ran
  the real handler with a 10-hex id and with an unknown `srq-` id: both `expired`.
- The Desktop reads `expired` as "the request ended": it stops sending for that request and shows
  `device-only` (`clarify-drafts.ts:558-562`), "Draft kept on this device only"
  (`apps/desktop/src/i18n/en_clarify.ts:21`).
- Recall and discard are refused, not empty. Both verbs accept only `srq-<12 hex>` ids
  (`tools/clarify_drafts.py:46`, `126-127`; `gateway/session_clarify_draft.py:72-73`, `83-84`), and a
  per-question card's id is 10 hex, so each answers `invalid_params` `[probe P6b]`; a session-wide listing
  with no request id works and is empty. The Desktop maps the refusal to "Could not read the drafts saved on
  the server" (`clarify-drafts.ts:824-832`; `en_clarify.ts:42`; `isMissingRpcMethod` matches a missing-method
  error, not `invalid_params`, `apps/desktop/src/lib/gateway-rpc.ts:7-17`), and a discard reports that the server copy "could
  not be removed" (`clarify-drafts.ts:709-720`; `en_clarify.ts:65`) while still removing its own copy
  (`:697-698`). There was no server copy to remove.

What the model is told `[code][probe P7]`

- The loop stops at the first unanswered question: `outcome: "timed_out"`,
  `notice: "[user did not respond within {int(timeout / 60)}m]"` (`gateway/run_turn_runner.py:574`,
  `gateway/run_turn_runner_clarify_delivery.py:116`). `tools/clarify_tool.py:95-121` renders every
  question as `unanswered` with `user_response: null`, plus the notice, and no `drafts` key. With the
  E2E's 25 s timeout the notice reads "0m" because `int(25 / 60)` is 0.

Native evidence `[CI][S2]`

- Baseline run, settled card after the real 25 s timeout (page snapshot in the failure artifact): both
  questions "No answer", then "Unsubmitted drafts", "The assistant has not seen these drafts.", and the
  row "Pick a batch drink?" / "Tea" / "Server disk save not confirmed" (`en_clarify.ts:25`, `31`). The mock
  inference server logged its second chat completion 25.2 s after the first (07:29:07.98 and 07:29:33.17
  UTC), which is consistent with the wait expiring and the turn continuing.
- The same run failed at `card.getByPlaceholder(/Other/).nth(1).fill(...)`
  (`apps/desktop/e2e/clarify-drafts-native.spec.ts:56`), which is consistent with only the first question's
  card having existed.

Reconnect `[code]`: the attach snapshot re-delivers pending per-question prompts
(`gateway/session_authority.py:344`; `client.ts:493-511`), so an open card survives a reconnect and its
staged picks come back from the device copy (`.../clarify/pending-drafts.tsx:67-104`).

After the candidate's change: <!-- LEAD: post-fix verified state of R1: which prompt.submit senders declare clarify_batch, the test names, the run URL --> pending.

### R2. Canonical owner, batch request (`clarify_batch: true`)

- Mechanism `[code]`: `ask_clarify_batch` (`gateway/session_clarify_batch.py:16-50`) calls
  `ask_viewer_result(..., qids, draft_scope=owner_draft_scope(...))` (`:30-33`), which runs `_ask`
  (`gateway/session_server_requests.py:190-235`). The request is one JSON-RPC frame, method `clarify`, id
  `srq-<12 hex>`, written once with `events.fanout.write` (`:199-200`) to the viewers attached at that
  moment. At timeout it settles with `settle_batch(..., ended="timed_out")` (`:210-216`) and then
  `_settle_drafts` (`:183-187`).
- Handlers `[code]`: `clarify.draft`, `clarify.drafts`, `clarify.drafts.discard`
  (`gateway/session_clarify_draft.py:51-97`), mounted at `gateway/session_controls.py:228-230`, allowed
  while the owner drains for a restart (`gateway/drain_control.py:72-74`), declared in
  `tui_gateway/contracts/canonical.py:384-391`. Each needs the caller to be an attached viewer holding
  `session:respond` (`session_server_requests.py:57-75`).
- Probe P8 ran this registry with a stub event stream. `clarify.draft` answered `ok` with
  `durable: true`; at timeout the result carried `drafts`, `drafts_request_id` and `drafts_durable: true`;
  the model view added `drafts_submitted: false` and `drafts_notice`; the record on disk ended with
  `outcome: "timed_out"`.
- Who uses it `[code]`: the classic CLI viewer declares the flag but never calls `clarify.draft` (no
  reference under `hermes_cli/`), so its drafts are None. The Desktop did not declare it at base.
- Base tests on Windows `[CI]`: `tests/gateway/test_clarify_drafts_owner.py` 7 passed. The owner's only
  end-to-end test, `tests/gateway/test_clarify_lock_owner.py::test_cli_turn_batch_answered_by_clarify_lock_from_a_second_viewer_end_to_end`,
  failed at line `130`: its subprocess died on `import asyncio` with `OSError: [WinError 10106]`.
- No owner-side replay of an open batch card `[code]`, with the consequence `[inferred]`. The frame is
  written straight to the fan-out, not through `publish`, so it is not stamped for replay
  (`gateway/session_events.py:38-64`), and the attach snapshot lists only `PendingControls` prompts
  (`gateway/session_authority.py:344`). `tui_gateway` has `open_requests` for this
  (`tui_gateway/server_requests.py:102-110`, `421-425`); the owner has no counterpart. A viewer that
  reconnects or restarts while a batch card is open is not shown the card again, and its server-held
  drafts are not replayed. They remain recallable once the request settles.
- After the candidate's change (Desktop declares the flag): <!-- LEAD: post-fix verified state of R2 (native test, run URL) --> pending.

### R3. Legacy `tui_gateway` sidecar, in process

- Reached by `[code]`: a Desktop dial without `native_dial` (`client.ts:332`; the canonical adapter's own
  header says "Remote legacy transports keep their existing protocol",
  `apps/desktop/src/api/canonical-protocol.ts:1-2`), the Ink TUI over stdio, and `hermes serve`. Which of
  these a given deployment uses is a deployment fact the source cannot answer.
- Mechanism `[code]`: `tui_gateway/agent_callbacks.py:168` calls `server._clarify_block`
  (`tui_gateway/server.py:1112-1121`), which calls `server_requests.send(..., qids=...,
  draft_scope=_clarify_draft_scope(sid))`. The scope is the session's profile home, gateway kind
  `tui_gateway` and stored `session_key` (`tui_gateway/methods_prompt.py:1297-1305`). Handlers:
  `methods_prompt.py:1337-1383`.
- Reconnect `[code]`: unlike the owner, an open request and its drafts replay
  (`tui_gateway/server_requests.py:102-110`, `421-425`; the Desktop reads them in
  `.../gateway-event/server-requests.ts:343-365`).
- Probe P4b: `clarify.draft` answered `ok` with `durable: true`; at timeout the result carried the draft
  block; the record on disk ended with `outcome: "timed_out"`, revision 7.
- Base tests on Windows `[CI]`: `tests/tui_gateway/test_clarify_drafts.py` 9 passed, 1 failed at line
  `254` (the POSIX `0o600` assertion; section 4.6).

### R4. Sidecar with turn isolation (compute-host child)

Pre-fix state, precisely `[code][probe P4]`:

- The path exists only when `dashboard.turn_isolation` is true (default `false`,
  `hermes_cli/config_defaults.py:1020`; gate at `tui_gateway/compute_host_bridge.py:23-34`), on the legacy
  `tui_gateway` transport. The canonical owner does not use the compute host
  (`git grep compute_host 4a929786 -- gateway` finds one comment).
- The child builds its own `tui_gateway.server` and session record (`tui_gateway/compute_host.py:341-426`;
  `HERMES_COMPUTE_HOST_CHILD=1` at `:553`), so the clarify request is created in the child's registry. The
  parent only mirrors the open request (`compute_host_bridge.py:147-153`).
- `clarify.lock` is proxied to the child (`tui_gateway/methods_prompt.py:1276`;
  `compute_host_bridge.py:219-247`; child side `compute_host.py:203-226`). `clarify.draft` is not: the
  handler calls `server_requests.save_draft` on the parent's registry (`methods_prompt.py:1348-1349`),
  which has no such request and returns `None`, and the handler answers `{"status": "expired"}`
  (`methods_prompt.py:1353`). The child's `_handle_respond` knows only lock, cancel and response frames
  (`compute_host.py:203-226`).
- Result: the child's draft book never receives a save, so at timeout its result carries no drafts and the
  model is told only `outcome: "timed_out"` (probe P4: parent `save_draft` returned `None`, child result
  `{answers: {}, outcome: "timed_out"}`, no record on disk). The Desktop marks the request `serverClosed`
  and shows "Draft kept on this device only" with "The assistant has not seen these drafts."
  (`clarify-drafts.ts:558-562`; `en_clarify.ts:21`, `25`).
- No test at base mentions drafts and the compute host (`tests/tui_gateway/test_compute_host*.py`).
- After the candidate's relay: <!-- LEAD: post-fix state of the compute-host relay: commit, test file, what the child persists and which scope it uses --> pending.

### R5. Ink TUI and R6. dashboard `/chat`

- `ui-tui/` never calls `clarify.draft`, `clarify.drafts` or `clarify.drafts.discard` (`git grep
  clarify.draft 4a929786 -- ui-tui` finds nothing); the only clarify-related "draft" is a cursor restore
  for revisiting a *locked* answer (`ui-tui/src/lib/text.ts:384-390`). `web/src` has no clarify code at
  all; the dashboard embeds the real TUI in a PTY (`web/AGENTS.md`).
- Batch card on the sidecar: each Enter locks an answer through `clarify.lock`
  (`ui-tui/src/app/useMainApp.ts:874-925`), so a locked answer survives a timeout. Typed or picked but
  not yet locked text is lost on Esc or timeout: the overlay is flushed to a system line with locked
  answers only (`useMainApp.ts:841-872`, `ui-tui/src/app/createGatewayEventHandler.ts:737-749`).
- On the shared gateway the Ink card is per-question and answers with `clarify.respond`
  (`useMainApp.ts:857`, `897`): as R1 without a device copy.

### R7. Classic CLI

- In-process, the panel returns `{"answers": <locked so far>, "outcome": "timed_out"}` at the deadline
  (`hermes_cli/cli_modal_mixin.py:992-1028`); nothing is kept.
- As a viewer of the owner it declares `clarify_batch` (`hermes_cli/gateway_agent.py:686-688`) and answers
  the batch through `_ask_clarify` (`:1169-1176`); the owner opens a draft book that this client never
  calls.

### R8. Other per-question viewers of the owner

ACP editors answer through `clarify.respond` (`acp_adapter/gateway_server.py:1100-1128`); `api_server` runs
answer through `respond_run` (`gateway/platforms/api_server_authority_runs.py:100-110`, `113`); raw
WebSocket clients get the `clarify.request` event. Managed-worker executions (kanban cards, `--safe-mode` or
`--ignore-user-config` sessions, or the opt-in `gateway.managed_workers`) ask per question regardless of
the flag (`agent/managed_worker.py:229-249`; the owner registers each as a per-question card,
`gateway/session_managed_worker.py:46-48`, `389-391`). None keeps a draft; the owner's `clarify.draft`
answers `expired` for all of them `[code]`.

### R9. Messaging platforms

One card per question (`gateway/run_turn_runner.py:562-577`), native buttons or a numbered list
(`gateway/platforms/base.py:2890-2917`; adapters such as `plugins/platforms/telegram/adapter.py:4285`). A
tap resolves the question at once and a typed reply is the answer (`tools/clarify_gateway.py:103-111`,
`233-248`), so there is no staged server-side state to keep. At timeout the model is told
`[user did not respond within Nm]` (`gateway/run_turn_runner_clarify_delivery.py:116`). Not applicable.

### R10. Desktop, older backend

A backend without `clarify.draft` answers `-32601`; the Desktop records the owner as unsupported and shows
"Server autosave unavailable: draft kept on this device only" (`clarify-drafts.ts:565-571`;
`en_clarify.ts:22`). Recall and discard say so (`clarify-drafts.ts:825-831`, `705-707`).

### R11. No card

`chat -q` / `-z` turns are answered headless at once (`gateway/run_turn_runner.py:545-549`); oneshot says
"no user available" (`hermes_cli/oneshot.py:661-665`); hosted rooms and forwarded A2A peers are declined
(`gateway/session_local.py:87-114`).

### 3.1 Per-question card routes: exactly which stay device-only and which are unprotected

A per-question card has no server draft registry, so none of these routes can reach the server channel. The
list is the same after the candidate's Desktop change: only a batch request moves a route out of it.

| Route | Protection | Why | Evidence |
|---|---|---|---|
| Desktop turn from a sender that does not ask for a batch (at base every sender; after the change, any sender in section 6 that still omits the flag) | **Device** | The card is a Desktop card, so it saves to the device; the owner answers `expired` | R1 `[code][probe P6]` |
| Desktop against an owner that refuses the `clarify_batch` key (an owner older than the key) | **Device** | The owner sends per-question cards | `[inferred]` |
| Desktop against a backend with no `clarify.draft` | **Device** | `-32601`; the owner is remembered as unsupported | `clarify-drafts.ts:565-571`; `en_clarify.ts:22` `[code]` |
| Desktop attached to a managed-worker execution (kanban card, `--safe-mode`, `--ignore-user-config`, or the opt-in `gateway.managed_workers`) | **Device** | The worker asks per question whatever the flag says | `agent/managed_worker.py:229-249`; `gateway/session_managed_worker.py:46-48`, `389-391` `[code]` |
| Desktop card whose owner cannot be proven | **None** | No complete scope, so nothing is stored or sent; the card says "Not saved: this form could not confirm which conversation owns it" | `clarify-drafts.ts:197-206`; `.../clarify/pending-drafts.tsx:165-175`; `en_clarify.ts:35-36` `[code]` |
| ACP editors | **None** | The editor shows its own prompt and answers with `clarify.respond` | `acp_adapter/gateway_server.py:1100-1128` `[code]` |
| Raw WebSocket and other canonical clients | **None** from Hermes | They get the `clarify.request` event; `clarify.draft` for such an id answers `expired`, recall and discard `invalid_params` | `[probe P6, P6b]` |
| `api_server` runs | **None** | Answered through `respond_run` | `gateway/platforms/api_server_authority_runs.py:100-110`, `113` `[code]` |
| Ink TUI on the shared gateway | **None** | No draft code; answers with `clarify.respond` | `ui-tui/src/app/useMainApp.ts:857`, `897` `[code]` |
| Messaging platforms | Not applicable | A tap or a typed reply is the answer; no staged state exists | R9 |

## 4. Lifecycle gaps

### 4.1 Session deletion: which routes purge server drafts

`purge_session` (`tools/clarify_drafts.py:319-337`) has exactly one production caller,
`_delete_with_clarify_drafts` (`tui_gateway/methods_prompt.py:1308-1318`), used by the legacy
`session.delete` RPC (`tui_gateway/methods_session.py:1172-1197`, call at `1191-1192`). Covered by
`tests/tui_gateway/test_clarify_drafts_session_delete.py` `[code]`.

| Route | Purges server drafts? | Evidence `[code]` |
|---|---|---|
| `session.delete` RPC (legacy) | Yes, the target id only, both gateway kinds | `methods_session.py:1191-1192` |
| Its only in-tree caller: the Ink TUI picker, non-canonical mode | n/a: Ink saves no drafts; canonical mode uses `session.mutate delete` (no purge) | `ui-tui/src/hooks/useSessionDelete.ts:38-60` |
| Desktop delete (REST `DELETE /api/sessions/{id}`, then the canonical `delete` mutation) | **No** | `apps/desktop/src/api/sessions.ts:715-717`; `hermes_cli/web_routers/sessions.py:847-871`; `gateway/session_mutations.py` handles `delete` at `212`, `269`, `360` and never mentions clarify, drafts or a purge |
| Dashboard bulk delete, delete empty, prune | **No** | `hermes_cli/web_routers/sessions.py:486`, `534`, `116` |
| Owner `session.prune` | **No** | `gateway/session_prune.py:57` |
| CLI `hermes sessions delete`, `prune`, export with delete, browse | **No** | `hermes_cli/sessions_cmd.py:612`, `643`, `818`; `hermes_cli/sessions_cmd_browse.py:263` |
| CLI `/exit --delete` | **No** | `hermes_cli/cli_tui_runtime_mixin.py:558` |
| Automatic prune (`sessions.auto_prune`, default `false`) | **No** | `hermes_state_maintenance.py:478-579`; `hermes_cli/config_defaults.py:2287` |
| Onboarding chat delete | **No** | `tui_gateway/methods_onboarding.py:264` |
| Profile delete | Yes, incidentally: the whole home is removed | `hermes_cli/profiles.py:1844` |

The Desktop removes its own device copies after a successful delete, on two paths
(`apps/desktop/src/app/session/hooks/use-session-actions/index.ts:3195-3197`,
`apps/desktop/src/app/settings/sessions-settings.tsx:115-127`, both through
`purgeClarifyDraftsForDeletedSession`, `clarify-drafts.ts:891-922`). Deleting through the dashboard, the
CLI or a prune leaves device copies too.

One seam covers every `SessionDB` deletion `[code]`: `emit_session_deleted`
(`hermes_state_common.py:411`) runs after each committed delete and prune
(`hermes_state_sessions.py:1783`, `1845`, `1934`, `1979`; `hermes_state_maintenance.py:135`, `403`),
derives the profile home from the store's own path (`:430`), which is the home `DraftScope` uses, and also
fires for `reason="archive"` (`hermes_state_sessions.py:964`), which must not purge. It is not wired to
drafts at base. Not covered even by that seam: the `api_server` raw delete
(`gateway/platforms/api_server.py:3125`) and a whole-profile removal.

### 4.2 Lineage and compression

- `purge_session` matches one exact stored id (`tools/clarify_drafts.py:130-132`, `319-337`) `[probe P1]`.
  `delete_session` removes the whole local lineage (`hermes_state_sessions.py:1753-1754`), but the wired
  purge receives only the target id (`methods_session.py:1191-1192`): drafts saved under an older segment
  stay on disk.
- In the sidecar the draft scope follows `session["session_key"]`, which compression rotates
  (`tui_gateway/session_compression.py:331`). A draft saved before the rotation is not listed by
  `clarify.drafts` afterwards, because the scope digest differs `[code]`. Compression does not run while a
  clarify wait is open `[inferred]`.
- The owner keys its scope by the session id it holds (`gateway/session_clarify_draft.py:30-33`). Its
  behaviour across an owner-side compress or reset was not examined.

### 4.3 Profile rename, move, delete, clone, export

- **Rename, server copies move with the directory** `[code][probe P2]`: `rename_profile` renames the home
  (`hermes_cli/profiles.py:2379`); a draft's path (`clarify_drafts/<gateway>/<digest>/<request>.json`) and
  record hold neither the profile name nor an absolute path (`tools/clarify_drafts.py:130-132`, `249-274`).
  After the probe renamed the home, the record was still found.
- **Rename, device copies are stranded** `[code]`: the device key is
  `hermes.clarifyDrafts.v2/<gateway>/<profile name>/<session>/<request>` (`clarify-drafts.ts:89`,
  `123-124`) and every read re-checks the profile (`:224-228`). `migrateTilesForProfile`
  (`apps/desktop/src/store/session-states.ts:2848-2903`) migrates tiles, transcript tails, remembered
  navigation, owner hints, preview artifacts, status drawers and preview tabs, not drafts, and runs only
  for a local rename (`apps/desktop/src/app/profiles/rename-profile-dialog.tsx:104`). The old entries stay
  in `localStorage` unread and never expire (`savedAt` is written at `clarify-drafts.ts:447` and never
  used to expire anything). A renamed profile can still recall the server copy.
- **Move** (a home relocated as a whole): the server copies follow it for the same reason as rename
  `[inferred]`. Device keys hold a gateway id and a profile name, not a path.
- **Delete**: the server tree is removed (`hermes_cli/profiles.py:1844`). Device copies are not:
  `dropTilesForProfile` (`session-states.ts:2738-2838`, called at
  `apps/desktop/src/app/profiles/delete-profile-dialog.tsx:77`) does not touch the draft key family
  (`clarify-drafts.ts` is the only file that names it).
- **Clone and export**: `clarify_drafts/` is not in `_CLONE_ALL_HISTORY_EXCLUDE_ROOT`
  (`hermes_cli/profiles.py:86-89`), so `--clone-all` copies the source's unsent text into the clone
  without its `state.db`. A named-profile export excludes only credential stores and runtime directories
  (`profiles.py:2235-2242`; `profile_path_is_private` at `:200-205`), so the archive carries drafts; the
  default-profile export is an allow-list that does not name them (`profiles.py:258`).

### 4.4 A crashed or killed turn

Probe P3: a process killed after a successful save (`durable: true`) left the record on disk with
`outcome: null`, because nothing settled it. The store has no sweep. The Desktop only mounts its drafts
panel from a settled clarify result that has a `responses` array
(`apps/desktop/src/components/assistant-ui/clarify/settled.tsx:16-26`, `parse.ts:95-129`), and a clarify row
with no open request and no result renders as a plain tool row (`clarify/index.tsx:67`). The recall button
lives in that panel (`settled-drafts.tsx:136-172`), so a killed turn leaves a durable record that no
screen offers to recall `[code][inferred]`. The model is never told: its turn ended. At base, a test
asserts that a record survives a lost registry with `outcome is None`
(`tests/tui_gateway/test_clarify_drafts.py:232-254`).

### 4.5 Retention

No timer, and no cap on the number of files. A request's file stays until it is discarded, every draft in
it is superseded by a lock or skip or is blank (`tools/clarify_drafts.py:255-261`), its session is deleted
through a wired route (4.1), or the profile is removed (`:14-19`). Listing returns the newest 50 per
session (`:44`, `303`); older files stay. Each draft is at most 16 384 characters (`:40`) and a call has at
most 5 questions (`tools/clarify_tool.py:9`). Device copies have no expiry either.

### 4.6 Windows specifics

- **POSIX permissions are not enforced** `[CI][code]`. The store asks for directory mode `0o700` and file
  mode `0o600` (`tools/clarify_drafts.py:175`, `182`; the module docstring says `0600`, line `15`). On
  Windows the baseline run read `st_mode` 33206 (`0o100666`), and
  `tests/tui_gateway/test_clarify_drafts.py:254` failed. The assertions before it (recall of the record
  after a lost registry, with `outcome is None`) passed. The discard assertions after it (lines `255-257`)
  did not run. On NTFS the protection is the parent directory's ACL.
- **The directory is not fsynced** `[code]`: `_fsync_dir` returns immediately on Windows
  (`tools/clarify_drafts.py:164-171`), although the module docstring says "file and directory fsynced"
  (line `15`). The file content is fsynced and `os.replace` is atomic for a killed process; a power loss
  can still lose the rename `[inferred]`.
- **`mkdir(mode=0o700)` hazard** `[inferred]`: on CPython 3.13 and later it applies a protected ACL, which
  strands a directory an elevated process created from the same user unelevated, and is why Hermes routes
  state directories through `make_user_dir` (`hermes_dir_acl.py:1-14`). The draft store uses a plain
  `mkdir(mode=0o700)` (`tools/clarify_drafts.py:175`). The failure would surface as `durable: false`
  (truthful), and recall would list nothing. Not reproduced.
- **A harness failure, not product logic** `[CI]`: `test_clarify_lock_owner.py` spawns a subprocess with a
  scrubbed environment and Windows could not start Winsock (`WinError 10106`). The usual cause is a missing
  `SYSTEMROOT`; that cause is `[inferred]`.

### 4.7 Other observations

- **A closing frame can carry its own `drafts*` keys** `[code][probe P5]`: `settle_batch` copies every key
  of a client's closing frame (`tools/clarify_batch.py:27-30`) and `DraftBook.settle` returns `{}` when it
  holds nothing, so a client-supplied `drafts` and `drafts_durable: true` reach the model view for a draft
  the server never held (no record on disk). The client is the authenticated user and the Desktop never
  sends such keys, so this is about the truthfulness of `drafts_durable`, not a boundary crossing.
- **The tool schema does not mention drafts** (`tools/clarify_tool.py:149-171`); the model learns about them
  from `drafts_notice` in the result.
- **Recall needs an attached session** `[inferred]`: the owner refuses `clarify.drafts` and
  `clarify.drafts.discard` unless the caller is attached with `session:respond`
  (`gateway/session_server_requests.py:65-75`), and the Desktop's attach-first list does not include them
  (`apps/desktop/src/api/client.ts:46-57`).

## 5. Gap register

Disposition is `fixed in candidate`, `disclosed limitation` or `not applicable`; `Open` means undetermined
until the lead fills the last column. The values below are what S5 can support today. Change a row to
`fixed in candidate` only with a commit and a passing test name.

| ID | Gap | State at base | Disposition now | Lead fills |
|---|---|---|---|---|
| G1 | Desktop default route gets per-question cards: no server drafts (R1) | Device only; model told nothing | Open | <!-- LEAD: disposition, commit, test, run URL. The checkout held a Desktop opt-in with a refusal ladder (`apps/desktop/src/store/clarify-batch.ts`, `.../use-prompt-actions/submit.ts`); list which senders in section 6 it covers --> |
| G2 | Per-question routes that stay unprotected after G1: a Desktop sender that omits the flag, an owner that refuses it, older backends, managed workers, ACP, raw WebSocket, `api_server`, Ink (sections 3.1 and 6) | Device or None | Disclosed limitation | <!-- LEAD: confirm the list --> |
| G3 | Compute-host child-owned requests (R4) | Device only | Open | <!-- LEAD: disposition, commit, test. The checkout held a relay (`tui_gateway/compute_host_bridge.py`, `compute_host.py`, `host_supervisor.py`) and tests (`tests/tui_gateway/test_compute_host_clarify_drafts*.py`); validate them before filling --> |
| G4 | Deletion routes that do not purge server drafts (4.1) | Only the legacy RPC purges | Disclosed limitation unless the central seam is used | <!-- LEAD: disposition --> |
| G5 | Older lineage segments and compression rotation (4.2) | Exact id only | Disclosed limitation | <!-- LEAD --> |
| G6 | Profile rename strands device copies; delete leaves them; clone and export copy drafts (4.3) | As described | Disclosed limitation | <!-- LEAD --> |
| G7 | Killed turn: durable record, no terminal result, no recall entry point (4.4) | As described | Disclosed limitation | <!-- LEAD --> |
| G8 | No retention timer and no cap (4.5) | As described | Disclosed limitation | <!-- LEAD --> |
| G9 | Windows file protection and directory durability (4.6) | POSIX modes not enforced; no directory fsync | Open | <!-- LEAD: commit 91e73cdf changes the store (`make_user_dir`, `atomic_replace`, a deleted-profile guard), moves the `0600` assertion to `tests/tools/test_clarify_drafts_privacy.py` and passes `SYSTEMROOT` to the lock-owner child. Directory fsync on Windows is still skipped. Set the disposition from a Windows run --> |
| G10 | No owner-side replay of an open batch card (R2) | Card and drafts not re-shown after reconnect or restart | Open | <!-- LEAD: the checkout held an uncommitted owner snapshot (`gateway/session_server_requests.py` `snapshot_fields`, `tests/gateway/test_clarify_open_request_snapshot.py`); set the disposition from what is committed and tested --> |
| G11 | A closing frame can claim `drafts_durable` (4.7) | As described | Observation | <!-- LEAD: disposition --> |
| G12 | Messaging platforms, headless, hosted rooms, A2A (R9, R11) | No staged state | Not applicable | |

## 6. What to check when verifying the post-fix state

These are things a verification should cover, not claims that they hold.

- **Every Desktop sender of a prompt-submit shaped request**, because the flag is per admission
  (`gateway/session_cli_turn.py:74-80`) and a turn without it gets per-question cards. At base:
  `app/session/hooks/use-prompt-actions/submit.ts:1159` and `:1175` (composer), `.../rewind.ts:348` (edit,
  regenerate, restore), `app/contrib/hooks/use-session-tile-delegate.ts:584`,
  `app/session/hooks/use-session-actions/index.ts:930`, `app/chat/composer/discard-lost-prompt.ts:44` and
  `:61` (`prompt.steer_queued`, `prompt.replace_queued`), and Bot Mode
  (`plugins/hermes-bots/canonical-chat.ts:566`, `.../group-turns.ts:583`, `:606`), all under
  `apps/desktop/src/`.
- An owner that refuses the key (`invalid_params`) or predates it: the card must say what it keeps.
- The reconnect and restart cases on the owner route (G10): the card and its drafts are not replayed.
- Recall on a session that is not attached (4.7).
- Compute-host: where the child's file lands (the same `tui_gateway` scope the parent reads), that the
  parent's recall and discard see it, and that settle writes the outcome from the child.
- That saving or recalling never submits and never grants approval: `clarify.lock` and `clarify.respond`
  stay the only submitting calls, and Confirm stays the only control that sends them
  (`apps/desktop/src/components/assistant-ui/clarify/pending.tsx:189-253`).

## Appendix A. Probes

Run by S5 against a `git archive` of `4a929786` unpacked in a scratch directory (not the working tree), with
`TMPDIR` pointing at scratch and `HERMES_HOME` pointing at a temporary directory the script removes. Python
3.13 with pydantic; no installs. Re-run it against any commit with
`python3 probe_execution_paths.py <tree root>`; the imports it needs are `tools`, `tui_gateway.server_requests`
and `gateway.session_server_requests`, none of which needs the full dependency set.

Recorded at `4a929786`:

| Probe | Result |
|---|---|
| P1 | `purge_session(home, "stored-B")` removed 1 file; A's record stayed (1), B's was gone (0) |
| P2 | After `os.rename` of the home, 1 record still found under the new path |
| P3 | A process ending with `os._exit(9)` after `save` returned `{'status': 'ok', 'revision': 5, 'durable': True}`: record on disk, `outcome: null` |
| P4 | Two registries standing in for parent and child: the parent's `save_draft` returned `None`; the child's result was `{answers: {}, outcome: "timed_out"}`; model view `outcome: timed_out`, no `drafts`; 0 records on disk |
| P4b | Same registry: `ok`, `durable: true`; result keys `answers, drafts, drafts_durable, drafts_request_id, outcome`; record `("timed_out", 7)` |
| P5 | A closing frame with `drafts` and `drafts_durable: true`: the model view carried both; 0 server records |
| P6 | Real owner `clarify_draft` handler: `{'status': 'expired'}` for `0123456789` and for `srq-0123456789ab` |
| P6b | Real owner handlers, entitlement stubbed: `clarify.drafts` and `clarify.drafts.discard` with `0123456789` raised `RuntimeStoreError('invalid_params')`; with `srq-0123456789ab` they answered `{'drafts': []}` and `{'status': 'missing'}`; `clarify.drafts` with no request id answered `{'drafts': []}` |
| P7 | Model view for a per-question timeout: `outcome: timed_out`, `notice: "[user did not respond within 0m]"`, both responses `unanswered`, no `drafts` |
| P8 | Owner batch registry: frame method `clarify`, id prefix `srq-`; `ok`, `durable: true`; result carried the draft block; record `("timed_out", 9)` |

<details>
<summary>The probe script</summary>

```python
"""Execution-path probes for the clarify draft inventory (stdlib + pydantic only; no repository writes).

Usage: python3 probe_execution_paths.py <source tree root>

The source tree is imported read-only (a `git archive` of the commit under test is ideal); every
file the probes write lives under a fresh temporary directory that is removed at the end.
"""
import asyncio
import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

SRC = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(SRC))
TMP = Path(tempfile.mkdtemp(prefix="clarify-probe-"))
os.environ["HERMES_HOME"] = str(TMP / "hermes-home")
out = {}

from tools import clarify_drafts as store  # noqa: E402
from tools.clarify_tool import _normalize_questions, _result  # noqa: E402

QUESTIONS = [{"question": "Pick a drink?", "choices": ["Coffee", "Tea"]},
             {"question": "Pick a time?", "choices": ["Morning", "Evening"], "multi_select": True}]
NORMALIZED, _ = _normalize_questions(QUESTIONS)
WIRE = [{"qid": e["qid"], "question": e["question"], "choices": e["choices"],
         "multi_select": bool(e["multi_select"])} for e in NORMALIZED]
QIDS = [e["qid"] for e in NORMALIZED]


def model_view(reply):
    result = json.loads(_result(NORMALIZED, reply))
    return {key: result[key] for key in result if key != "responses"} | {
        "statuses": [r["status"] for r in result["responses"]]}


# P1. Scope and purge: one file per request under <home>/clarify_drafts/<gateway>/<digest(session key)>/.
home = TMP / "home-a"
rows = [{"qid": "q0", "question": "Q?", "choices": None, "multi_select": False}]
draft = {"q0": {"choices": [], "text": "typed", "revision": 1}}
scope_a, scope_b = (store.DraftScope(home, "tui_gateway", key) for key in ("stored-A", "stored-B"))
store.persist(scope_a, "srq-aaaaaaaaaaaa", rows, draft)
store.persist(scope_b, "srq-bbbbbbbbbbbb", rows, draft)
removed = store.purge_session(home, "stored-B")
out["P1_purge_is_exact_session_key"] = {
    "removed_files": removed,
    "A_records_after_purging_B": len(store.list_records(scope_a)),
    "B_records_after_purging_B": len(store.list_records(scope_b)),
    "relative_path_of_A": str(scope_a.path("srq-aaaaaaaaaaaa").relative_to(home)).replace("\\", "/")[:40] + "...",
}

# P2. A profile rename is a directory rename: the record follows the home (path has no profile name).
moved = TMP / "home-a-renamed"
os.rename(home, moved)
out["P2_records_after_home_directory_rename"] = len(store.list_records(store.DraftScope(moved, "tui_gateway", "stored-A")))

# P3. A killed process leaves the saved draft on disk with no outcome (never settled).
crash_home = TMP / "crash-home"
child = f"""
import sys; sys.path.insert(0, {str(SRC)!r})
from pathlib import Path
from tools.clarify_drafts import DraftBook, DraftScope
book = DraftBook('srq-cccccccccccc', {WIRE!r}, DraftScope(Path({str(crash_home)!r}), 'tui_gateway', 'stored-C'))
print(book.save('q0', ['Tea'], 'half typed', 5, locked=lambda: set(), is_open=lambda: True))
import os; os._exit(9)
"""
proc = subprocess.run([sys.executable, "-c", child], capture_output=True, text=True, timeout=60)
records = store.list_records(store.DraftScope(crash_home, "tui_gateway", "stored-C"))
out["P3_killed_process"] = {"child_exit": proc.returncode, "save_reply": proc.stdout.strip(),
                            "records_after": [{"outcome": r["outcome"], "drafts": r["drafts"]} for r in records]}

# P4. Two registries (parent and compute-host child are separate processes): the parent cannot save into the
# child's request, and the child's own result carries no drafts.
spec = importlib.util.find_spec("tui_gateway.server_requests")


def fresh_registry(name):
    module = importlib.util.module_from_spec(importlib.util.spec_from_file_location(name, spec.origin))
    module.__spec__.loader.exec_module(module)
    return module


child_reg, parent_reg = fresh_registry("child_registry"), fresh_registry("parent_registry")


def ask(registry, home_dir, key, save_with=None):
    box = {}
    scope = store.DraftScope(home_dir, "tui_gateway", key)
    thread = threading.Thread(target=lambda: box.update(result=registry.send(
        "clarify", "sid-1", {"questions": WIRE}, timeout=1.0, qids=QIDS, draft_scope=scope)))
    thread.start()
    while not registry._open:
        time.sleep(0.01)
    request_id = next(iter(registry._open))
    saved = (save_with or registry).save_draft(request_id, "sid-1", "q0", ["Tea"], "Native draft: line one\nline two", 7)
    thread.join(10)
    return request_id, saved, box["result"]


rid, saved_by_parent, child_result = ask(child_reg, TMP / "split", "stored-D", save_with=parent_reg)
out["P4_child_owned_request_pre_fix"] = {
    "parent_save_draft_returns": saved_by_parent,  # None -> methods_prompt answers {"status": "expired"}
    "child_result": child_result,
    "model_view": model_view(child_result),
    "records_on_disk": len(store.list_records(store.DraftScope(TMP / "split", "tui_gateway", "stored-D"))),
}
rid, saved_same, same_result = ask(child_reg, TMP / "same", "stored-E")
out["P4b_same_registry_sidecar"] = {
    "save_reply": saved_same,
    "result_keys": sorted(same_result),
    "drafts_durable": same_result.get("drafts_durable"),
    "model_view": model_view(same_result),
    "records_on_disk": [(r["outcome"], r["drafts"]["q0"]["revision"]) for r in
                        store.list_records(store.DraftScope(TMP / "same", "tui_gateway", "stored-E"))],
}

# P5. A closing frame's extra keys reach the model view unchanged, including a client-claimed `drafts_durable`
# for a draft the server never held.
box = {}
claim_scope = store.DraftScope(TMP / "claim", "tui_gateway", "stored-F")
thread = threading.Thread(target=lambda: box.update(result=child_reg.send(
    "clarify", "sid-2", {"questions": WIRE}, timeout=5.0, qids=QIDS, draft_scope=claim_scope)))
thread.start()
while not any(r.sid == "sid-2" for r in child_reg._open.values()):
    time.sleep(0.01)
rid2 = next(r.id for r in child_reg._open.values() if r.sid == "sid-2")
child_reg.resolve_response({"id": rid2, "result": {
    "answers": {"q0": "Tea"}, "drafts": {"q1": {"choices": ["Morning"], "text": "", "revision": 3}},
    "drafts_request_id": rid2, "drafts_durable": True}})
thread.join(10)
out["P5_closing_frame_passthrough"] = {"owner_result_keys": sorted(box["result"]), "model_view": model_view(box["result"]),
                                       "server_records_on_disk": len(store.list_records(claim_scope))}

# P6. A per-question card id (not an `srq-` batch id) is unknown to the session owner's draft registry.
from gateway import session_clarify_draft as owner_drafts  # noqa: E402
stub = SimpleNamespace(authority=SimpleNamespace(profile_id="default"), actor=object())
for request_id in ("0123456789", "srq-0123456789ab"):
    reply = asyncio.run(owner_drafts.clarify_draft(stub, None, {
        "session_id": "s1", "request_id": request_id, "question_id": "q0", "choices": ["Tea"], "text": "x", "revision": 1}))
    out.setdefault("P6_owner_clarify_draft_reply_for_unknown_request", {})[request_id] = reply

# P6b. Recall and discard take only `srq-` ids: a per-question card's own id is refused as `invalid_params`.
from gateway import session_server_requests as owner_registry  # noqa: E402
owner_registry.may_act_on_session = lambda authority, actor, session_id: True  # entitlement is not the question


async def refusal_or_reply(fn, params):
    try:
        return await fn(stub, None, params)
    except Exception as exc:  # RuntimeStoreError carries the reason
        return {"raised": type(exc).__name__, "reason": getattr(exc, "reason", str(exc))}


for request_id in ("0123456789", "srq-0123456789ab"):
    out.setdefault("P6b_owner_recall_and_discard", {})[request_id] = {
        "clarify.drafts": asyncio.run(refusal_or_reply(owner_drafts.clarify_drafts, {"session_id": "s1", "request_id": request_id})),
        "clarify.drafts.discard": asyncio.run(refusal_or_reply(owner_drafts.clarify_drafts_discard, {"session_id": "s1", "request_id": request_id}))}
out["P6b_owner_recall_and_discard"]["(no request id)"] = {
    "clarify.drafts": asyncio.run(refusal_or_reply(owner_drafts.clarify_drafts, {"session_id": "s1"}))}

# P7. What the model is told when a per-question messaging/owner card times out.
out["P7_per_question_timeout_model_view"] = model_view(
    {"answers": {}, "outcome": "timed_out", "notice": "[user did not respond within 0m]"})

# P8. The session owner's own batch registry (a `clarify_batch: true` turn): same DraftBook, `session_owner` store.
from gateway import session_server_requests as owner  # noqa: E402
frames = []
events = SimpleNamespace(fanout=SimpleNamespace(transports=lambda: [object()], write=frames.append),
                         publish=lambda *args, **kwargs: None)
box = {}
owner_scope = store.DraftScope(TMP / "owner", "session_owner", "sess-1")
thread = threading.Thread(target=lambda: box.update(result=owner.ask_viewer_result(
    events, "sess-1", "clarify", {"questions": WIRE}, timeout=1.0, qids=QIDS, draft_scope=owner_scope)))
thread.start()
while not frames:
    time.sleep(0.01)
request_id = frames[0]["id"]
saved = owner.save_draft(request_id, "q0", ["Tea"], "Native draft: line one\nline two", 9, session_ok=lambda sid, ev: True)
thread.join(10)
out["P8_owner_batch_registry"] = {
    "request_frame_method": frames[0]["method"], "request_id_prefix": request_id[:4], "save_reply": saved,
    "result_keys": sorted(box["result"]), "model_view": model_view(box["result"]),
    "records_on_disk": [(r["outcome"], r["drafts"]["q0"]["revision"]) for r in store.list_records(owner_scope)],
}

print(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False))
shutil.rmtree(TMP, ignore_errors=True)
```

</details>

## Appendix B. Baseline run facts

Run [39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224)
(`workflow_dispatch`, `windows-2025` x64, commit `4a92978697f386d7124e81d463f3a404ac4403fd`, started
2026-10-22 07:23 UTC), conclusion **failure**. It is the unmodified candidate's baseline, not a pass.
Artifact `clarify-windows-39740118224-1` (id 12408804207, upload digest
`b8368562dc3db861b29418fca3a6afeb7b8bafc0fcc50e796b1951141afb6192`, retention 7 days).

| Step | Outcome |
|---|---|
| Locked toolchain, `npm ci`, Desktop build | success |
| Clarify draft and contract Python tests | failure: 17 files, 234 passed, 2 failed (`test_clarify_lock_owner.py` end-to-end test, `WinError 10106`; `test_clarify_drafts.py` restart test, POSIX mode assertion) |
| Generated gateway contracts | success |
| Isolation preflight | success |
| Native Playwright spec | failure: `locator.fill` timeout waiting for the second "Other" field (spec line 56); 1 failed, 0 expected |
| No real-install location touched | failure: `%APPDATA%\Hermes` existed after the run (absent before) |
| Native evidence verification, evidence gate | failure (consequence of the above) |

The baseline run is the only Actions run on the candidate branch at the time of writing.
<!-- LEAD: add later runs here, or point to HANDOFF.md -->
