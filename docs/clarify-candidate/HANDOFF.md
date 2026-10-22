# Windows candidate handoff: template

Template for the final handoff that `CLOUD_TASK.md` ("Finish and reporting") asks for. Everything outside a
placeholder was true when S5 wrote it on 2026-10-22; everything inside `<!-- LEAD: ... -->` is for the lead
to replace with a value read back from a real commit, run or file. Delete any line for something that did
not happen. Do not send a placeholder. Search for `LEAD:` before sending.

## Choosing the verdict

`WINDOWS CANDIDATE VERIFIED` only when every one of these is true and recorded below with a link or checksum:

1. The native Windows scenario (`apps/desktop/e2e/clarify-drafts-native.spec.ts` and the extended acceptance
   cases) passed on a standard `windows-2025` run, unretried and with its assertions intact, on the tested
   commit.
2. The Windows artifact was built with publication disabled (`--publish never`), and **the packaged bytes**
   (not the development source) passed the same scenario against a backend that has the new RPCs.
3. The artifact and its checksum are uploaded and were read back.
4. The residual limitations in section 5 are stated as they are, not softened.

Otherwise the verdict is `BLOCKED`, with the concrete blocker, what was tried, and what would unblock it.
Never equate source written, workflow created, build passed, native test passed, artifact uploaded and
production installed: they are separate rows in section 2.

## Copy-ready handoff

**<!-- LEAD: WINDOWS CANDIDATE VERIFIED or BLOCKED -->**

Basis: <!-- LEAD: two sentences at most. Verified: "The packaged bytes with SHA-256 X passed the native Windows scenario in run URL, commit Y." Blocked: the blocker and what was tried. -->

### 1. Repository, commit and changes

- Repository: https://github.com/troyrowe-resource/hermes-clarify-autosave
- Branch: `candidate/clarify-autosave-windows`, started from `main` at
  `9cbb93849d305369ad060d449cb530f8d3f2a185`; first candidate commit `4a92978697f386d7124e81d463f3a404ac4403fd`.
- Tested commit (the commit the verifying run executed): <!-- LEAD: full SHA -->
- Final commit (carries this handoff): <!-- LEAD: full SHA -->. Difference from the tested commit: <!-- LEAD: "documentation only" if `git diff --stat` shows nothing else, otherwise list it -->
- Meaningful changes: <!-- LEAD: one bullet each, with the commit, for example the Desktop asking the canonical gateway for batch clarify requests, the compute-host draft relay, Windows test and workflow repairs, packaging -->

### 2. Stages, kept distinct

| Stage | Done | Evidence |
|---|---|---|
| Source written | <!-- LEAD: yes/no --> | <!-- LEAD: commits --> |
| Workflow created or changed | <!-- LEAD --> | <!-- LEAD: file and commit --> |
| Build passed (Windows, from source) | <!-- LEAD --> | <!-- LEAD: run URL, step --> |
| Native test passed (Windows, tested commit) | <!-- LEAD --> | <!-- LEAD: run URL; Playwright expected/unexpected/flaky/skipped --> |
| Artifact uploaded | <!-- LEAD --> | <!-- LEAD: artifact name, link, checksum --> |
| Packaged bytes tested | <!-- LEAD --> | <!-- LEAD: run URL --> |
| Production installed | **No. Not authorised and not done.** | n/a |

### 3. Agents, models and effort actually used

State once whether Sonnet 5.5 at maximum reasoning was available for the parallel workers. Per
`CLOUD_TASK.md`, do not claim a setting that was clamped. <!-- LEAD: available and used, or the limitation and the substitute -->

| Agent | Workstream | Model and effort | Finished | How the lead checked the output |
|---|---|---|---|---|
| Lead | Architecture, integration, commits | <!-- LEAD: from the session, not assumed --> | <!-- LEAD --> | n/a |
| S1 | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> |
| S2 | <!-- LEAD: Windows CI / native verification (the coordinator named S2 for the native run) --> | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> |
| S3 | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> |
| S4 | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD --> |
| S5 | Execution-path inventory, README and provenance drafts, this template | Its own prompt states `claude-sonnet-5-5` (Sonnet 5.5) and reasoning effort `max`; S5 cannot verify the effort setting itself, so confirm it against the spawn call | Drafts delivered to the lead; every `LEAD:` placeholder is open | Citations re-checked line by line against `4a92978`; probes re-run (`EXECUTION_PATHS.md`, Appendix A) |

### 4. Actions runs and real results

Record each run once, with the number read back from the run, never from memory.

| Run | Commit | Conclusion | Python | Desktop | Native Windows | Artifact |
|---|---|---|---|---|---|---|
| [39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224) (baseline, unmodified candidate) | `4a92978` | **failure** | 234 passed, 2 failed (17 files) | not run in that workflow | failed at the second "Other" field (spec line 56) | evidence only (`clarify-windows-39740118224-1`) |
| <!-- LEAD: run URL --> | <!-- LEAD --> | <!-- LEAD --> | <!-- LEAD: N passed, N failed, N files --> | <!-- LEAD: N passed across N files --> | <!-- LEAD: N expected, N unexpected --> | <!-- LEAD --> |

