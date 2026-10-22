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

The candidate work is on `candidate/clarify-autosave-windows`, started from `main` at [`9cbb93849d305369ad060d449cb530f8d3f2a185`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/9cbb93849d305369ad060d449cb530f8d3f2a185); its first commit is [`4a92978697f386d7124e81d463f3a404ac4403fd`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/4a92978697f386d7124e81d463f3a404ac4403fd). A commit cannot name itself, so the candidate's final commit is recorded in [`docs/clarify-candidate/HANDOFF.md`](docs/clarify-candidate/HANDOFF.md), not in this file. <!-- LEAD: once HANDOFF.md is filled, check this sentence still matches reality -->

See [source-provenance.json](source-provenance.json). This repository has independent history: the source commit is provenance, not a local revision to check out here. No personal sessions, credentials, server configuration or conversation exports are included.

The upstream README has been preserved as `README.upstream.md`. Original copyright and licence notices remain intact; see [LICENSE](LICENSE). Source ownership and attribution remain with the respective authors.

## CI is deliberately isolated

Only the dedicated manual workflow is active:

- [`clarify-windows.yml`](.github/workflows/clarify-windows.yml)
- Trigger: `workflow_dispatch` only
- Runner: standard GitHub-hosted `windows-2025` x64
- Purpose: locked toolchain setup, focused tests, Desktop build and the native clarification timeout/recovery scenario
- No live backend, signing secrets, production model accounts, deployment or release publication

