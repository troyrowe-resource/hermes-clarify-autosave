# Claude Code cloud task: finish and prove Windows clarify autosave

Work in **https://github.com/troyrowe-resource/hermes-clarify-autosave**. Use Claude Code cloud and this repository's GitHub Actions, not my laptop, for development, Windows builds and automated verification.

## Objective and starting point

Produce a genuinely tested, separately runnable Windows candidate that preserves unfinished Hermes clarification text and single/multiple-choice selections through timeout, reconnect and restart. Confirm must remain the only submission action. Keep my installed app and live backend unchanged.

This repository contains the complete public Hermes source snapshot with the autosave implementation already present. Its provenance is `source-provenance.json`: source commit `b6a1a4e36fab77a974943e95e9e8ce224a8de632` from `troyrowe-resource/hermes-agent`, branch `fix/clarify-draft-preservation-20261022`. That is a provenance reference, not a commit you should expect in this new repository's independent history. Start from this repository's `main`, record its actual commit, then create a dedicated candidate branch. Do not unnecessarily clone or modify another repository.

Read `README.md`, `source-provenance.json`, the relevant repository `AGENTS.md` files and `CONTRIBUTING.md` first. `README.upstream.md` preserves the upstream README. The inherited upstream workflows are deliberately inert under `reference/upstream-workflows/`; do not reactivate that suite.

## Mandatory parallel delegation

**Parallel delegation is a requirement, not an optional enhancement. Do not carry out independent work serially just because you can do it yourself.** Use as many useful parallel sub-agents as the actual environment and account limits support. Maximise verified throughput, not agent count.

At the outset, split the work into concurrently executable streams, for example:
- Windows CI, dependency preparation and packaging.
- Desktop draft recovery and native UI acceptance.
- Backend persistence, replay and the known execution-path gap.
- Regression tests, failure cases and isolation checks.
- Documentation, artifact provenance and the final operator handoff.

Give each stream clear file ownership and interfaces, use separate worktrees where needed, and integrate changes deliberately. Do not allow simultaneous edits to the same files or run competing environment installations. Use scripts for mechanical fan-out rather than spawning an LLM for each trivial command. Keep independent useful work moving when another stream is waiting for CI or approval.

**Use Sonnet 5.5 at maximum reasoning for suitable parallel workers if that exact model and effort level are actually available.** Verify the supported model/effort options rather than inventing identifiers or claiming a clamped setting is active. If unavailable, state the limitation once, choose the strongest suitable available Sonnet and its highest supported effort, and continue. Do not stall the task on an unavailable model. The lead retains responsibility for architecture, integration and checking the agents' actual outputs. Do not claim agents ran unless they really did.

## Autonomy and approvals up front

**Do as much of the work autonomously as possible, through real execution and verification. Do not stop at a plan, workflow file or untested build.** Fix ordinary build/test failures, read the resulting logs, and rerun the affected checks without asking me to relay commands or debug errors.

Perform one short, read-only capability preflight, then batch every genuinely missing approval or setup requirement into one upfront request. In particular, establish that Claude can access this repository, push its candidate branch, modify the dedicated workflow when necessary, dispatch Actions and read logs/artifacts. Ask me only for capabilities or decisions that cannot be resolved with your tools. Do not re-ask permissions already granted below.

Within this task I authorise candidate-only source/test/documentation changes, commits and pushes to a new branch in this repository, and bounded manual CI runs on standard GitHub-hosted runners. Linux jobs and a standard `windows-2025` x64 job are acceptable. Keep a single active Windows run per candidate branch, a maximum 60-minute job timeout and short artifact retention. Cancel only obsolete runs belonging to this task. Use no paid larger/third-party runners and change no billing settings.

This is a public repository: commit and upload only public source and synthetic test evidence. Do not include personal data, production configurations, credentials or our conversation. Do not fetch production credentials or add model-account secrets to CI; the native test uses a synthetic inference server.

Not authorised: modifying `NousResearch/hermes-agent`, closing or merging existing PRs, changing repository permissions or GitHub limits, replacing my installed app/updater, accessing or restarting the live server, altering production state, installing certificates on my laptop, weakening security controls, or publishing a GitHub Release/package as an official Hermes build. Unexpected work requiring those powers must stop at that boundary for approval while independent safe work continues.

## Cloud and GitHub execution model

Anthropic-hosted Claude Code cloud normally runs Ubuntu x86_64. It can implement changes and run Linux-compatible checks; **it is not a Windows test host**. Run native Windows builds, Electron execution and recovery tests through GitHub Actions in this repository.

