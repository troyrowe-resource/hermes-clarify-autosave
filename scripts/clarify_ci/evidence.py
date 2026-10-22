"""Evidence helpers for .github/workflows/clarify-windows.yml (stdlib only).

Each subcommand does one bounded job and exits non-zero when its claim does not hold:

  metadata   allowlisted run/source facts (never the raw environment)
  stage      create an empty, owned evidence directory (refuses a non-empty one)
  guard      the E2E fixture still sets every isolation flag this workflow relies on
  sentinels  record which real-install locations exist (default homes, protocol keys)
  isolation  fail if a sentinel absent before the native run exists after it
  verify     native evidence + Playwright JSON prove one passing, unretried run
  collect    copy known evidence files into a size-capped artifact directory
  gate       write the step summary from real step outcomes; fail unless all succeeded
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

NATIVE_SPEC = "clarify-drafts-native.spec.ts"
NATIVE_SCREENSHOTS = ("native-01-live-card.png", "native-02-timed-out-card.png", "native-03-recalled.png")
NATIVE_OBSERVATIONS = "native-observations.json"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

METADATA_ENV = (
    "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW", "GITHUB_EVENT_NAME", "GITHUB_SERVER_URL",
    "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
)

# The sandbox flags apps/desktop/e2e/fixtures.ts buildAppEnv() must keep setting.
FIXTURE_FLAGS = {
    "HERMES_HOME": r"HERMES_HOME:\s*sandbox\.hermesHome",
    "HERMES_DESKTOP_USER_DATA_DIR": r"HERMES_DESKTOP_USER_DATA_DIR:\s*sandbox\.userDataDir",
    "HERMES_DESKTOP_IGNORE_EXISTING": r"HERMES_DESKTOP_IGNORE_EXISTING:\s*'1'",
    "HERMES_DESKTOP_ISOLATED_BACKEND": r"HERMES_DESKTOP_ISOLATED_BACKEND:\s*'1'",
    "HERMES_DESKTOP_HERMES_ROOT": r"HERMES_DESKTOP_HERMES_ROOT:\s*REPO_ROOT",
    "HERMES_DESKTOP_APP_NAME": r"HERMES_DESKTOP_APP_NAME:\s*`HermesE2E-\$\{Date\.now\(\)\}`",
    "HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION": r"HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION:\s*'1'",
}

# Where a real installed app/home would live. HERMES_DESKTOP_APP_NAME and the
# sandbox paths must keep the native run out of every one of them.
SENTINEL_DIRS = (
    ("LOCALAPPDATA", "hermes"),   # Windows default HERMES_HOME (data-paths.mjs)
    ("USERPROFILE", ".hermes"),   # Windows legacy home
    ("APPDATA", "Hermes"),        # default Electron userData for app name "Hermes"
    ("HOME", ".hermes"),          # POSIX default home
)
SENTINEL_REGISTRY = (r"Software\Classes\hermes", r"Software\Classes\hermes-dev")

ARTIFACT_SUFFIXES = {".png", ".jpg", ".jpeg", ".webm", ".zip", ".json", ".md", ".txt", ".log"}


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def metadata(args) -> int:
    data: dict[str, object] = {name: os.environ.get(name) for name in METADATA_ENV}
    for item in args.set or []:
        key, sep, value = item.partition("=")
        if not sep or not key:
            raise SystemExit(f"--set expects key=value, got {item!r}")
        data[key] = value
    provenance = Path(args.provenance)
    if provenance.is_file():
        data["source_provenance_sha256"] = _sha256(provenance)
        data["source_provenance"] = json.loads(provenance.read_text(encoding="utf-8-sig"))
    _write_json(Path(args.out), data)
    print(f"metadata: {args.out}")
    return 0


def stage(args) -> int:
    target = Path(args.dir)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        print(f"::error::evidence directory is not empty: {target}", file=sys.stderr)
        return 1
    target.mkdir(parents=True, exist_ok=True)
    print(f"staged empty evidence directory: {target}")
    return 0


def guard(args) -> int:
    text = Path(args.fixtures).read_text(encoding="utf-8-sig")
    missing = [name for name, pattern in FIXTURE_FLAGS.items() if not re.search(pattern, text)]
    spec = Path(args.spec).read_text(encoding="utf-8-sig")
    if "setupMockBackend" not in spec:
        missing.append("spec does not use setupMockBackend")
    for name in missing:
        print(f"::error::E2E fixture isolation missing: {name}", file=sys.stderr)
    if not missing:
        print(f"fixture isolation flags present: {', '.join(FIXTURE_FLAGS)}")
    return 1 if missing else 0


def _registry_key_exists(subkey: str) -> bool:
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey):
            return True
    except FileNotFoundError:
        return False


def snapshot_sentinels(env: dict[str, str], windows: bool) -> dict[str, bool]:
    found: dict[str, bool] = {}
    for variable, leaf in SENTINEL_DIRS:
        base = env.get(variable)
        if base:
            found[f"dir:%{variable}%/{leaf}"] = (Path(base) / leaf).exists()
    if windows:
        for subkey in SENTINEL_REGISTRY:
            found[f"HKCU:{subkey}"] = _registry_key_exists(subkey)
    return found


def sentinels(args) -> int:
    found = snapshot_sentinels(dict(os.environ), os.name == "nt")
    _write_json(Path(args.out), found)
    for key, exists in sorted(found.items()):
        print(f"{'present' if exists else 'absent '} {key}")
    return 0


def isolation(args) -> int:
    before = json.loads(Path(args.before).read_text(encoding="utf-8-sig"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8-sig"))
    if set(before) != set(after) or not before:
        print("::error::sentinel snapshots do not cover the same locations", file=sys.stderr)
        return 1
    created = sorted(key for key, exists in after.items() if exists and not before[key])
    for key in created:
        print(f"::error::native run created a real-install location: {key}", file=sys.stderr)
    if not created:
        print(f"no real-install location appeared ({len(after)} checked)")
    return 1 if created else 0


def _specs(suite: dict):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from _specs(child)


def check_results(report: dict, spec_name: str) -> list[str]:
    problems: list[str] = []
    if report.get("errors"):
        problems.append(f"Playwright reported {len(report['errors'])} top-level error(s)")
    stats = report.get("stats") or {}
    if stats.get("expected", 0) < 1:
        problems.append("no expected (passing) test in Playwright stats")
    for key in ("unexpected", "flaky", "skipped"):
        if stats.get(key, 0):
            problems.append(f"Playwright stats {key}={stats[key]}")
    tests = [
        test
        for suite in report.get("suites", [])
        for spec in _specs(suite)
        if Path(str(spec.get("file", ""))).name == spec_name
        for test in spec.get("tests", [])
    ]
    if not tests:
        problems.append(f"no test from {spec_name} in the report")
    for test in tests:
        results = test.get("results") or []
        if test.get("status") != "expected":
            problems.append(f"test status {test.get('status')!r}")
        if len(results) != 1 or results[0].get("retry", 0) != 0:
            problems.append(f"test ran {len(results)} attempt(s); exactly one unretried attempt required")
        elif results[0].get("status") != "passed":
            problems.append(f"test result {results[0].get('status')!r}")
    return problems


def check_evidence(directory: Path) -> list[str]:
    problems: list[str] = []
    for name in NATIVE_SCREENSHOTS:
        path = directory / name
        if not path.is_file() or path.stat().st_size <= len(PNG_SIGNATURE):
            problems.append(f"missing or empty screenshot {name}")
        elif path.read_bytes()[: len(PNG_SIGNATURE)] != PNG_SIGNATURE:
            problems.append(f"{name} is not a PNG")
    path = directory / NATIVE_OBSERVATIONS
    try:
        observations = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        return problems + [f"unreadable {NATIVE_OBSERVATIONS}: {error}"]
    if not isinstance(observations, dict):
        return problems + [f"{NATIVE_OBSERVATIONS} is not an object"]
    rows = observations.get("rowStates")
    if not isinstance(rows, list) or len(rows) != 2:
        problems.append("observations.rowStates must list the two draft rows")
    if not isinstance(observations.get("timeoutSeconds"), int):
        problems.append("observations.timeoutSeconds missing")
    if not observations.get("liveState"):
        problems.append("observations.liveState empty")
    return problems


def verify(args) -> int:
    problems: list[str] = []
    try:
        report = json.loads(Path(args.results).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        report = None
        problems.append(f"unreadable Playwright JSON report: {error}")
    if report is not None:
        problems += check_results(report, args.spec)
    problems += check_evidence(Path(args.evidence))
    summary = {
        "verdict": "failed" if problems else "passed",
        "problems": problems,
        "spec": args.spec,
        "evidence_files": sorted(p.name for p in Path(args.evidence).glob("*")) if Path(args.evidence).is_dir() else [],
        "stats": (report or {}).get("stats"),
    }
    _write_json(Path(args.out), summary)
    for problem in problems:
        print(f"::error::native evidence: {problem}", file=sys.stderr)
    print(f"native evidence verdict: {summary['verdict']}")
    return 1 if problems else 0


def collect(args) -> int:
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    max_file = int(args.max_file_mb * 1024 * 1024)
    budget = int(args.max_total_mb * 1024 * 1024)
    copied: list[dict[str, object]] = []
    skipped: list[dict[str, object]] = []
    missing: list[str] = []
    for spec in args.source:
        label, sep, raw = spec.partition("=")
        if not sep or not label or "/" in label or "\\" in label or label in (".", ".."):
            raise SystemExit(f"--source expects label=path, got {spec!r}")
        root = Path(raw)
        if not root.exists():
            missing.append(label)
            continue
        files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file())
        for path in files:
            relative = Path(label) / (path.name if root.is_file() else path.relative_to(root))
            size = path.stat().st_size
            reason = None
            if path.is_symlink():
                reason = "symlink"
            elif path.suffix.lower() not in ARTIFACT_SUFFIXES:
                reason = "suffix"
            elif size > max_file:
                reason = "file-cap"
            elif size > budget:
                reason = "total-cap"
            if reason:
                skipped.append({"path": relative.as_posix(), "bytes": size, "reason": reason})
                continue
            target = dest / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            budget -= size
            copied.append({"path": relative.as_posix(), "bytes": size, "sha256": _sha256(target)})
    _write_json(dest / "manifest.json", {"files": copied, "skipped": skipped, "missing_sources": missing})
    print(f"collected {len(copied)} file(s), skipped {len(skipped)}, missing sources {missing}")
    return 0


def gate(args) -> int:
    outcomes = []
    for item in args.outcome:
        name, sep, value = item.partition("=")
        if not sep or not name:
            raise SystemExit(f"--outcome expects name=value, got {item!r}")
        outcomes.append((name, value or "not-run"))
    verdict = None
    if args.verify and Path(args.verify).is_file():
        verdict = json.loads(Path(args.verify).read_text(encoding="utf-8-sig"))
    passed = bool(outcomes) and all(value == "success" for _, value in outcomes)
    if not verdict or verdict.get("verdict") != "passed":
        passed = False
    lines = [
        "## Clarify drafts: Windows native evidence",
        "",
        f"Overall: **{'PASSED' if passed else 'FAILED'}**",
        "",
        "| Step | Outcome |",
        "| --- | --- |",
        *(f"| {name} | {value} |" for name, value in outcomes),
        "",
        f"Native evidence verdict: {verdict.get('verdict') if verdict else 'absent'}",
    ]
    for problem in (verdict or {}).get("problems", []):
        lines.append(f"- {problem}")
    lines += ["", "Source build and native test evidence only; not a packaged or signed Windows release."]
    text = "\n".join(lines) + "\n"
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(text)
    print(text)
    return 0 if passed else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("metadata")
    p.add_argument("--out", required=True)
    p.add_argument("--provenance", default="source-provenance.json")
    p.add_argument("--set", action="append", help="extra key=value fact (e.g. a setup-pm version output)")
    p.set_defaults(func=metadata)

    p = sub.add_parser("stage")
    p.add_argument("dir")
    p.set_defaults(func=stage)

    p = sub.add_parser("guard")
    p.add_argument("--fixtures", default="apps/desktop/e2e/fixtures.ts")
    p.add_argument("--spec", default=f"apps/desktop/e2e/{NATIVE_SPEC}")
    p.set_defaults(func=guard)

    p = sub.add_parser("sentinels")
    p.add_argument("--out", required=True)
    p.set_defaults(func=sentinels)

    p = sub.add_parser("isolation")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.set_defaults(func=isolation)

    p = sub.add_parser("verify")
    p.add_argument("--evidence", required=True)
    p.add_argument("--results", required=True)
    p.add_argument("--spec", default=NATIVE_SPEC)
    p.add_argument("--out", required=True)
    p.set_defaults(func=verify)

    p = sub.add_parser("collect")
    p.add_argument("--dest", required=True)
    p.add_argument("--source", action="append", default=[], help="label=path (file or directory)")
    p.add_argument("--max-file-mb", type=float, default=50)
    p.add_argument("--max-total-mb", type=float, default=200)
    p.set_defaults(func=collect)

    p = sub.add_parser("gate")
    p.add_argument("--outcome", action="append", default=[], help="step=outcome")
    p.add_argument("--verify", help="verify summary JSON")
    p.set_defaults(func=gate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
