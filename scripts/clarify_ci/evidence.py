"""Evidence helpers for .github/workflows/clarify-windows.yml (stdlib only).

Each subcommand does one bounded job and exits non-zero when its claim does not hold:

  metadata   allowlisted run/source facts (never the raw environment)
  stage      create an empty, owned evidence directory (refuses a non-empty one)
  guard      the E2E fixture still sets every isolation flag this workflow relies on,
             and every native spec (and every --extra-spec) drives the app through that fixture
  sentinels  record which real-install locations exist (default homes, protocol keys, any --watch)
             and, beside the snapshot, the bounded entry names inside any that do
  isolation  fail if a sentinel absent before the native run exists after it
  verify     Playwright JSON + per-spec evidence prove every spec ran once, unretried, and passed;
             an --extra-spec outside the naming convention is proven by the Playwright JSON alone
  collect    copy known evidence files into a size-capped artifact directory
  gate       write the step summary from real step outcomes; fail unless all succeeded

Evidence naming convention (verify). A spec ``clarify-drafts-<slug>.spec.ts`` writes into
``$HERMES_E2E_EVIDENCE_DIR`` at least one ``<slug>-*.png`` screenshot and a
``<slug>-observations.json`` object. ``clarify-drafts-native.spec.ts`` (slug ``native``) predates the
convention and keeps its fixed names and content checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path

NATIVE_SPEC = "clarify-drafts-native.spec.ts"
NATIVE_SPEC_GLOB = "clarify-drafts-native*.spec.ts"
SPEC_DIR = "apps/desktop/e2e"
NATIVE_SCREENSHOTS = ("native-01-live-card.png", "native-02-timed-out-card.png", "native-03-recalled.png")
NATIVE_OBSERVATIONS = "native-observations.json"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SPEC_NAME = re.compile(r"clarify-drafts-(?P<slug>.+)\.spec\.ts")

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

# Where a real installed app/home would live. HERMES_DESKTOP_APP_NAME, the sandbox paths and the
# --user-data-dir switch must keep every run out of all of them.
SENTINEL_DIRS = (
    ("LOCALAPPDATA", "hermes"),          # Windows default HERMES_HOME (data-paths.mjs)
    ("USERPROFILE", ".hermes"),          # Windows legacy home
    ("APPDATA", "Hermes"),               # default Electron userData for app name "Hermes"
    ("APPDATA", "hermes-desktop"),       # historical desktop userData name (desktop-uninstall.ts)
    ("LOCALAPPDATA", "hermes-updater"),  # electron-updater cache of the installed app
    ("HOME", ".hermes"),                 # POSIX default home
    # The per-OS-user rendezvous in which gateways find each other (gateway/status.py::_get_lock_dir). A process that
    # uses the real one can attach to the user's real backend, so no run may create it.
    ("USERPROFILE", ".local/state/hermes*"),
    ("HOME", ".local/state/hermes*"),
)
SENTINEL_REGISTRY = (r"Software\Classes\hermes", r"Software\Classes\hermes-dev")

# Sentinel keys with this prefix describe the candidate's own footprint: reported, never gated.
INFORMATIONAL = "info:"
ENTRY_LIMIT = 40

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


def _base_name(value: object) -> str:
    """Last path segment of a report path, whichever separator the producing OS used."""
    return str(value).replace("\\", "/").rsplit("/", 1)[-1]


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


def discover_specs(directory: Path, pattern: str) -> list[str]:
    return sorted(path.name for path in directory.glob(pattern) if path.is_file())


def spec_slug(name: str) -> str:
    match = SPEC_NAME.fullmatch(name)
    return match.group("slug") if match else name.removesuffix(".spec.ts")


def _extra_specs(args) -> list[str]:
    """Specs that belong to the gate but do not follow the ``clarify-drafts-<slug>.spec.ts`` convention."""
    return [_base_name(name) for name in args.extra_spec or []]


def _requested_specs(args) -> list[str]:
    """Spec file names to verify: the explicit ones, else every spec the glob finds."""
    if args.spec:
        return [_base_name(name) for name in args.spec]
    return discover_specs(Path(args.specs_dir), args.spec_glob)


def guard(args) -> int:
    text = Path(args.fixtures).read_text(encoding="utf-8-sig")
    missing = [name for name, pattern in FIXTURE_FLAGS.items() if not re.search(pattern, text)]
    if args.spec:
        specs = [Path(item) for item in args.spec]
    else:
        specs = [Path(args.specs_dir) / name for name in discover_specs(Path(args.specs_dir), args.spec_glob)]
        if not specs:
            missing.append(f"no native spec under {args.specs_dir} matches {args.spec_glob}")
    for extra in _extra_specs(args):
        path = Path(args.specs_dir) / extra
        if not path.is_file():
            missing.append(f"extra spec {path} does not exist")
        elif path not in specs:
            specs.append(path)
    for spec in specs:
        source = spec.read_text(encoding="utf-8-sig")
        # The original spec keeps its strict rule; later ones may restart the app through the fixture
        # (launchDesktop) provided the sandbox env still comes from buildAppEnv.
        through_fixture = "setupMockBackend" in source or (
            spec.name != NATIVE_SPEC and "launchDesktop" in source and "buildAppEnv" in source)
        if not through_fixture:
            missing.append(f"{spec.name} does not drive the app through the isolated fixture (setupMockBackend)")
        if "_electron.launch(" in source:
            missing.append(f"{spec.name} launches Electron directly instead of through the isolated fixture")
    for name in missing:
        print(f"::error::E2E fixture isolation missing: {name}", file=sys.stderr)
    if not missing:
        print(f"fixture isolation flags present: {', '.join(FIXTURE_FLAGS)}")
        print(f"native specs drive the app through the fixture: {', '.join(spec.name for spec in specs)}")
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


def _sentinel_key(variable: str, leaf: str) -> str:
    return f"dir:%{variable}%/{leaf}"


def _is_pattern(leaf: str) -> bool:
    return any(char in leaf for char in "*?[")


def _watched(env: dict[str, str], extra: Sequence[tuple[str, str]],
             watch: Sequence[tuple[str, str]] = ()) -> dict[str, tuple[Path, str]]:
    """Sentinel key -> (parent directory, leaf name or glob pattern) for every watched location."""
    found: dict[str, tuple[Path, str]] = {}
    for variable, leaf in (*SENTINEL_DIRS, *watch):
        base = env.get(variable)
        if base:
            found[_sentinel_key(variable, leaf)] = (Path(base), leaf)
    for variable, leaf in extra:
        base = env.get(variable)
        if base:
            found[INFORMATIONAL + _sentinel_key(variable, leaf)] = (Path(base), leaf)
    return found


def _matches(base: Path, leaf: str) -> list[Path]:
    """The existing entries a watched leaf names: itself, or what a glob pattern finds (case-insensitive on Windows)."""
    if _is_pattern(leaf):
        try:
            return sorted(base.glob(leaf))
        except (OSError, ValueError):
            return []
    path = base / leaf
    return [path] if path.exists() else []


def snapshot_sentinels(env: dict[str, str], windows: bool, extra: Sequence[tuple[str, str]] = (),
                       watch: Sequence[tuple[str, str]] = ()) -> dict[str, bool]:
    found = {key: bool(_matches(base, leaf)) for key, (base, leaf) in _watched(env, extra, watch).items()}
    if windows:
        for subkey in SENTINEL_REGISTRY:
            found[f"HKCU:{subkey}"] = _registry_key_exists(subkey)
    return found


def sentinel_entries(env: dict[str, str], extra: Sequence[tuple[str, str]] = (),
                     watch: Sequence[tuple[str, str]] = ()) -> dict[str, dict[str, object]]:
    """Bounded entry names for every watched location that exists, so a leak is diagnosable.

    A directory lists what it holds; a pattern lists the entries it matched."""
    detail: dict[str, dict[str, object]] = {}
    for key, (base, leaf) in _watched(env, extra, watch).items():
        matches = _matches(base, leaf)
        if not matches:
            continue
        try:
            if _is_pattern(leaf):
                names = sorted(path.name for path in matches)
            elif matches[0].is_dir():
                names = sorted(child.name for child in matches[0].iterdir())
            else:
                continue
        except OSError as error:
            detail[key] = {"entries": [], "truncated": False, "error": str(error)}
            continue
        detail[key] = {"entries": names[:ENTRY_LIMIT], "truncated": len(names) > ENTRY_LIMIT, "count": len(names)}
    return detail


def _extra_watch(items: Sequence[str], option: str = "--informational") -> list[tuple[str, str]]:
    watched = []
    for item in items:
        variable, sep, leaf = item.partition("/")
        if not sep or not variable or not leaf:
            raise SystemExit(f"{option} expects VARIABLE/leaf, got {item!r}")
        watched.append((variable, leaf))
    return watched


def _entries_path(snapshot: Path) -> Path:
    return snapshot.with_name(snapshot.stem + ".entries.json")


def sentinels(args) -> int:
    windows = os.name == "nt"
    env, extra = dict(os.environ), _extra_watch(args.informational or [])
    watch = _extra_watch(args.watch or [], "--watch")
    found = snapshot_sentinels(env, windows, extra, watch)
    _write_json(Path(args.out), found)
    _write_json(_entries_path(Path(args.out)), sentinel_entries(env, extra, watch))
    for key, exists in sorted(found.items()):
        print(f"{'present' if exists else 'absent '} {key}")
    return 0


def isolation(args) -> int:
    before = json.loads(Path(args.before).read_text(encoding="utf-8-sig"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8-sig"))
    if set(before) != set(after) or not before:
        print("::error::sentinel snapshots do not cover the same locations", file=sys.stderr)
        return 1
    try:
        entries = json.loads(_entries_path(Path(args.after)).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        entries = {}
    created = sorted(key for key, exists in after.items() if exists and not before[key])
    gated = [key for key in created if not key.startswith(INFORMATIONAL)]
    for key in created:
        listed = (entries.get(key) or {}).get("entries")
        detail = f" (entries: {', '.join(listed) if listed else 'none listed'})" if key in entries else ""
        if key.startswith(INFORMATIONAL):
            print(f"::warning::{args.label} run left a candidate footprint: {key[len(INFORMATIONAL):]}{detail}", file=sys.stderr)
        else:
            print(f"::error::{args.label} run created a real-install location: {key}{detail}", file=sys.stderr)
    if not gated:
        print(f"no real-install location appeared ({len(after)} checked)")
    return 1 if gated else 0


def _specs(suite: dict):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from _specs(child)


def _tests_of(report: dict, spec_name: str) -> list[dict]:
    return [
        test
        for suite in report.get("suites", [])
        for spec in _specs(suite)
        if _base_name(spec.get("file", "")) == spec_name
        for test in spec.get("tests", [])
    ]


def check_results(report: dict, specs: str | Sequence[str]) -> list[str]:
    """Problems that stop a Playwright JSON report from proving every named spec ran once and passed."""
    spec_names = [specs] if isinstance(specs, str) else list(specs)
    problems: list[str] = []
    if report.get("errors"):
        problems.append(f"Playwright reported {len(report['errors'])} top-level error(s)")
    stats = report.get("stats") or {}
    if stats.get("expected", 0) < 1:
        problems.append("no expected (passing) test in Playwright stats")
    for key in ("unexpected", "flaky", "skipped"):
        if stats.get(key, 0):
            problems.append(f"Playwright stats {key}={stats[key]}")
    total = 0
    for spec_name in spec_names:
        tests = _tests_of(report, spec_name)
        total += len(tests)
        if not tests:
            problems.append(f"no test from {spec_name} in the report")
        for test in tests:
            results = test.get("results") or []
            if test.get("status") != "expected":
                problems.append(f"{spec_name}: test status {test.get('status')!r}")
            if len(results) != 1 or results[0].get("retry", 0) != 0:
                problems.append(f"{spec_name}: test ran {len(results)} attempt(s); exactly one unretried attempt required")
            elif results[0].get("status") != "passed":
                problems.append(f"{spec_name}: test result {results[0].get('status')!r}")
    if total and stats.get("expected", 0) < total:
        problems.append(f"Playwright stats expected={stats.get('expected', 0)} but the named specs hold {total} test(s)")
    return problems


def _png_problem(path: Path, label: str) -> str | None:
    if not path.is_file() or path.stat().st_size <= len(PNG_SIGNATURE):
        return f"missing or empty screenshot {label}"
    if path.read_bytes()[: len(PNG_SIGNATURE)] != PNG_SIGNATURE:
        return f"{label} is not a PNG"
    return None


def _load_object(path: Path, label: str) -> tuple[dict | None, list[str]]:
    try:
        observations = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        return None, [f"unreadable {label}: {error}"]
    if not isinstance(observations, dict):
        return None, [f"{label} is not an object"]
    return observations, []


def check_evidence(directory: Path) -> list[str]:
    """The original native scenario's fixed evidence: three screenshots and its observations."""
    problems = [problem for name in NATIVE_SCREENSHOTS if (problem := _png_problem(directory / name, name))]
    observations, errors = _load_object(directory / NATIVE_OBSERVATIONS, NATIVE_OBSERVATIONS)
    if observations is None:
        return problems + errors
    rows = observations.get("rowStates")
    if not isinstance(rows, list) or len(rows) != 2:
        problems.append("observations.rowStates must list the two draft rows")
    if not isinstance(observations.get("timeoutSeconds"), int):
        problems.append("observations.timeoutSeconds missing")
    if not observations.get("liveState"):
        problems.append("observations.liveState empty")
    return problems


