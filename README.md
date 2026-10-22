# Hermes clarify autosave - cloud and Windows test candidate

This is an **independent experimental build-and-test repository**, not an official Hermes release. It contains the complete public Hermes source with a clarification-draft preservation candidate already implemented, so a Claude Code cloud session can work here without requiring a development setup on a user's laptop.

**Repository:** https://github.com/troyrowe-resource/hermes-clarify-autosave  
**Cloud task:** [CLOUD_TASK.md](CLOUD_TASK.md)  
**Original project documentation:** [README.upstream.md](README.upstream.md)

## Start in Claude Code cloud

1. Connect this repository at [claude.ai/code](https://claude.ai/code). Grant access to this repository only; no production credentials are required.
2. Start from `main` and ask Claude to read and execute **CLOUD_TASK.md**. It requires aggressive useful parallel delegation, Sonnet 5.5 at maximum supported reasoning where actually available, autonomous completion, and one upfront pass for missing approvals.
3. Claude should create a dedicated candidate branch, run Linux-compatible checks in its cloud VM, and use the manual GitHub Actions workflow for native Windows work.
4. Require real Windows run URLs and a verified artifact before accepting completion. Keep installation and production deployment separate.

Claude's standard hosted VM is Ubuntu, not Windows. The Windows runner is a separate GitHub Actions machine. Current Claude cloud GitHub operations use the existing connection/proxy; REST operations through `gh api` are supported, while GraphQL commands may be restricted. Do not expose a token or introduce production secrets to work around a missing capability.

## Source provenance

The imported source is the complete snapshot of:

- Source repository: [`troyrowe-resource/hermes-agent`](https://github.com/troyrowe-resource/hermes-agent)
- Feature branch: `fix/clarify-draft-preservation-20261022`
- Source commit: [`b6a1a4e36fab77a974943e95e9e8ce224a8de632`](https://github.com/troyrowe-resource/hermes-agent/commit/b6a1a4e36fab77a974943e95e9e8ce224a8de632)
- Upstream base: `4e58c721c8cf9b51c46636ea84ea6a5cb540880a` from `NousResearch/hermes-agent`

The candidate work is on `candidate/clarify-autosave-windows`, started from `main` at [`9cbb93849d305369ad060d449cb530f8d3f2a185`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/9cbb93849d305369ad060d449cb530f8d3f2a185); its first commit is [`4a92978697f386d7124e81d463f3a404ac4403fd`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/4a92978697f386d7124e81d463f3a404ac4403fd). The commit the acceptance Actions run executed against (the tested commit) is `{{RUN7_COMMIT}}`; the final commit differs from it by documentation only. A commit cannot name itself, so neither this file nor [`docs/clarify-candidate/HANDOFF.md`](docs/clarify-candidate/HANDOFF.md) records the SHA of the commit that contains it: read the final commit from the branch head.

See [source-provenance.json](source-provenance.json). This repository has independent history: the source commit is provenance, not a local revision to check out here. No personal sessions, credentials, server configuration or conversation exports are included.

The upstream README has been preserved as `README.upstream.md`. Original copyright and licence notices remain intact; see [LICENSE](LICENSE). Source ownership and attribution remain with the respective authors.

## CI is deliberately isolated

Only the dedicated manual workflow is active:

- [`clarify-windows.yml`](.github/workflows/clarify-windows.yml)
- Trigger: `workflow_dispatch` only, with `permissions: contents: read`, no secrets, one run per branch at a time, every job capped at 60 minutes and artifact retention of 7 days
- Runners: standard GitHub-hosted `windows-2025` x64 for the Windows jobs, and `ubuntu-24.04` (under xvfb) for the compute-host job
- Purpose: locked toolchain setup, focused tests, Desktop build, the native clarification timeout and recovery scenarios, and an unsigned private test package that is itself tested
- No live backend, signing secrets, production model accounts, deployment or release publication

The jobs, in order:

1. **Launcher self-test** on Windows PowerShell 5.1 and 7.
2. **Windows native**: locked toolchain (`setup-pm`), `npm ci`, Desktop build, 29 Python test files (including every `test_*clarify*draft*` file), the generated-contract check, Electron identity and deep-link unit tests, isolation sentinels before and after, the 7 native Playwright specs plus `batch-clarify.spec.ts` with one worker and `--retries=0`, then evidence verification.
3. **Linux compute-host** (`ubuntu-24.04`, xvfb): the compute-host Python tests, including a real child process, and the native compute-host spec.
4. **Package**, only after the three jobs above pass: a one-commit bundled build (`scripts/bundles/desktop.py`), electron-builder with `--publish never` and no signing variables, an audit of the app's identity, stamp and bundle environment, then a zip with `MANIFEST.json` and `SHA256SUMS.txt`.
5. **Accept**: downloads the uploaded zip, checks its digest against the package job's output and every file against `MANIFEST.json`, extracts it, runs `clarify-drafts-packaged.spec.ts` through the shipped launcher with decoy `HERMES_HOME`, `HERMES_DESKTOP_HERMES_ROOT`, `PYTHON` and `PYTHONPATH` exported, then runs `clarify-drafts-packaged-direct.spec.ts`, which starts the exe with no launcher. Strict isolation sentinels and a verdict close the job.

The package carries a launcher (`Start-` and `Stop-HermesClarifyCandidate.cmd`, with PowerShell scripts). It runs the app in a sandbox under `%LOCALAPPDATA%\HermesClarifyCandidate`: its own `HERMES_HOME`, Electron user data (through the environment and `--user-data-dir`), `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `HERMES_GATEWAY_LOCK_DIR` and assistant workspace, with protocol registration skipped, any installed Hermes ignored and the backend isolated. It refuses a sandbox root that equals, sits inside or contains a real Hermes location (junctions and `subst` drives are resolved), and refuses an exe whose SHA-256 differs from `MANIFEST.json`. Stop never prompts (`gateway stop --yes` with stdin NUL), always sweeps the processes running from the package, and leaves unrelated processes of the same name alone.

Defender: the package job adds Microsoft Defender scan exclusions for its two build roots only. The workflow does not change real-time monitoring, and the accept job leaves Defender untouched.

Inherited upstream workflows and Dependabot configuration are omitted from the current working tree. Their exact files remain in the initial import commit [`a80ac875d8d87e4316b09e65ef85097dd09d2906`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/a80ac875d8d87e4316b09e65ef85097dd09d2906): workflows under `reference/upstream-workflows/`, Dependabot at `.github/dependabot.yml`. Use `git show` to inspect individual historical files when needed; do not restore the upstream automation wholesale. The local PM setup action remains available under `.github/actions/setup-pm`.

One automatic Dependabot update run started during the initial import and failed before its inherited configuration was made inert. That historical run is not a Windows build or an autosave test result; its record is retained.

**The workflow's presence is not evidence that Windows tests have passed; the run records under Evidence status are.** It is not an installer pipeline: it builds a private, unsigned zip for testing, publishes nothing and creates no GitHub Release. The first manual run, on the unmodified candidate branch, failed; see Evidence status below.

Standard GitHub-hosted runner compute is free for public repositories under GitHub's published terms. Do not switch to paid larger or third-party runners or change billing settings. Keep run timeouts, concurrency and artifact retention bounded.

## What the candidate changes

The feature the source snapshot carries:

- Saves unfinished text and single/multiple-choice selections separately from submitted answers.
- Preserves draft scope across gateway, profile, session, request and question identity.
- Adds backend save, recall and discard RPCs for supported paths.
- Reconciles revisions so older server data cannot overwrite newer edits or cleared values.
- Separately reports device persistence, server-confirmed durability and assistant receipt.
- Provides recovery after timeout without treating a draft as permission or a confirmed answer.

Ten meaningful changes were made on the candidate branch after `4a92978`. File lists are in [`docs/clarify-candidate/HANDOFF.md`](docs/clarify-candidate/HANDOFF.md); the evidence for each is under Evidence status below.

1. **The Desktop asks the canonical gateway for one batch clarify request** (`clarify_batch: true` on `prompt.submit`), so a multi-question clarify reaches the server's draft store. It is gated: it goes only to canonical owners, never to a legacy `hermes serve` sidecar (which rejects unknown keys). An older canonical gateway that refuses it gets one resend without the flag under the same submission id, and is remembered as unsupported for 10 minutes. Edit, Regenerate and Restore offer it only to owners that already accepted it in this app run, because a rewind cannot be safely re-sent.
2. **The canonical gateway replays an open batch clarify** (questions, locked answers, and drafts with their revisions) in `session.resume` and `session.events.since`, to a viewer entitled exactly like `clarify.lock`. Settled, cancelled and timed-out requests never reappear.
3. **A clarify timeout shows one settled card, not two.**
4. **"Show drafts saved on the server" and "Discard drafts" survive the settled card's remount** when the stored transcript replaces the live message at turn end. Windows run 39761924192 found this.
5. **Renderer robustness.** Edits made offline are re-sent when the open request is redelivered; an `expired` reply from a socket that is not yet attached no longer closes saving for good; "method not found" memos lapse after 10 minutes; a cleared draft is re-sent, so deleted text is never reported to the assistant; a late acknowledgement for an older revision cannot overwrite a newer one.
6. **A compute-host relay** (turn isolation). `clarify.draft` and `clarify.drafts.discard` reach the child process that owns the request, with the same entitlement and statuses. The parent's mirror replays drafts on reconnect, and a crashed or wedged child answers error 5019, never `ok` with `durable: true`. The child writes under the same draft scope, so the parent's recall still works after the child exits. This is a POSIX feature; see Known gaps.
7. **Draft store hardening.** Directories are created through `make_user_dir` (the Windows elevated-ACL hazard) and files are written through `atomic_replace`. A save for a deleted named profile is `durable: false` and never recreates the profile. Text or choices that cannot be encoded as UTF-8 are refused with `invalid_params`, and a model-authored question containing a lone surrogate can no longer break save, lock or settle. Persistence problems never raise (the answer is `durable: false`), and a purge also removes `.draft-*.tmp` residue. `settle_batch` ignores `drafts*` keys that a client supplies.
8. **Server drafts are purged when a session is deleted**, at the central `emit_session_deleted` seam, for every reason except `archive` (delete, empty sweep, prune, ghost prune and profile repair; the canonical Desktop delete included), per profile home, failing open.
9. **`hermes profile create --clone-all` no longer copies `clarify_drafts`**, which held orphaned unsent text.
10. **Desktop isolation.** The Electron user-data location is decided before any module can read it, which fixes the baseline run's creation of `%APPDATA%\Hermes`. A commit build never registers the OS `hermes://` handler, and gives its backend `HERMES_GATEWAY_LOCK_DIR=<its own HERMES_HOME>/gateway-locks` unless one is set, so it never shares the per-user gateway rendezvous with an installed Hermes. Stable, channel, CI and dev builds are unchanged.

Beyond these product changes the candidate adds the CI and packaging described above, and the documents in `docs/clarify-candidate/`.

**Confirm remains the submission action.** A timeout must not silently submit a draft, and a failed write must not be labelled saved.

## Evidence status

Stages are kept apart on purpose. Source written, workflow created, build passed, native test passed, artifact uploaded and production installed are different facts, and each is recorded only when it has happened.

### At repository creation (historical)

| Check | Status |
|---|---|
| Originating Linux Python tests | 212 passed across 16 selected files |
| Originating Desktop tests | 797 passed across 43 files |
| Originating repository checks | All 12 passed |
| Renderer TypeScript, generated contracts and formatting | Passed on the originating candidate |
| Native Linux Electron timeout scenario | Blocked before the app opened a window |
| Native Windows test | Not run at repository creation |
| Verified downloadable Windows candidate | Not produced at repository creation |
| Production app/server deployment | Not authorised or performed |

The originating counts are historical context, not proof for later commits or this repository's new CI workflow. Record the exact commit and run outcome for every new verification.

### On the candidate branch (`candidate/clarify-autosave-windows`)

Verdict recorded in the final handoff: **{{VERDICT}}**. Basis: {{VERDICT_BASIS}}

| Stage | Status |
|---|---|
| Baseline Windows run on the unmodified candidate (`4a92978`) | **Failed**: [run 39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224). Toolchain, `npm ci` and the Desktop build succeeded; the selected Python tests ended 234 passed, 2 failed (17 files); the native Playwright spec failed; the isolation check found `%APPDATA%\Hermes` created. A baseline, not a pass |
| Candidate source changes | Written and committed: the ten changes above, between `4a92978` and `{{RUN7_COMMIT}}`. Many intermediate commits are labelled `wip: checkpoint`, because the session's stop hook required a clean tree while five workers edited; some of those skipped the pre-commit lint and say so in their message. Every validated commit after them passed the repository hooks, and `python scripts/check --base 4a929786` reported "12 checks, ok" on `b770aeda` (12:39Z), with code health at 0 blocking |
| Linux checks on the candidate commit (Python, Desktop, repository checks, TypeScript, generated contracts) | Run by the lead on a clean tree at `ae1a547e`, which differs from `e7dc1f9b` only by a comment line in `hermes_cli/profiles.py` and the workflow's prepare timeout: Python 30 files, 436 passed, 0 failed, 1 skipped (the Windows-only arm); generated contracts current; `npm run typecheck` (4 stages) exit 0; renderer vitest 51 files, 622 passed; Electron and e2e-unit vitest 8 files, 84 passed. `scripts/check` failed there only on code health for `profiles.py` (2462 lines against a limit of 2460, from a comment) and passed on `b770aeda` |
| Native Windows test on the candidate commit | Passed on `b770aeda` in [run 39780275912](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39780275912): 19 expected, 0 unexpected, 0 skipped, 0 flaky, evidence verdict passed; Python 29 files, 428 passed, 0 failed, 7 skipped (POSIX-only). That run's package job failed, so it is not a green run. Acceptance run [{{RUN7_ID}}]({{RUN7_URL}}) on `{{RUN7_COMMIT}}`: Windows native {{RUN7_NATIVE}} |
| Windows candidate artifact (packaged with publication disabled) | Package job in run {{RUN7_ID}}: {{RUN7_PACKAGE}}. Artifact {{ARTIFACT_NAME}} ({{ARTIFACT_URL}}), zip SHA-256 `{{ZIP_SHA256}}`, upload digest `{{ARTIFACT_DIGEST}}`. Unsigned: not Nous-signed and not a verified installer |
| Packaged bytes tested | Accept job in run {{RUN7_ID}}: {{RUN7_ACCEPT}}. Exe SHA-256 `{{EXE_SHA256}}`; downloaded copy re-hashed: {{REHASH}} |
| Production app, server or state | Not touched. Installation is not authorised and has not been done |

Every Windows run on the candidate branch, from the numbers the lead read back from the run artifacts (all on standard `windows-2025` x64):

| Run | Commit | Result |
|---|---|---|
| [39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224) (baseline) | `4a92978` | Failure. Python 234 passed, 2 failed (Windows-only: a POSIX `0600` assertion; `SYSTEMROOT` missing in a child environment). Native seed spec failed: one card per question, because the Desktop never asked for a batch. Isolation failed (`%APPDATA%\Hermes` created) |
| [39751372320](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39751372320) (discovery, stage native) | `fae57e6c` (work in progress) | Failure. Python 395 passed, 0 failed; launcher self-test passed; isolation passed; native 15 passed, 1 failed (restart: an 8.3 short path against the canonical gateway's lock path), 3 skipped (compute-host not supported on Windows) |
| [39761924192](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39761924192) (full) | `49d95c0d` | Failure. Launcher passed; Linux compute-host 2/2; Windows Python passed; native 17 passed, 1 failed (recall lost when the settled card remounted at turn end: a real bug, fixed), 1 serial skip; package skipped by its gate |
| [39768307967](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39768307967) (stage native) | `6a082a14` | Failure only in the launcher job (PowerShell 5.1: a UTF-8 preamble reached the gateway CLI's stdin, a real bug fixed with stdin NUL). Windows native 19/19, 0 skipped, 0 flaky; Python 28 files, 427 passed, 0 failed, 7 skipped (POSIX-only); Linux compute-host passed |
| [39779280926](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39779280926) | `ae1a547e` | Cancelled by the lead: superseded by a one-line code-health fix |
| [39780275912](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39780275912) (full) | `b770aeda` | Launcher passed on PowerShell 5.1 and 7; Windows native 19 expected, 0 unexpected, 0 skipped, 0 flaky; Windows Python 29 files, 428 passed, 0 failed, 7 skipped (POSIX-only); Linux compute-host native 2/2 and Python passed; isolation passed. **Package failed**: its bundled prepare step timed out at the 25-minute cap on a cold dependency cache (`npm ci` about 9.5 minutes, tools about 3.5, all-extras venv about 8); the budget was raised to 38 minutes in `e7dc1f9b` |
| [{{RUN7_ID}}]({{RUN7_URL}}) (full) | `{{RUN7_COMMIT}}` | Windows native: {{RUN7_NATIVE}}. Package: {{RUN7_PACKAGE}}. Accept: {{RUN7_ACCEPT}} |

The baseline run's detail and every execution path are in [`docs/clarify-candidate/EXECUTION_PATHS.md`](docs/clarify-candidate/EXECUTION_PATHS.md). The final operator handoff is [`docs/clarify-candidate/HANDOFF.md`](docs/clarify-candidate/HANDOFF.md).

## Known gaps and what is protected where

The server draft channel (`clarify.draft`, `clarify.drafts`, `clarify.drafts.discard`) covers only batch clarify requests, and only on some routes. [`docs/clarify-candidate/EXECUTION_PATHS.md`](docs/clarify-candidate/EXECUTION_PATHS.md) lists every route with file and line evidence at the base commit, says which claims were only read from code, and gives each route's result after the candidate. The middle column below is the state at the candidate's first commit (`4a92978`); the last column is the candidate's own result, with the run or test that supports it. A row is "fixed in candidate" only when a commit and a passing test say so.

| Gap | State at `4a92978` | Candidate result |
|---|---|---|
| The Desktop's default local route (the canonical gateway) delivered one clarify card per question, so no server draft was saved: protection was device-only, `clarify.draft` answered `expired`, and the assistant was told nothing about the unsent text | Verified on a native run and in code | **Fixed in candidate.** The Desktop asks the canonical gateway for a batch request, so drafts are saved on the server and the assistant is told they were not submitted. Native Windows 19/19 in runs 39768307967 and 39780275912 (seed, mixed, failure, reconnect and restart specs), plus gateway tests |
| Per-question cards stay device-only or unprotected wherever no batch request is made: older backends, a Desktop send path that does not ask for a batch, managed-worker runs, ACP editors, raw WebSocket clients, `api_server` runs and the Ink terminal UI | Device-only or none | **Disclosed limitation, unchanged.** Still device-only on the Desktop or unprotected elsewhere: ACP editors, raw WebSocket clients, `api_server` runs, managed workers, an older canonical gateway that refuses `clarify_batch`, and a rewind (Edit, Regenerate, Restore) that is the first action after app launch. The Ink terminal UI and dashboard `/chat` have no draft code; the classic CLI asks for batches but never sends drafts; messaging cards are not applicable; the `hermes-bots` plugin's submit paths are untouched |
| Compute-host child-owned requests (turn isolation) fell back to device-only; the server draft relay did not exist | Device-only | **Fixed in candidate on POSIX.** The relay reaches the child that owns the request: Linux job 2/2 native plus real-child Python tests. **Not supported in practice on Windows**: `tui_gateway/host_supervisor.py` calls `os.kill(pid, 0)` (which sends `CTRL_C_EVENT` on Windows), refers to `signal.SIGKILL` (missing there) and relies on `/proc` and `ps` lookups. The Windows Desktop's local route never reaches the compute host |
| Draft cleanup is wired only to the legacy `session.delete` RPC, which only the Ink terminal UI's picker calls. Deleting from the Desktop, dashboard, CLI, bulk prune or automatic prune leaves server drafts on disk | Verified in code | **Fixed in candidate.** Server drafts are purged at the central `emit_session_deleted` seam for every reason except `archive` (delete, empty sweep, prune, ghost prune, profile repair; the canonical Desktop delete included), per profile home, failing open. Recalled and discarded card states live in renderer memory and are not pruned when a conversation is deleted |
| Profile rename does not migrate device draft copies (they are stranded); server copies follow the renamed directory. Profile delete leaves device copies. Profile clone and export carry unsent drafts | Verified in code | **Partly fixed.** `hermes profile create --clone-all` no longer copies `clarify_drafts`. **Disclosed limitation:** rename still strands device copies, delete still leaves them, and `hermes profile export` still carries `clarify_drafts` |
| A crashed or killed turn leaves a durable draft without a terminal transcript result, and no screen offers to recall it | Verified by probe and code | **Disclosed limitation.** A killed or crashed turn leaves a durable draft with outcome null, and no screen offers recall |
| Drafts have no retention timer and no cap on file count | Verified in code | **Disclosed limitation.** Still no timer and no cap; recall lists the newest 50; device copies never expire |
| On the session owner route an open batch card and its server drafts are not replayed after a reconnect or restart | Read from code | **Fixed in candidate.** The canonical gateway replays an open batch clarify, with its locked answers and drafts, in `session.resume` and `session.events.since`. The native reconnect and restart specs passed in runs 39768307967 and 39780275912 |
| Windows: POSIX file modes are not enforced and directories are not fsynced; the baseline run's restart test failed on its `0600` assertion | Observed in the baseline run | **Disclosed limitation, with repairs.** Directories now go through `make_user_dir` and files are written through `atomic_replace`; privacy on Windows rests on the user directory's ACL, and directory fsync is not possible there. The baseline's two Python failures (the `0600` assertion and a missing `SYSTEMROOT` in a child environment) do not recur: Python 0 failed in every later Windows run. POSIX-only tests are marked `platforms('posix')` and skipped on Windows (7 skipped in runs 39768307967 and 39780275912) |
| Sidecar context compression rotates the session key | Verified in code | **Disclosed limitation.** Drafts saved under the old key drop out of recall; deleting the conversation still purges every segment |
| Starting the candidate exe directly, without the launcher | No package existed at the base | **Disclosed limitation.** The app uses the real profile as the assistant's working folder and leaves empty `%APPDATA%\HermesBundledCommit<sha7>` folders. It never touches `%APPDATA%\Hermes`, the `hermes://` handler or the per-user gateway rendezvous. Start it through the launcher |
| The session owner's `clarify.draft` does its store I/O on the gateway event loop | Not examined at the base | **Disclosed limitation.** Measured median 1.8 ms, p95 3.4 ms, max 6.7 ms |
| Windows CI is not proof of compatibility with a particular installed app, laptop configuration or live server route | Always true | Always true. CI on a clean GitHub runner does not prove compatibility with a laptop, an installed app, a live server connection or an update mechanism |

Do not hide these behind passing unit-test totals. Fix within the candidate where feasible and retain a precise remaining-gap report.

## Safety and release boundary

This repository is for code, isolated tests and candidate artifacts. Do not install over a working Hermes app, replace its updater, alter a real `hermes://` handler, copy real homes or credentials into fixtures, connect tests to production, or weaken security controls.

Use the existing sandbox fixture in `apps/desktop/e2e/fixtures.ts`, including separate homes/user data, unique app identity, ignored existing installation, isolated backend and disabled protocol registration. Package only with publication disabled explicitly, for example the current builder wrapper's `--publish never` option. An unsigned/private candidate is not a Nous-signed release.

What has and has not been touched, as recorded in the final handoff: every completed Windows run since the isolation fix compared sentinels before and after (`%APPDATA%\Hermes*`, `%LOCALAPPDATA%\hermes*`, `%USERPROFILE%\.hermes*`, `%USERPROFILE%\.local\state\hermes*` and `HKCU\Software\Classes\hermes[-dev]`) and found them unchanged. No GitHub Release or package has been published, no billing, permission, secret or repository setting was changed, and only standard GitHub-hosted runners were used. No agent contacted a live Hermes server, an installed app, an updater or production data, and no certificate was used or installed: the artifacts are unsigned.

A later production rollout needs separately authorised client/backend compatibility checks, backup/rollback and a final smoke test on the intended Windows machine.

## References

- [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude cloud environments and GitHub access](https://code.claude.com/docs/en/cloud-environments)
- [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
