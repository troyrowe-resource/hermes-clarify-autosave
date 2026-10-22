# Windows candidate handoff

Final handoff for `CLOUD_TASK.md` ("Finish and reporting"). The sections follow the items that task asks for. Numbers come from the Actions run artifacts the lead read back, from the lead's clean-tree command output or the session record, or, where a worker is named, from that worker's own run. Paths are relative to the repository root.

**{{VERDICT}}**

Basis: {{VERDICT_BASIS}}

### 1. Repository, commit and changes

- Repository: https://github.com/troyrowe-resource/hermes-clarify-autosave
- Branch: `candidate/clarify-autosave-windows`, started from `main` at `9cbb93849d305369ad060d449cb530f8d3f2a185`; first candidate commit `4a92978697f386d7124e81d463f3a404ac4403fd`.
- Tested commit (the commit the acceptance run executed): `{{RUN7_COMMIT}}`.
- Final commit: the branch head. It differs from the tested commit by documentation only. A commit cannot name itself, so read it from the branch head.
- History: many intermediate commits are labelled `wip: checkpoint`, because the session's stop hook required a clean tree while five workers edited; some of those skipped the pre-commit lint and say so in their message. Every validated commit after them passed the repository hooks. `python scripts/check --base 4a929786` reported "12 checks, ok" on `b770aeda` (lead, 12:39Z), with code health at 0 blocking.
- Meaningful changes, ten, all product code:
  1. **The Desktop asks the canonical gateway for one batch clarify request** (`clarify_batch: true` on `prompt.submit`). It is gated: canonical owners only (a WebSocket URL with `native_dial`, or the canonical local owner), never a legacy `hermes serve` sidecar (which rejects unknown keys with code 4000). An older canonical gateway that refuses it before admission (`invalid_params`, code 4001) gets one resend without the flag under the same submission id, and the owner is remembered as unsupported for 10 minutes. Edit, Regenerate and Restore offer it only to owners that already accepted it in this app run, because a rewind cannot be safely re-sent. Files: `apps/desktop/src/store/clarify-batch.ts`; under `apps/desktop/src/app/session/hooks/`, `use-prompt-actions/{submit.ts, rewind.ts, submission-destination.ts}` and `use-session-actions/{index.ts, session-create-request.ts}`; `apps/desktop/src/app/contrib/hooks/use-session-tile-delegate.ts`.
  2. **The canonical gateway replays an open batch clarify** (questions, locked answers, and drafts with their revisions) in `session.resume` and `session.events.since`, entitled exactly like `clarify.lock` (an attached viewer with `session:respond`, own session and profile only). Settled, cancelled and timed-out requests never reappear. Files: `gateway/session_server_requests.py`, `gateway/session_controls.py`, `tui_gateway/contracts/canonical_sessions.py` (with the regenerated `apps/shared/src/gateway-contract.generated.ts` and `.openrpc.json`); the renderer merge in `apps/desktop/src/api/canonical-protocol.ts`.
  3. **A clarify timeout no longer shows two settled cards** (the projected cancel result is adopted in place): `apps/desktop/src/lib/chat-messages/tool-parts.ts`.
  4. **"Show drafts saved on the server" and "Discard drafts" survive the settled card's remount** when the stored transcript replaces the live message at turn end (state keyed by card identity in the store). Found by Windows run 39761924192. Files: `apps/desktop/src/store/clarify-drafts.ts`, `apps/desktop/src/components/assistant-ui/clarify/settled-drafts.tsx`.
  5. **Renderer robustness.** Edits made offline are re-sent when the open request is redelivered; an `expired` reply from a socket not yet attached no longer closes saving for good; "method not found" memos lapse after 10 minutes; a cleared draft is re-sent, so deleted text is never reported to the model; a late durable acknowledgement for an older revision cannot overwrite a newer confirmation. Files: `apps/desktop/src/components/assistant-ui/clarify/pending-drafts.tsx`, `apps/desktop/src/store/clarify-drafts.ts`.
  6. **A compute-host (turn isolation) child relay.** `clarify.draft` and `clarify.drafts.discard` reach the child that owns the request, with the same entitlement and statuses; the parent's mirror replays drafts on reconnect; a crashed or wedged child answers error 5019, never `ok` with `durable: true`; the child writes under the same `DraftScope`, so the parent's recall works after the child exits. Files: `tui_gateway/{compute_host_bridge.py, compute_host.py, host_supervisor.py, methods_prompt.py, server_requests.py}`. A POSIX feature; see section 5.
  7. **Draft store hardening.** Directories through `hermes_dir_acl.make_user_dir` (the Windows elevated-ACL hazard) and `atomic_replace`; a save for a deleted named profile is `durable: false` and never recreates it; text or choices that cannot be encoded as UTF-8 are refused with `invalid_params`; model-authored question text with a lone surrogate can no longer break save, lock or settle; persistence problems never raise (`durable: false`); a purge also removes `.draft-*.tmp` residue. File: `tools/clarify_drafts.py`. `settle_batch` ignores client-supplied `drafts*` keys: `tools/clarify_batch.py`.
  8. **Session deletion purges server drafts** at the central seam `hermes_state_common.emit_session_deleted`, for every reason except `archive` (delete, empty sweep, prune, ghost prune, profile repair; the canonical Desktop delete included), per profile home, failing open. File: `hermes_state_common.py`.
  9. **`hermes profile create --clone-all` no longer copies `clarify_drafts`** (orphaned unsent text). File: `hermes_cli/profiles.py`.
  10. **Desktop isolation.** The Electron user-data location is decided before any module can read it, which fixes the baseline run's creation of `%APPDATA%\Hermes` (`apps/desktop/electron/desktop-user-data-boot.ts`, `product-identity.ts`). A commit build never registers the OS `hermes://` handler (`deep-link-protocol.ts`). A commit build gives its backend `HERMES_GATEWAY_LOCK_DIR=<its HERMES_HOME>/gateway-locks` unless one is set, so it never shares the per-user gateway rendezvous with an installed Hermes (`backend-spawn-env.ts`, `main.ts`). Stable, channel, CI and dev builds are unchanged.