def _dotted(value: object, dotted: str) -> object:
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _same(actual: object, expected: str) -> bool:
    if isinstance(actual, bool):
        return str(actual).lower() == expected.lower()
    return actual is not None and str(actual) == expected


def check_spec_evidence(directory: Path, slug: str, slugs: Sequence[str], expectations: Sequence[str] = ()) -> list[str]:
    """Evidence of one later spec: >=1 valid ``<slug>-*.png`` and a ``<slug>-observations.json`` object.

    A file belongs to the longest slug it starts with, so ``native-restart-1.png`` is never credited to
    the ``native`` spec. ``expectations`` are ``dotted.key=value`` facts the observations must state.
    """
    problems: list[str] = []
    longer = [other for other in slugs if other != slug and other.startswith(f"{slug}-")]
    owned = sorted(
        path for path in directory.glob(f"{slug}-*.png")
        if not any(path.name.startswith(f"{other}-") for other in longer)
    ) if directory.is_dir() else []
    if not owned:
        problems.append(f"{slug}: no {slug}-*.png screenshot in the evidence directory")
    problems += [f"{slug}: {problem}" for path in owned if (problem := _png_problem(path, path.name))]
    label = f"{slug}-observations.json"
    observations, errors = _load_object(directory / label, label)
    if observations is None:
        return problems + [f"{slug}: {error}" for error in errors]
    if not observations:
        problems.append(f"{slug}: {label} is empty")
    for item in expectations:
        key, sep, expected = item.partition("=")
        if not sep or not key:
            raise SystemExit(f"--expect-observation expects dotted.key=value, got {item!r}")
        actual = _dotted(observations, key)
        if not _same(actual, expected):
            problems.append(f"{slug}: {label} {key}={actual!r}, expected {expected!r}")
    return problems