A manual seed workflow is supplied at `.github/workflows/clarify-windows.yml`. Inspect it before dispatch and improve it only within this task. Do not substitute upstream's Blacksmith/private runner labels for standard hosted Windows runners. No native success is claimed for this seed until a real run proves it.

Use your existing Claude/GitHub connection. Current cloud environments support REST operations through `gh api`; GraphQL-based commands such as `gh pr` may be blocked. Use supported REST/Actions commands instead of repeatedly retrying GraphQL. Do not print, copy or invent credentials. If the GitHub connection lacks an essential capability, request the specific approval up front rather than attempting to evade the restriction.

## Work to complete

1. Verify the source and prepare locked dependencies using the repository's PM workflow and root `npm ci`. Preserve lockfiles unless a demonstrated defect requires a narrow, documented change.
2. Run relevant Linux checks while the Windows stream is being prepared. Use canonical `scripts/run_tests.sh`, generated-contract checks, renderer type checking and focused Desktop tests. Bind results to the exact candidate commit.
3. Run the real native scenario `apps/desktop/e2e/clarify-drafts-native.spec.ts` on Windows. Preserve its assertions. The existing fixture supplies a disposable home, isolated backend, separate Desktop user data, unique app identity and disabled protocol registration. Verify those boundaries before launching.
4. Extend and run acceptance for exact multiline text, single and multiple selections, edits/deselections, timeout without Confirm, reconnect, app restart, fresh-backend recall, explicit discard, scope separation and failed persistence. Saving or recalling a draft must never submit it or grant approval. Do not hide failing tests with retries, skips or relaxed assertions.
5. Identify and exercise the execution paths actually supported. The known compute-host child-owned sidecar path currently does not relay draft saves and falls back to device-only protection. Repair that gap within the candidate where feasible and test it; otherwise disclose precisely what remains unsupported. Do not label device-only saving as server durability.
6. After native checks pass, produce a Windows candidate artifact with a safe isolated launcher and all required dependencies or an explicit verified dependency arrangement. Disable packaging publication explicitly with `--publish never`; do not rely on provider defaults. Test the exact packaged bytes, not only the development source. A thin app that silently starts an official backend lacking the new RPCs is not proof of full autosave. Record the source commit, checksum, runtime requirements and signing status. Do not claim Nous signing or a verified installer when neither exists.
7. Upload the bounded candidate artifact, test reports, screenshots/traces and a concise manifest as Actions artifacts. Retain failure evidence. Read back the exact run conclusion and artifact listing, and verify downloaded artifact integrity when your tools permit.

## Existing evidence and limits

The originating Linux candidate passed 212 Python tests, 797 Desktop tests, all 12 repository checks, renderer TypeScript, generated-contract and formatting checks. Those results are historical context, not proof for your new commits or Windows.

An earlier Linux Electron test crashed before opening a window. It did not exercise the timeout scenario. Do not infer Windows failure from it or call it a passed native test.

The existing feature has additional limits around non-batch messaging cards, profile rename/move and deletion paths outside the wired sidecar RPC. Preserve isolation and report relevant remaining gaps rather than claiming universal coverage.

A successful CI run does not prove compatibility with my particular laptop, production server connection or installed update mechanism. The final local smoke test and any live deployment remain separate, later approvals. This task should reduce that last step to downloading and testing a verified candidate, not building everything on my laptop.

## Finish and reporting

Continue through implementation, CI, ordinary repairs, packaging and verification until complete or a genuine external boundary blocks you. Use progress-based diagnosis; do not leave an indefinite polling loop or keep rerunning an unchanged failure. If a loop stops making progress, switch approach or explain the concrete blocker rather than claiming success.

For substantive progress updates give an estimated completion percentage and ETA, issues since the previous update, and whether more useful parallel workers could shorten the remaining work. Label estimates and distinguish implementation from CI/integration verification.

Return a concise, copy-ready final handoff containing:
- `WINDOWS CANDIDATE VERIFIED` or `BLOCKED`, with the precise basis.
- Repository branch, exact commit and meaningful changes.
- Actual agents/models/effort levels used and their completed workstreams.
- GitHub Actions run URLs and real test counts/results.
- Tested backend paths and residual limitations.
- Artifact links, checksums, runtime prerequisites and signing status.
- Evidence that no production app, server or state was changed.
- One next action for me, if needed.

Never equate source written, workflow created, build passed, native test passed, artifact uploaded and production installed. Report each stage truthfully.