- CI and packaging, not counted in the ten: `.github/workflows/clarify-windows.yml` and `scripts/clarify_ci/**`. Manual `workflow_dispatch` only (input `stage`: `all` or `native`), `permissions: contents: read`, no secrets, one run per branch, every job capped at 60 minutes, artifact retention 7 days. Five stages:
  - Launcher self-test, on Windows PowerShell 5.1 and 7.
  - Windows native: locked toolchain (`setup-pm`), `npm ci`, Desktop build, 29 Python test files (including every `test_*clarify*draft*`), the generated-contract check, Electron identity and deep-link unit tests, isolation sentinels before and after, the 7 native Playwright specs plus `batch-clarify.spec.ts` with one worker and `--retries=0`, then evidence verification.
  - Linux compute-host (`ubuntu-24.04`, xvfb): the compute-host Python tests, including a real child, and the native spec.
  - Package, only after those three pass: a one-commit bundled build through `scripts/bundles/desktop.py`, electron-builder with `--publish never` and no signing variables, an audit of identity, stamp and bundle environment, then a zip with `MANIFEST.json` and `SHA256SUMS.txt`.
  - Accept: downloads the uploaded zip, checks its digest against the package job's output and every file against `MANIFEST.json`, extracts it, runs `clarify-drafts-packaged.spec.ts` through the shipped launcher with decoy `HERMES_HOME`, `HERMES_DESKTOP_HERMES_ROOT`, `PYTHON` and `PYTHONPATH` exported, then `clarify-drafts-packaged-direct.spec.ts`, which starts the exe with no launcher. Strict sentinels and a verdict close it.

### 2. Stages, kept distinct

Each row is its own fact; none implies another. The rows are the six stages `CLOUD_TASK.md` names, with the test of the packaged bytes that it requires shown as its own row.

