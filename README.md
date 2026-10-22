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

The seed workflow is preparation for a future run. **Its presence is not evidence that Windows tests have passed.** It is not an installer pipeline. `CLOUD_TASK.md` requires the agent to complete packaging and test the actual candidate artifact after native acceptance.

Standard GitHub-hosted runner compute is free for public repositories under GitHub's published terms. Do not switch to paid larger or third-party runners or change billing settings. Keep run timeouts, concurrency and artifact retention bounded.

## What the candidate changes

- Saves unfinished text and single/multiple-choice selections separately from submitted answers.
- Preserves draft scope across gateway, profile, session, request and question identity.
- Adds backend save, recall and discard RPCs for supported paths.
- Reconciles revisions so older server data cannot overwrite newer edits or cleared values.
- Separately reports device persistence, server-confirmed durability and assistant receipt.
- Provides recovery after timeout without treating a draft as permission or a confirmed answer.

**Confirm remains the submission action.** A timeout must not silently submit a draft, and a failed write must not be labelled saved.

## Evidence status at repository creation

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

## Known gaps to address or disclose

- Compute-host child-owned sidecar requests currently fall back to device-only draft protection; their server draft relay is not implemented.
- The new server draft channel is for supported Desktop batch flows, not every per-question messaging card.
- Draft cleanup is wired to the relevant sidecar session-delete path, not all possible CLI/dashboard/bulk deletion routes.
- Profile rename/move does not migrate device draft copies.
- A crashed turn can leave a durable draft without a terminal transcript result; explicit recall is separate.
- Windows CI is not proof of compatibility with a particular installed app, laptop configuration or live server route.

Do not hide these behind passing unit-test totals. Fix within the candidate where feasible and retain a precise remaining-gap report.

## Safety and release boundary

This repository is for code, isolated tests and candidate artifacts. Do not install over a working Hermes app, replace its updater, alter a real `hermes://` handler, copy real homes or credentials into fixtures, connect tests to production, or weaken security controls.

Use the existing sandbox fixture in `apps/desktop/e2e/fixtures.ts`, including separate homes/user data, unique app identity, ignored existing installation, isolated backend and disabled protocol registration. Package only with publication disabled explicitly, for example the current builder wrapper's `--publish never` option. An unsigned/private candidate is not a Nous-signed release.

A later production rollout needs separately authorised client/backend compatibility checks, backup/rollback and a final smoke test on the intended Windows machine.

## References

- [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude cloud environments and GitHub access](https://code.claude.com/docs/en/cloud-environments)
- [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