def _slug_expectations(items: Sequence[str]) -> dict[str, list[str]]:
    by_slug: dict[str, list[str]] = {}
    for item in items:
        slug, sep, rest = item.partition(":")
        if not sep or not slug or "=" not in rest:
            raise SystemExit(f"--expect-observation expects slug:dotted.key=value, got {item!r}")
        by_slug.setdefault(slug, []).append(rest)
    return by_slug


def verify(args) -> int:
    problems: list[str] = []
    specs = _requested_specs(args)
    extras = [name for name in _extra_specs(args) if name not in specs]
    if not specs:
        problems.append(f"no native spec found under {args.specs_dir} matching {args.spec_glob}")
    try:
        report = json.loads(Path(args.results).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        report = None
        problems.append(f"unreadable Playwright JSON report: {error}")
    if report is not None and (specs or extras):
        problems += check_results(report, [*specs, *extras])
    evidence = Path(args.evidence)
    slugs = [spec_slug(name) for name in specs]
    expectations = _slug_expectations(args.expect_observation or [])
    for name in specs:
        slug = spec_slug(name)
        if name == NATIVE_SPEC:
            problems += check_evidence(evidence)
        else:
            problems += check_spec_evidence(evidence, slug, slugs, expectations.get(slug, []))
    summary = {
        "verdict": "failed" if problems else "passed",
        "problems": problems,
        "specs": {
            name: len(_tests_of(report, name)) if report is not None else 0 for name in [*specs, *extras]
        },
        "evidence_files": sorted(p.name for p in evidence.glob("*")) if evidence.is_dir() else [],
        "stats": (report or {}).get("stats"),
    }
    _write_json(Path(args.out), summary)
    for problem in problems:
        print(f"::error::{args.label} evidence: {problem}", file=sys.stderr)
    named = [*specs, *extras]
    print(f"{args.label} evidence verdict: {summary['verdict']} ({len(named)} spec(s): {', '.join(named) or 'none'})")
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
        f"## {args.title}",
        "",
        f"Overall: **{'PASSED' if passed else 'FAILED'}**",
        "",
        "| Step | Outcome |",
        "| --- | --- |",
        *(f"| {name} | {value} |" for name, value in outcomes),
        "",
        f"Evidence verdict: {verdict.get('verdict') if verdict else 'absent'}",
    ]
    for problem in (verdict or {}).get("problems", []):
        lines.append(f"- {problem}")
    lines += ["", args.note]
    text = "\n".join(lines) + "\n"
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(text)
    print(text)
    return 0 if passed else 1