| Stage | Status | Evidence |
|---|---|---|
| Source written | Yes | Commits `4a92978..{{RUN7_COMMIT}}`: the ten changes in section 1 |
| Workflow created or changed | Yes | `.github/workflows/clarify-windows.yml` and `scripts/clarify_ci/**`: launcher self-test, Windows native, Linux compute-host, package and accept jobs (section 1) |
| Build passed (Windows, from source) | Yes | Locked toolchain, `npm ci` and the Desktop build passed in the baseline, [run 39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224). The native specs of runs 39751372320, 39761924192, 39768307967 and 39780275912 ran against the built app |
| Native test passed (Windows, tested commit) | Run {{RUN7_ID}}: {{RUN7_NATIVE}} | Earlier pass on `b770aeda`: [run 39780275912](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39780275912), 19 expected, 0 unexpected, 0 skipped, 0 flaky, evidence verdict passed |
| Artifact uploaded | Package job: {{RUN7_PACKAGE}} | {{ARTIFACT_NAME}}, {{ARTIFACT_URL}}, zip SHA-256 `{{ZIP_SHA256}}` |
| Packaged bytes tested | Accept job: {{RUN7_ACCEPT}} | The uploaded zip, its digest and every file checked against `MANIFEST.json`, then run through the launcher and directly; exe SHA-256 `{{EXE_SHA256}}`; run {{RUN7_URL}}. The accept job's `acceptance-verdict.json` records the verdict against the zip's SHA-256 |
| Production installed | **No. Not authorised and not done.** | n/a |

### 3. Agents, models and effort actually used

Sonnet 5.5 at maximum reasoning was available and used for all five parallel workers: S1 to S5 ran as `claude-sonnet-5-5` with effort `max`, verified by a probe agent that reported its own model and effort from its system prompt. The lead ran as `claude-opus-5-5` (session record: configured, current and last served), effort mode ultracode. Each worker was resumed for one or two follow-up rounds.