Inherited upstream workflows and Dependabot configuration are omitted from the current working tree. Their exact files remain in the initial import commit [`a80ac875d8d87e4316b09e65ef85097dd09d2906`](https://github.com/troyrowe-resource/hermes-clarify-autosave/commit/a80ac875d8d87e4316b09e65ef85097dd09d2906): workflows under `reference/upstream-workflows/`, Dependabot at `.github/dependabot.yml`. Use `git show` to inspect individual historical files when needed; do not restore the upstream automation wholesale. The local PM setup action remains available under `.github/actions/setup-pm`.

One automatic Dependabot update run started during the initial import and failed before its inherited configuration was made inert. That historical run is not a Windows build or an autosave test result; its record is retained.

The seed workflow is preparation for a future run. **Its presence is not evidence that Windows tests have passed.** It is not an installer pipeline. `CLOUD_TASK.md` requires the agent to complete packaging and test the actual candidate artifact after native acceptance. The first manual run on the unmodified candidate branch failed; see Evidence status below.

Standard GitHub-hosted runner compute is free for public repositories under GitHub's published terms. Do not switch to paid larger or third-party runners or change billing settings. Keep run timeouts, concurrency and artifact retention bounded.

## What the candidate changes

- Saves unfinished text and single/multiple-choice selections separately from submitted answers.
- Preserves draft scope across gateway, profile, session, request and question identity.
- Adds backend save, recall and discard RPCs for supported paths.
- Reconciles revisions so older server data cannot overwrite newer edits or cleared values.
- Separately reports device persistence, server-confirmed durability and assistant receipt.
- Provides recovery after timeout without treating a draft as permission or a confirmed answer.
<!-- LEAD: add one bullet per meaningful change made on the candidate branch (for example the Desktop asking the canonical gateway for batch clarify requests, or the compute-host draft relay), each only once it is committed and tested. -->

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

| Stage | Status |
|---|---|
| Baseline Windows run on the unmodified candidate (`4a92978`) | **Failed**: [run 39740118224](https://github.com/troyrowe-resource/hermes-clarify-autosave/actions/runs/39740118224). Toolchain, `npm ci` and the Desktop build succeeded; the selected Python tests ended 234 passed, 2 failed (17 files); the native Playwright spec failed; the isolation check found `%APPDATA%\Hermes` created. A baseline, not a pass |
| Candidate source changes | Not yet recorded <!-- LEAD: one line per meaningful change, with commits --> |
| Linux checks on the candidate commit (Python, Desktop, repository checks, TypeScript, generated contracts) | Not yet recorded <!-- LEAD: real counts and the exact commit, read back from the run or command output --> |
| Native Windows test on the candidate commit | Not yet passed <!-- LEAD: run URL, conclusion, test counts, tested commit --> |
| Windows candidate artifact (packaged with publication disabled) | Not produced <!-- LEAD: artifact name, run URL, SHA-256 of the exact bytes tested --> |
| Packaged bytes tested | Not done <!-- LEAD: how and where --> |
| Production app, server or state | Not touched. Installation is not authorised and has not been done |

The baseline run's detail and every execution path are in [`docs/clarify-candidate/EXECUTION_PATHS.md`](docs/clarify-candidate/EXECUTION_PATHS.md). The final operator handoff will be [`docs/clarify-candidate/HANDOFF.md`](docs/clarify-candidate/HANDOFF.md).

## Known gaps and what is protected where

The server draft channel (`clarify.draft`, `clarify.drafts`, `clarify.drafts.discard`) covers only batch clarify requests, and only on some routes. [`docs/clarify-candidate/EXECUTION_PATHS.md`](docs/clarify-candidate/EXECUTION_PATHS.md) lists every route with file and line evidence and says which claims were only read from code. The middle column is the state at the candidate's first commit (`4a92978`); the last column is where the candidate's own result belongs. A row is "fixed in candidate" only when a commit and a passing test say so.

| Gap | State at `4a92978` | Candidate result |
|---|---|---|
| The Desktop's default local route (the canonical gateway) delivered one clarify card per question, so no server draft was saved: protection was device-only, `clarify.draft` answered `expired`, and the assistant was told nothing about the unsent text | Verified on a native run and in code | Pending <!-- LEAD: fixed in candidate (commit, test, run URL), or disclosed limitation --> |
| Per-question cards stay device-only or unprotected wherever no batch request is made: older backends, a Desktop send path that does not ask for a batch, managed-worker runs, ACP editors, raw WebSocket clients, `api_server` runs and the Ink terminal UI | Device-only or none | Disclosed limitation <!-- LEAD: confirm once the Desktop change is verified --> |
| Compute-host child-owned requests (turn isolation) fell back to device-only; the server draft relay did not exist | Device-only | Pending <!-- LEAD: fixed in candidate (commit, test), or disclosed limitation --> |
| Draft cleanup is wired only to the legacy `session.delete` RPC, which only the Ink terminal UI's picker calls. Deleting from the Desktop, dashboard, CLI, bulk prune or automatic prune leaves server drafts on disk | Verified in code | Disclosed limitation <!-- LEAD: or fixed in candidate, naming the seam used --> |
| Profile rename does not migrate device draft copies (they are stranded); server copies follow the renamed directory. Profile delete leaves device copies. Profile clone and export carry unsent drafts | Verified in code | Disclosed limitation |
| A crashed or killed turn leaves a durable draft without a terminal transcript result, and no screen offers to recall it | Verified by probe and code | Disclosed limitation |
| Drafts have no retention timer and no cap on file count | Verified in code | Disclosed limitation |
| On the session owner route an open batch card and its server drafts are not replayed after a reconnect or restart | Read from code | Pending <!-- LEAD: fixed in candidate (commit, test, native reconnect run) or disclosed limitation --> |
| Windows: POSIX file modes are not enforced and directories are not fsynced; the baseline run's restart test failed on its `0600` assertion | Observed in the baseline run | Disclosed limitation <!-- LEAD: say what happened to the failing assertion --> |
| Windows CI is not proof of compatibility with a particular installed app, laptop configuration or live server route | Always true | Always true |

Do not hide these behind passing unit-test totals. Fix within the candidate where feasible and retain a precise remaining-gap report.

## Safety and release boundary

This repository is for code, isolated tests and candidate artifacts. Do not install over a working Hermes app, replace its updater, alter a real `hermes://` handler, copy real homes or credentials into fixtures, connect tests to production, or weaken security controls.

Use the existing sandbox fixture in `apps/desktop/e2e/fixtures.ts`, including separate homes/user data, unique app identity, ignored existing installation, isolated backend and disabled protocol registration. Package only with publication disabled explicitly, for example the current builder wrapper's `--publish never` option. An unsigned/private candidate is not a Nous-signed release.

A later production rollout needs separately authorised client/backend compatibility checks, backup/rollback and a final smoke test on the intended Windows machine.

## References

- [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude cloud environments and GitHub access](https://code.claude.com/docs/en/cloud-environments)
- [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