def _add_spec_selection(parser: argparse.ArgumentParser, help_text: str) -> None:
    parser.add_argument("--spec", action="append", help=help_text)
    parser.add_argument("--extra-spec", action="append",
                        help="spec file name (repeatable) that is part of the gate but is not named "
                             "clarify-drafts-<slug>.spec.ts: checked in the Playwright JSON (and by guard), "
                             "with no per-spec evidence files")
    parser.add_argument("--specs-dir", default=SPEC_DIR)
    parser.add_argument("--spec-glob", default=NATIVE_SPEC_GLOB)


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
    _add_spec_selection(p, "spec file path (repeatable); default: every spec the glob finds")
    p.set_defaults(func=guard)

    p = sub.add_parser("sentinels")
    p.add_argument("--out", required=True)
    p.add_argument("--informational", action="append",
                   help="VARIABLE/leaf directory to report but never gate on (the candidate's own footprint)")
    p.add_argument("--watch", action="append",
                   help="VARIABLE/leaf directory that must stay absent, beyond the built-in real-install locations")
    p.set_defaults(func=sentinels)

    p = sub.add_parser("isolation")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.add_argument("--label", default="native", help="what ran between the snapshots, for the messages")
    p.set_defaults(func=isolation)

    p = sub.add_parser("verify")
    p.add_argument("--evidence", required=True)
    p.add_argument("--results", required=True)
    _add_spec_selection(p, "spec file name (repeatable); default: every spec the glob finds")
    p.add_argument("--expect-observation", action="append",
                   help="slug:dotted.key=value the spec's observations must state (repeatable)")
    p.add_argument("--label", default="native", help="what is being verified, for the messages")
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
    p.add_argument("--title", default="Clarify drafts: Windows native evidence")
    p.add_argument("--note", default="Source build and native test evidence only; not a packaged or signed Windows release.")
    p.set_defaults(func=gate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