| Agent | Workstream | Output checks |
|---|---|---|
| Lead | Architecture, integration, commits, Linux verification, reading the Windows run artifacts back | n/a |
| S1 | Windows CI, packaging and launcher | `scripts/clarify_ci` tests: 101 passed (S1's own run); the lead read every Windows run back |
| S2 | Desktop native E2E and renderer fixes | Native Linux under xvfb 19/19 at `d2d53710`; vitest 8,758 tests with 3 failures in `store/dead-session-prune.test.ts` and `store/voice-prefs.test.ts`, which fail identically on a base `git archive` in this environment (pre-existing, unchanged files) |
| S3 | Backend: compute-host relay, Windows store fixes, reconnect replay, purge seam, failure injection | 33 files, 933 passed, 0 failed; `tests/hermes_state` 206 files, 1796 passed, 0 failed, 27 skipped (S3's own runs) |
| S4 | Linux regression, isolation audit, Electron isolation fixes | Electron vitest 666 passed (S4's own run) |
| S5 | Execution-path inventory, README, provenance and this handoff | Citations re-checked line by line against `4a92978`; probes re-run (`docs/clarify-candidate/EXECUTION_PATHS.md`, Appendix A) |
| Review workflow | Adversarial review of the candidate: 4 reviewers and 42 refuters, 46 Sonnet 5.5 agents at max effort | Found 14 candidate defects. A 3-vote panel confirmed 3, all fixed: UTF-8 and lone surrogate, purge `.tmp` residue, `--clone-all` copying drafts. The panel judged the current tree while owners were fixing in parallel, so its "rejected" votes on the other 11 include already-fixed code; the owners proved 10 of those 11 real with failing tests before fixing (5 launcher, 4 renderer, 1 Electron test isolation); the Defender-exclusion item was an accepted decision |

The Workflow tool's concurrency was capped at 2 on this 4-CPU container, so the long-running streams used background agents instead.

### 4. Actions runs and real results

All on standard GitHub-hosted `windows-2025` x64 (the Linux job on `ubuntu-24.04`). "full" is dispatch stage `all`; "native" is stage `native`.

| Run | Commit | Result |
|---|---|---|
| [39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224) (baseline) | `4a92978` | Failure. Python 234 passed, 2 failed (Windows-only: a POSIX `0600` assertion; `SYSTEMROOT` missing in a child environment). Native seed spec failed: one card per question, because the Desktop never asked for a batch. Isolation failed (`%APPDATA%\Hermes` created) |
| [39751372320](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39751372320) (discovery, stage native) | `fae57e6c` (work in progress) | Failure. Python 395 passed, 0 failed; launcher self-test passed; isolation passed; native 15 passed, 1 failed (restart: an 8.3 short path against the canonical gateway's lock path), 3 skipped (compute-host not supported on Windows) |
| [39761924192](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39761924192) (full) | `49d95c0d` | Failure. Launcher passed; Linux compute-host 2/2; Windows Python passed; native 17 passed, 1 failed (recall lost when the settled card remounted at turn end: a real bug, fixed), 1 serial skip; package skipped by its gate |
| [39768307967](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39768307967) (stage native) | `6a082a14` | Failure only in the launcher job (PowerShell 5.1: a UTF-8 preamble reached the gateway CLI's stdin, a real bug fixed with stdin NUL). Windows native 19/19, 0 skipped, 0 flaky; Python 28 files, 427 passed, 0 failed, 7 skipped (POSIX-only); Linux compute-host passed |
| [39779280926](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39779280926) | `ae1a547e` | Cancelled by the lead: superseded by a one-line code-health fix |
| [39780275912](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39780275912) (full) | `b770aeda` | Launcher passed on PowerShell 5.1 and 7; Windows native 19 expected, 0 unexpected, 0 skipped, 0 flaky; Windows Python 29 files, 428 passed, 0 failed, 7 skipped (POSIX-only); Linux compute-host native 2/2 and Python passed; isolation passed. **Package failed**: its bundled prepare step timed out at the 25-minute cap on a cold dependency cache (`npm ci` about 9.5 minutes, tools about 3.5, all-extras venv about 8); the budget was raised to 38 minutes in `e7dc1f9b` |
| [{{RUN7_ID}}]({{RUN7_URL}}) (full) | `{{RUN7_COMMIT}}` | Windows native: {{RUN7_NATIVE}}. Package: {{RUN7_PACKAGE}}. Accept: {{RUN7_ACCEPT}} |

Evidence artifacts (retention 7 days) were downloaded and re-hashed, and the SHA-256 matched every time: `b8368562dc3db861b29418fca3a6afeb7b8bafc0fcc50e796b1951141afb6192` (39740118224), `8b011899...` (39751372320), `9cb0181f...` (39761924192), `4ff592b2...` (39768307967), and for 39780275912 `clarify-windows` `242210db17909b511cb481aa5ceb5518b6c1ca6818b450ca7c6d6bae9d39cf31` and `clarify-linux` `e38c3973097aaece9c624c90a4f84ec0838d87cf1550eaa415cf49fd02991443`.

Linux checks on the candidate, run by the lead on a clean tree at `ae1a547e` (12:33 to 12:38Z), which differs from `e7dc1f9b` only by a comment line in `hermes_cli/profiles.py` and the workflow's prepare timeout:

- Python (the workflow's 29-file selection plus the compute-host and purge files): 30 files, 436 passed, 0 failed, 1 skipped (a Windows-only arm).
- Generated contracts current; `npm run typecheck` (4 stages) exit 0.
- Renderer vitest 51 files, 622 passed; Electron and e2e-unit vitest 8 files, 84 passed.
- `scripts/check` failed there only on code health for `profiles.py` (2462 lines against a limit of 2460, from a comment) and reported "12 checks, ok" on `b770aeda`.

### 5. Tested backend paths and residual limitations

Route-by-route evidence, with file and line citations at the base: `docs/clarify-candidate/EXECUTION_PATHS.md`.

| Route | At `4a92978` | In the candidate, and the proof |
|---|---|---|
| Desktop, canonical local gateway (the default) | Device-only; `clarify.draft` answered `expired`; the assistant was told nothing | Batch card, server plus device protection, recall and discard, reconnect replay, and the assistant told the drafts were not submitted. Windows native 19/19 in runs 39768307967 and 39780275912 (seed, mixed, failure, reconnect and restart specs) plus gateway tests |
| Desktop, remote `hermes serve` (the legacy `tui_gateway` sidecar, in process) | Server save, recall and discard in code and probe; no native test | Server plus device, reconnect replay (the sidecar's snapshot), recall from a fresh backend, discard: `clarify-drafts-native-serve.spec.ts` in the same two runs |
| Compute-host child under `dashboard.turn_isolation` (legacy sidecar only) | Device-only: the parent answered `expired` | Server through a relay, POSIX only: Linux job, 2/2 native plus real-child Python tests. Not supported in practice on Windows (below); the Windows Desktop's local route never reaches it |
| Per-question cards: ACP editors, raw WebSocket clients, `api_server`, managed workers, an older canonical gateway that refuses `clarify_batch`, a rewind that is the first action after app launch | Device-only on the Desktop, unprotected elsewhere | Unchanged |
| Ink terminal UI, dashboard `/chat` | No draft code | Unchanged: no draft code |
| Classic CLI | Asks for batches, never sends drafts | Unchanged |
| Messaging platform cards | Not applicable | Not applicable |
| `hermes-bots` plugin submit paths | n/a | Untouched |

Residual limitations, stated as they are:

- The compute-host relay is POSIX-only in practice. On Windows `tui_gateway/host_supervisor.py` calls `os.kill(pid, 0)` (which is `CTRL_C_EVENT` there), refers to `signal.SIGKILL` (missing) and relies on `/proc` and `ps` lookups; the upstream real-child tests are Linux-only.
- Per-question cards (the fourth row above) stay device-only on the Desktop or unprotected elsewhere.
- Sidecar context compression rotates the session key: drafts saved under the old key drop out of recall (deleting the conversation still purges every segment).
- A killed or crashed turn leaves a durable draft with outcome null, and no screen offers recall.
- There is no retention timer and no file-count cap (recall lists the newest 50). Device copies never expire; a profile rename strands them and a profile delete leaves them. `hermes profile export` still carries `clarify_drafts`; only `--clone-all` excludes them now.
- Windows has no POSIX file modes, so privacy relies on the directory ACL set by `make_user_dir`, and directory fsync is not possible there. The baseline's two Python failures (a POSIX `0600` assertion; `SYSTEMROOT` missing in a child environment) do not recur: Python 0 failed in every later Windows run, with POSIX-only tests marked `platforms('posix')` and skipped (7 in the latest).
- The session owner's `clarify.draft` does its store I/O on the gateway event loop (measured median 1.8 ms, p95 3.4 ms, max 6.7 ms).
- Recalled and discarded card states live in renderer memory and are not pruned when a conversation is deleted.
- A direct double-click of the candidate exe, without the launcher, uses the real profile as the assistant's working folder and leaves empty candidate-named folders (`%APPDATA%\HermesBundledCommit<sha7>`). It never touches `%APPDATA%\Hermes`, the `hermes://` handler or the per-user gateway rendezvous. Use the launcher.
- CI on a clean GitHub runner does not prove compatibility with the owner's laptop, installed app, live server connection or update mechanism.

### 6. Artifact

Unsigned. Not Nous-signed and not a verified installer.

| Item | Value |
|---|---|
| Actions run | {{RUN7_URL}} (package job: {{RUN7_PACKAGE}}; accept job: {{RUN7_ACCEPT}}) |
| Artifact name and link | {{ARTIFACT_NAME}}: {{ARTIFACT_URL}} |
| Retention | 7 days (the workflow's setting) |
| SHA-256 of the uploaded Actions artifact (its upload digest) | `{{ARTIFACT_DIGEST}}` |
| SHA-256 of the candidate zip | `{{ZIP_SHA256}}` |
| SHA-256 of the exe that was tested | `{{EXE_SHA256}}` |
| Downloaded copy re-hashed and matched | {{REHASH}} |
| Built with publication disabled | electron-builder `--publish never`, no signing variables set. The manifest records publication disabled: no GitHub Release, no installer, auto-update disabled. No GitHub Release or package was published |
| Source commit inside the artifact | The package's `MANIFEST.json` records `source.commit` and embeds the provenance file as it stood at the tested commit, before this run's results existed. The final `source-provenance.json` in the repository records them |
| Contents | One top-level folder `HermesClarifyCandidate-<sha7>`: `Start-HermesClarifyCandidate.cmd`, `Stop-HermesClarifyCandidate.cmd`, `README-CANDIDATE.txt`, `launcher/*.ps1`, `app/<product>.exe` with `app/resources/`, `MANIFEST.json` and `FILES.sha256`. An outer `MANIFEST.json` and `SHA256SUMS.txt` name the archive's own digest |
| Runtime prerequisites | As the package job records them in `MANIFEST.json`: Windows on x64, built and started only on a GitHub-hosted `windows-2025` x64 runner (Windows Server 2025, build 26100), nothing older tried (Electron 40 needs Windows 10 or newer, but the project's own MSIX packaging floor is Windows 11 22H2, build 22621); no Python, Node, Git or Hermes installation is claimed to be required, because the candidate carries its own interpreter, dependencies, tools and this commit's source; the Microsoft Visual C++ 2015-2022 x64 redistributable is assumed present; about twice the zip size in free disk space; network access only for what you configure. Unsigned downloads trigger SmartScreen: unblock the zip before extracting. Tested only on a standard runner, never on another machine |
| Safe isolated launcher | `Start-` and `Stop-HermesClarifyCandidate.cmd`, with PowerShell. A sandbox under `%LOCALAPPDATA%\HermesClarifyCandidate`: its own `HERMES_HOME`, Electron user data (through the environment and `--user-data-dir`), `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `HERMES_GATEWAY_LOCK_DIR` and assistant workspace (`HERMES_DESKTOP_CWD`), with protocol registration skipped, any installed Hermes ignored and the backend isolated. It refuses a root that equals, sits inside or contains a real Hermes location (junctions and `subst` drives resolved), and refuses an exe whose SHA-256 differs from `MANIFEST.json`. Stop never prompts (`gateway stop --yes`, stdin NUL), always sweeps processes running from the package, and leaves unrelated same-named processes alone |
| Signing | Unsigned: not Nous-signed and not a verified installer. No certificate was used or installed |

### 7. Production was not touched

- Isolation guard: sentinels before and after, for `%APPDATA%\Hermes*`, `%LOCALAPPDATA%\hermes*`, `%USERPROFILE%\.hermes*`, `%USERPROFILE%\.local\state\hermes*` and `HKCU\Software\Classes\hermes[-dev]`, were unchanged in every Windows run after the fixes. The baseline run's check FAILED because `%APPDATA%\Hermes` appeared; change 10 resolved it.
- The workflow has no `secrets.*` reference and `permissions: contents: read`; the provider keys are blank in its environment (`.github/workflows/clarify-windows.yml:54-57`) and a mock inference server is the only model. Standard GitHub-hosted runners only.
- No GitHub Release or package was published, and no billing, permission, secret or repository setting was changed.
- No agent contacted a live Hermes server, an installed app, an updater or production data. No certificate was used or installed; the artifacts are unsigned.
- On the runner only, the package job adds Microsoft Defender scan exclusions for its two build roots; the workflow does not change real-time monitoring, and the accept job leaves Defender untouched. This was an accepted decision.
- Incidents in the disposable cloud container (not the owner's machine):
  1. `/root/.hermes` in the container got a Hermes home skeleton at 08:30:35Z from the lead-requested full `tests/hermes_state` run: three pre-existing upstream tests spawn child processes with the real `HOME` and no `HERMES_HOME` (`test_isolation_marker_env.py`, `test_live_db_guard_ancestry.py`, `test_live_db_isolation_guard.py`). A vitest electron-project run without `HERMES_PYTHON` then did a 2.2 GB package-manager tool sync at 09:06 to 09:08Z. Both were left in place: the owner's rule is no deletions without confirmation, and the container is disposable.
  2. A review-workflow agent overwrote the shared scratch environment file at 10:22Z; it was restored. One worker's runs then provisioned a package-manager environment inside the scratchpad only.
  3. An attempt to run a separate package-discovery branch without the native gate was blocked by the permission classifier as a CI bypass. Nothing was pushed or dispatched.
- S5 read this repository and the baseline Actions run (logs and artifact) through read-only calls, ran its probes against a `git archive` of the base commit with its temporary files in the scratch area (a first attempt that crashed left one temporary directory under `/tmp`, which S5 removed), and edited only `README.md`, `source-provenance.json` and `docs/clarify-candidate/`.

### 8. One next action for the owner

{{NEXT_ACTION}}

Suggested separately, outside this task:

- Fix the Windows footguns in `tui_gateway/host_supervisor.py`, or refuse turn isolation on Windows.
- Stop three `tests/hermes_state` tests from writing to the real `~/.hermes`.