Linux checks on the tested commit: <!-- LEAD: `scripts/run_tests.sh` counts, generated-contract check, renderer type check, focused Desktop tests, repository checks, each with the commit it ran on -->

### 5. Tested backend paths and residual limitations

Full route-by-route evidence: `docs/clarify-candidate/EXECUTION_PATHS.md`. The first column is where
each route stood at `4a92978`; the second is the candidate's own result.

| Route | At `4a92978` | In the candidate |
|---|---|---|
| Desktop, canonical local gateway (the default; one card per question until the Desktop asks for a batch) | Device-only; `clarify.draft` answered `expired`; the assistant was told nothing | <!-- LEAD: tested how, on Windows or Linux, which test, run URL --> |
| Canonical owner, batch request (`clarify_batch: true`) | Server save, recall and discard in code and probe; no native test; no reconnect replay | <!-- LEAD --> |
| Legacy `tui_gateway` sidecar in process (remote or legacy transport) | Server save, recall and discard in code and probe | <!-- LEAD --> |
| Sidecar with turn isolation (compute-host child) | Device-only: the parent answered `expired` | <!-- LEAD: relay tested how --> |
| Ink terminal UI, dashboard `/chat`, classic CLI | No draft code | Unchanged <!-- LEAD: confirm --> |
| Per-question viewers (ACP editors, raw WebSocket clients, `api_server` runs, managed-worker runs) | Unprotected | Unchanged <!-- LEAD: confirm --> |
| Messaging platform cards | Not applicable: the reply is the answer | Not applicable |

Residual limitations to state as they are (each is in `EXECUTION_PATHS.md`; flip one to "fixed in candidate"
only with a commit and a passing test name):

- Per-question cards stay device-only or unprotected wherever no batch request is made: <!-- LEAD: final list after the Desktop change -->.
- Server drafts are removed only by the legacy `session.delete` RPC. Deleting from the Desktop, dashboard, CLI,
  bulk prune or automatic prune leaves them on disk. <!-- LEAD: or the fix and its test -->
- Profile rename strands device copies; profile delete leaves them; profile clone and export carry unsent text.
- A killed turn leaves a durable draft with no terminal result and no screen that offers recall.
- No retention timer and no cap on the number of draft files.
- On the owner route an open batch card and its drafts are not replayed after a reconnect or restart.
- Windows: POSIX file modes (`0600`) are not enforced and directories are not fsynced.
  <!-- LEAD: say what happened to `tests/tui_gateway/test_clarify_drafts.py:254`, which failed in the baseline run for this reason -->
- Windows CI does not prove compatibility with the owner's laptop, production server connection or installed
  update mechanism.

### 6. Artifact

Unsigned. Not Nous-signed and not a verified installer.

| Item | Value |
|---|---|
| Actions run | <!-- LEAD: URL --> |
| Artifact name and link | <!-- LEAD --> |
| Retention | <!-- LEAD: days (the workflow's current setting is 7) --> |
| SHA-256 of the uploaded Actions artifact (zip) | <!-- LEAD: from the upload step output --> |
| SHA-256 of the packaged bytes that were tested (installer, archive or launcher) | <!-- LEAD: from `Get-FileHash` or `sha256sum` on the tested file --> |
| Downloaded copy re-hashed and matched | <!-- LEAD: yes/no, how --> |
| Built with publication disabled | <!-- LEAD: yes/no; the exact `--publish never` command and the log line --> |
| Source commit inside the artifact | <!-- LEAD: where it is recorded in the manifest --> |
| Runtime prerequisites | <!-- LEAD: Windows version and architecture; whether Python, Node and the backend are bundled or must be installed; the backend that carries the new RPCs. A thin app that starts an official backend lacking them is not proof of autosave. --> |
| Safe isolated launcher | <!-- LEAD: how it keeps its own `HERMES_HOME`, user-data directory and app name, ignores any installed Hermes, and skips `hermes://` registration --> |
| Signing | Unsigned: not Nous-signed and not a verified installer. <!-- LEAD: confirm that no certificate was used or installed --> |

### 7. Production was not touched

- As at `4a92978`, the workflow runs on a GitHub-hosted `windows-2025` runner with the provider keys blank
  (`.github/workflows/clarify-windows.yml:33-38`) against a synthetic inference server. <!-- LEAD: re-check this against the final workflow -->
- Isolation guard, before and after sentinels for `%APPDATA%\Hermes`, `%LOCALAPPDATA%\hermes`, `~\.hermes` and
  the `hermes://` registry keys: <!-- LEAD: result in the verifying run. The baseline run's check FAILED because `%APPDATA%\Hermes` appeared; say how that was resolved. -->
- No GitHub Release or package was published, no billing or permission setting changed, no secret added: <!-- LEAD: confirm -->
- The owner's installed app, updater and live server were not contacted or modified: <!-- LEAD: confirm for every agent -->
- S5 read only this repository and its Actions run through read-only calls, ran its probes in a scratch
  directory, and wrote only documentation files.

### 8. One next action for the owner

<!-- LEAD: exactly one. Verified: "Download <artifact>, check SHA-256 <value>, run the isolated launcher against a throwaway HERMES_HOME on your Windows laptop, and tell me what you see." Blocked: the one decision or approval that unblocks it. -->
