"""Behaviour tests for scripts/clarify_ci/evidence.py (runs on Linux and Windows)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location("clarify_ci_evidence", Path(__file__).with_name("evidence.py"))
assert _SPEC is not None and _SPEC.loader is not None
evidence = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(evidence)

REPO = Path(__file__).resolve().parents[2]
PNG = evidence.PNG_SIGNATURE + b"\x00" * 32


def _report(status="expected", results=None, stats=None, errors=None):
    results = [{"status": "passed", "retry": 0}] if results is None else results
    return {
        "errors": errors or [],
        "stats": stats or {"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 0},
        "suites": [{
            "file": evidence.NATIVE_SPEC,
            "specs": [],
            "suites": [{"specs": [{"file": evidence.NATIVE_SPEC, "tests": [{"status": status, "results": results}]}]}],
        }],
    }


def _multi_report(specs, stats=None):
    """One passing, unretried test per spec file (a Windows-style absolute path in the suite title)."""
    passing = {"status": "expected", "results": [{"status": "passed", "retry": 0}]}
    return {
        "errors": [],
        "stats": stats or {"expected": len(specs), "unexpected": 0, "flaky": 0, "skipped": 0},
        "suites": [{"file": name, "specs": [{"file": name, "tests": [dict(passing)]}], "suites": []} for name in specs],
    }


RESTART = "clarify-drafts-native-restart.spec.ts"
SCOPE = "clarify-drafts-native-scope.spec.ts"


def _extra_evidence(directory: Path, slug: str, observations=None, shots=("01-before", "02-after")) -> None:
    for shot in shots:
        (directory / f"{slug}-{shot}.png").write_bytes(PNG)
    (directory / f"{slug}-observations.json").write_text(
        json.dumps({"scenario": slug} if observations is None else observations), encoding="utf-8")


def _complete_evidence(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in evidence.NATIVE_SCREENSHOTS:
        (directory / name).write_bytes(PNG)
    (directory / evidence.NATIVE_OBSERVATIONS).write_text(json.dumps({
        "liveState": "saved", "liveText": "Draft saved", "timeoutSeconds": 25,
        "rowStates": [{"disk": "saved", "transcript": "saved"}, {"disk": "saved", "transcript": "saved"}],
    }), encoding="utf-8")
    return directory


def _verify(tmp_path: Path, report: dict | None, evidence_dir: Path, *extra: str, specs=(evidence.NATIVE_SPEC,)) -> tuple[int, dict]:
    results = tmp_path / "results.json"
    if report is not None:
        results.write_text(json.dumps(report), encoding="utf-8")
    out = tmp_path / "verdict.json"
    selection = [arg for name in specs for arg in ("--spec", name)]
    code = evidence.main(["verify", "--evidence", str(evidence_dir), "--results", str(results), "--out", str(out),
                          *selection, *extra])
    return code, json.loads(out.read_text(encoding="utf-8-sig"))


def test_verify_passes_one_unretried_passing_run_with_complete_evidence(tmp_path):
    code, verdict = _verify(tmp_path, _report(), _complete_evidence(tmp_path / "native"))
    assert (code, verdict["verdict"], verdict["problems"]) == (0, "passed", [])


def test_verify_accepts_bom_prefixed_windows_json(tmp_path):
    directory = _complete_evidence(tmp_path / "native")
    observations = directory / evidence.NATIVE_OBSERVATIONS
    observations.write_bytes(b"\xef\xbb\xbf" + observations.read_bytes())
    results = tmp_path / "results.json"
    results.write_bytes(b"\xef\xbb\xbf" + json.dumps(_report()).encode("utf-8"))
    out = tmp_path / "verdict.json"
    assert evidence.main([
        "verify", "--evidence", str(directory), "--results", str(results), "--out", str(out),
        "--spec", evidence.NATIVE_SPEC,
    ]) == 0
    assert json.loads(out.read_text(encoding="utf-8-sig"))["verdict"] == "passed"


def test_verify_refuses_an_empty_staged_evidence_directory(tmp_path):
    (tmp_path / "native").mkdir()
    code, verdict = _verify(tmp_path, _report(), tmp_path / "native")
    assert code == 1 and verdict["verdict"] == "failed"
    assert any("screenshot" in problem for problem in verdict["problems"])


@pytest.mark.parametrize("report, needle", [
    (None, "unreadable Playwright JSON"),
    (_report(status="flaky", results=[{"status": "failed", "retry": 0}, {"status": "passed", "retry": 1}],
             stats={"expected": 0, "unexpected": 0, "flaky": 1, "skipped": 0}), "flaky"),
    (_report(status="unexpected", results=[{"status": "failed", "retry": 0}],
             stats={"expected": 0, "unexpected": 1, "flaky": 0, "skipped": 0}), "unexpected"),
    (_report(status="skipped", results=[], stats={"expected": 0, "unexpected": 0, "flaky": 0, "skipped": 1}), "skipped"),
    (_report(errors=[{"message": "beforeAll"}]), "top-level error"),
    ({"errors": [], "stats": {"expected": 1}, "suites": []}, "no test from"),
])
def test_verify_refuses_reports_that_are_not_one_clean_pass(tmp_path, report, needle):
    code, verdict = _verify(tmp_path, report, _complete_evidence(tmp_path / "native"))
    assert code == 1
    assert any(needle in problem for problem in verdict["problems"]), verdict["problems"]


def test_verify_refuses_a_non_png_screenshot_and_short_observations(tmp_path):
    directory = _complete_evidence(tmp_path / "native")
    (directory / evidence.NATIVE_SCREENSHOTS[0]).write_bytes(b"not a png at all, just text")
    (directory / evidence.NATIVE_OBSERVATIONS).write_text(json.dumps({"rowStates": []}), encoding="utf-8")
    code, verdict = _verify(tmp_path, _report(), directory)
    assert code == 1
    joined = " ".join(verdict["problems"])
    assert "not a PNG" in joined and "rowStates" in joined and "timeoutSeconds" in joined


def test_verify_requires_every_spec_to_pass_with_its_own_evidence(tmp_path):
    directory = _complete_evidence(tmp_path / "native")
    _extra_evidence(directory, "native-restart")
    _extra_evidence(directory, "native-scope")
    report = _multi_report([evidence.NATIVE_SPEC, RESTART, SCOPE])
    code, verdict = _verify(tmp_path, report, directory, specs=(evidence.NATIVE_SPEC, RESTART, SCOPE))
    assert (code, verdict["problems"]) == (0, [])
    assert verdict["specs"] == {evidence.NATIVE_SPEC: 1, RESTART: 1, SCOPE: 1}


def test_verify_discovers_specs_from_the_directory_when_none_are_named(tmp_path):
    specs_dir = tmp_path / "e2e"
    specs_dir.mkdir()
    for name in (evidence.NATIVE_SPEC, RESTART, "clarify-drafts-packaged.spec.ts", "batch-clarify.spec.ts"):
        (specs_dir / name).write_text("", encoding="utf-8")
    directory = _complete_evidence(tmp_path / "native")
    _extra_evidence(directory, "native-restart")
    results = tmp_path / "results.json"
    results.write_text(json.dumps(_multi_report([evidence.NATIVE_SPEC, RESTART])), encoding="utf-8")
    out = tmp_path / "verdict.json"
    args = ["verify", "--evidence", str(directory), "--results", str(results), "--out", str(out), "--specs-dir", str(specs_dir)]
    assert evidence.main(args) == 0
    assert sorted(json.loads(out.read_text(encoding="utf-8-sig"))["specs"]) == sorted([evidence.NATIVE_SPEC, RESTART])
    # A spec that exists on disk but never reached the report cannot hide behind the ones that did.
    results.write_text(json.dumps(_multi_report([evidence.NATIVE_SPEC])), encoding="utf-8")
    assert evidence.main(args) == 1
    assert any(f"no test from {RESTART}" in problem for problem in json.loads(out.read_text(encoding="utf-8-sig"))["problems"])


def test_verify_refuses_a_run_that_found_no_native_spec(tmp_path):
    (tmp_path / "e2e").mkdir()
    results = tmp_path / "results.json"
    results.write_text(json.dumps(_multi_report([evidence.NATIVE_SPEC])), encoding="utf-8")
    out = tmp_path / "verdict.json"
    assert evidence.main(["verify", "--evidence", str(tmp_path), "--results", str(results), "--out", str(out),
                          "--specs-dir", str(tmp_path / "e2e")]) == 1
    assert any("no native spec found" in problem for problem in json.loads(out.read_text(encoding="utf-8-sig"))["problems"])


@pytest.mark.parametrize("damage, needle", [
    (lambda d: (d / "native-restart-01-before.png").unlink() or (d / "native-restart-02-after.png").unlink(), "no native-restart-*.png"),
    (lambda d: (d / "native-restart-02-after.png").write_bytes(b"plain text, not an image"), "is not a PNG"),
    (lambda d: (d / "native-restart-observations.json").unlink(), "unreadable native-restart-observations.json"),
    (lambda d: (d / "native-restart-observations.json").write_text("{}", encoding="utf-8"), "is empty"),
    (lambda d: (d / "native-restart-observations.json").write_text("[1]", encoding="utf-8"), "is not an object"),
])
def test_verify_refuses_a_later_spec_without_its_evidence(tmp_path, damage, needle):
    directory = _complete_evidence(tmp_path / "native")
    _extra_evidence(directory, "native-restart")
    damage(directory)
    code, verdict = _verify(tmp_path, _multi_report([evidence.NATIVE_SPEC, RESTART]), directory,
                            specs=(evidence.NATIVE_SPEC, RESTART))
    assert code == 1
    assert any(needle in problem and problem.startswith("native-restart:") for problem in verdict["problems"]), verdict["problems"]


def test_verify_never_credits_a_longer_slugs_screenshots_to_the_shorter_spec(tmp_path):
    directory = tmp_path / "native"
    directory.mkdir()
    _extra_evidence(directory, "native-restart")
    (directory / "native-observations.json").write_text(json.dumps({"scenario": "native"}), encoding="utf-8")
    code, verdict = _verify(tmp_path, _multi_report(["clarify-drafts-native-x.spec.ts", RESTART]), directory,
                            specs=("clarify-drafts-x.spec.ts", RESTART))
    assert code == 1  # the x spec owns no screenshot of its own and the report has no test from it
    assert any(problem.startswith("x:") and "no x-*.png" in problem for problem in verdict["problems"])
    short = directory / "native-01.png"
    short.write_bytes(PNG)
    problems = evidence.check_spec_evidence(directory, "native", ["native", "native-restart"])
    assert problems == [], "a file only the short slug claims is credited to it"
    short.unlink()
    assert any("no native-*.png" in problem for problem in evidence.check_spec_evidence(directory, "native", ["native", "native-restart"]))


def test_verify_checks_the_facts_a_spec_must_state(tmp_path):
    directory = tmp_path / "packaged"
    directory.mkdir()
    _extra_evidence(directory, "packaged", {"identity": {"commit": "abc"}, "backend": {"insidePackage": True}})
    report = _multi_report(["clarify-drafts-packaged.spec.ts"])
    spec = ("clarify-drafts-packaged.spec.ts",)
    good = ("--expect-observation", "packaged:identity.commit=abc", "--expect-observation", "packaged:backend.insidePackage=true")
    assert _verify(tmp_path, report, directory, *good, specs=spec)[0] == 0
    code, verdict = _verify(tmp_path, report, directory, "--expect-observation", "packaged:backend.insidePackage=false", specs=spec)
    assert code == 1 and any("backend.insidePackage=True" in problem for problem in verdict["problems"])
    code, verdict = _verify(tmp_path, report, directory, "--expect-observation", "packaged:identity.missing=1", specs=spec)
    assert code == 1 and any("identity.missing=None" in problem for problem in verdict["problems"])


def test_verify_counts_tests_against_the_named_specs(tmp_path):
    directory = _complete_evidence(tmp_path / "native")
    _extra_evidence(directory, "native-restart")
    report = _multi_report([evidence.NATIVE_SPEC, RESTART], stats={"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 0})
    code, verdict = _verify(tmp_path, report, directory, specs=(evidence.NATIVE_SPEC, RESTART))
    assert code == 1 and any("expected=1 but the named specs hold 2" in problem for problem in verdict["problems"])


def test_verify_refuses_a_skipped_or_flaky_later_spec(tmp_path):
    directory = _complete_evidence(tmp_path / "native")
    _extra_evidence(directory, "native-restart")
    report = _multi_report([evidence.NATIVE_SPEC, RESTART], stats={"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 1})
    report["suites"][1]["specs"][0]["tests"] = [{"status": "skipped", "results": []}]
    code, verdict = _verify(tmp_path, report, directory, specs=(evidence.NATIVE_SPEC, RESTART))
    joined = " ".join(verdict["problems"])
    assert code == 1 and "skipped=1" in joined and f"{RESTART}: test status 'skipped'" in joined


def test_stage_creates_an_empty_directory_and_refuses_a_populated_one(tmp_path):
    target = tmp_path / "native"
    assert evidence.main(["stage", str(target)]) == 0 and target.is_dir()
    (target / "stale.png").write_bytes(PNG)
    assert evidence.main(["stage", str(target)]) == 1


def test_isolation_fails_only_when_a_real_install_location_appears(tmp_path, monkeypatch):
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        (tmp_path / name).mkdir()
        monkeypatch.setenv(name, str(tmp_path / name))
    (tmp_path / "APPDATA" / "Hermes").mkdir()  # pre-existing: never blamed on the run
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before)]) == 0
    assert evidence.main(["sentinels", "--out", str(after)]) == 0
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 0
    (tmp_path / "LOCALAPPDATA" / "hermes").mkdir()
    assert evidence.main(["sentinels", "--out", str(after)]) == 0
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 1


def test_isolation_refuses_mismatched_or_empty_snapshots(tmp_path):
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    before.write_text("{}", encoding="utf-8")
    after.write_text("{}", encoding="utf-8")
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 1
    before.write_text(json.dumps({"dir:a": False}), encoding="utf-8")
    after.write_text(json.dumps({"dir:b": False}), encoding="utf-8")
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 1


def test_guard_accepts_the_checked_in_fixture_and_rejects_a_missing_flag(tmp_path):
    fixtures = REPO / "apps" / "desktop" / "e2e" / "fixtures.ts"
    spec = REPO / "apps" / "desktop" / "e2e" / evidence.NATIVE_SPEC
    assert evidence.main(["guard", "--fixtures", str(fixtures), "--spec", str(spec)]) == 0
    weakened = tmp_path / "fixtures.ts"
    fixture_source = fixtures.read_text(encoding="utf-8-sig")
    weakened.write_text(fixture_source.replace(
        "HERMES_DESKTOP_ISOLATED_BACKEND: '1'", "HERMES_DESKTOP_ISOLATED_BACKEND: '0'"), encoding="utf-8")
    assert evidence.main(["guard", "--fixtures", str(weakened), "--spec", str(spec)]) == 1


def _guard(tmp_path, specs: dict[str, str], *extra: str) -> int:
    directory = tmp_path / "e2e"
    directory.mkdir(exist_ok=True)
    for name, source in specs.items():
        (directory / name).write_text(source, encoding="utf-8")
    fixtures = REPO / "apps" / "desktop" / "e2e" / "fixtures.ts"
    return evidence.main(["guard", "--fixtures", str(fixtures), "--specs-dir", str(directory), *extra])


def test_guard_checks_every_discovered_native_spec(tmp_path, capsys):
    specs = {
        evidence.NATIVE_SPEC: "await setupMockBackend()",
        RESTART: "const env = buildAppEnv(sandbox)\nawait launchDesktop(env)",
        "clarify-drafts-packaged.spec.ts": "_electron.launch(",  # not a native spec: never inspected
    }
    assert _guard(tmp_path, specs) == 0
    assert "clarify-drafts-native-restart.spec.ts" in capsys.readouterr().out
    assert _guard(tmp_path, {**specs, SCOPE: "await setupMockBackend()\nawait _electron.launch({})"}) == 1
    assert "launches Electron directly" in capsys.readouterr().err


def test_guard_keeps_the_strict_rule_for_the_original_spec_and_needs_the_fixture_env_for_later_ones(tmp_path, capsys):
    assert _guard(tmp_path, {evidence.NATIVE_SPEC: "await launchDesktop(buildAppEnv(sandbox))"}) == 1
    assert "does not drive the app through the isolated fixture" in capsys.readouterr().err
    (tmp_path / "e2e" / evidence.NATIVE_SPEC).unlink()
    assert _guard(tmp_path, {RESTART: "await launchDesktop({ ...process.env })"}) == 1
    assert f"{RESTART} does not drive the app through the isolated fixture" in capsys.readouterr().err


def test_guard_refuses_a_run_with_no_native_spec_at_all(tmp_path, capsys):
    assert _guard(tmp_path, {"unrelated.spec.ts": "setupMockBackend"}) == 1
    assert "no native spec under" in capsys.readouterr().err


def test_collect_copies_only_allowlisted_bounded_files(tmp_path):
    source = tmp_path / "results"
    (source / "case").mkdir(parents=True)
    (source / "case" / "trace.zip").write_bytes(b"z" * 10)
    (source / "case" / "shot.png").write_bytes(PNG)
    (source / "case" / "big.png").write_bytes(b"b" * 4096)
    (source / "case" / "config.yaml").write_text("secret: no", encoding="utf-8")
    (source / ".env").write_text("TOKEN=no", encoding="utf-8")
    dest = tmp_path / "artifact"
    code = evidence.main(["collect", "--dest", str(dest), "--max-file-mb", str(1024 / 1024 / 1024),
                          "--source", f"test-results={source}", "--source", f"absent={tmp_path / 'nope'}"])
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8-sig"))
    assert code == 0
    assert sorted(item["path"] for item in manifest["files"]) == ["test-results/case/shot.png", "test-results/case/trace.zip"]
    reasons = {item["path"]: item["reason"] for item in manifest["skipped"]}
    assert reasons == {"test-results/.env": "suffix", "test-results/case/big.png": "file-cap",
                       "test-results/case/config.yaml": "suffix"}
    assert manifest["missing_sources"] == ["absent"]
    assert not (dest / "test-results" / ".env").exists()


def test_collect_enforces_the_total_budget(tmp_path):
    source = tmp_path / "evidence"
    source.mkdir()
    for name in ("a.log", "b.log", "c.log"):
        (source / name).write_bytes(b"x" * 600)
    dest = tmp_path / "artifact"
    evidence.main(["collect", "--dest", str(dest), "--max-total-mb", str(1300 / 1024 / 1024), "--source", f"evidence={source}"])
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8-sig"))
    assert [item["path"] for item in manifest["files"]] == ["evidence/a.log", "evidence/b.log"]
    assert manifest["skipped"] == [{"path": "evidence/c.log", "bytes": 600, "reason": "total-cap"}]


def test_metadata_records_only_allowlisted_facts(tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    monkeypatch.setenv("SOME_SECRET_TOKEN", "must-not-appear")
    provenance = tmp_path / "source-provenance.json"
    provenance.write_text(json.dumps({"source_commit": "b6a1"}), encoding="utf-8")
    out = tmp_path / "run.json"
    assert evidence.main(["metadata", "--out", str(out), "--provenance", str(provenance), "--set", "pm.node=24.0.0"]) == 0
    data = json.loads(out.read_text(encoding="utf-8-sig"))
    assert data["GITHUB_SHA"] == "abc123" and data["pm.node"] == "24.0.0"
    assert data["source_provenance"] == {"source_commit": "b6a1"}
    assert "must-not-appear" not in out.read_text(encoding="utf-8-sig")


@pytest.mark.parametrize("outcomes, verdict, expected", [
    (["build=success", "native=success"], "passed", 0),
    (["build=success", "native=failure"], "passed", 1),
    (["build=success", "native=skipped"], "passed", 1),
    (["build=success", "native="], "passed", 1),
    (["build=success", "native=success"], "failed", 1),
    (["build=success", "native=success"], None, 1),
    ([], "passed", 1),
])
def test_gate_passes_only_when_every_step_and_the_evidence_succeeded(tmp_path, monkeypatch, outcomes, verdict, expected):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    args = ["gate"] + [arg for item in outcomes for arg in ("--outcome", item)]
    if verdict is not None:
        (tmp_path / "verdict.json").write_text(json.dumps({"verdict": verdict, "problems": []}), encoding="utf-8")
        args += ["--verify", str(tmp_path / "verdict.json")]
    assert evidence.main(args) == expected
    assert ("PASSED" if expected == 0 else "FAILED") in summary.read_text(encoding="utf-8-sig")


def _real_profile(tmp_path, monkeypatch):
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        (tmp_path / name).mkdir(exist_ok=True)
        monkeypatch.setenv(name, str(tmp_path / name))


def test_sentinels_list_a_bounded_set_of_entry_names_for_every_existing_location(tmp_path, monkeypatch):
    _real_profile(tmp_path, monkeypatch)
    leaked = tmp_path / "APPDATA" / "hermes-desktop"
    leaked.mkdir()
    for number in range(evidence.ENTRY_LIMIT + 10):
        (leaked / f"entry-{number:03d}").write_text("x", encoding="utf-8")
    snapshot = tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(snapshot)]) == 0
    assert json.loads(snapshot.read_text(encoding="utf-8-sig"))["dir:%APPDATA%/hermes-desktop"] is True
    listing = json.loads((tmp_path / "after.entries.json").read_text(encoding="utf-8-sig"))
    assert list(listing) == ["dir:%APPDATA%/hermes-desktop"], "only directories that exist are listed"
    detail = listing["dir:%APPDATA%/hermes-desktop"]
    assert detail["count"] == evidence.ENTRY_LIMIT + 10 and detail["truncated"] is True
    assert detail["entries"][:2] == ["entry-000", "entry-001"] and len(detail["entries"]) == evidence.ENTRY_LIMIT


def test_isolation_names_what_a_leaked_location_holds(tmp_path, monkeypatch, capsys):
    _real_profile(tmp_path, monkeypatch)
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before)]) == 0
    (tmp_path / "APPDATA" / "Hermes").mkdir()
    (tmp_path / "APPDATA" / "Hermes" / "Local Storage").mkdir()
    (tmp_path / "APPDATA" / "Hermes" / "Preferences").write_text("{}", encoding="utf-8")
    assert evidence.main(["sentinels", "--out", str(after)]) == 0
    capsys.readouterr()
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 1
    error = capsys.readouterr().err
    assert "real-install location: dir:%APPDATA%/Hermes (entries: Local Storage, Preferences)" in error


@pytest.mark.parametrize("name", ["hermes-updater", "hermes"])
def test_isolation_gates_the_installed_apps_updater_cache_and_home(tmp_path, monkeypatch, name):
    _real_profile(tmp_path, monkeypatch)
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before)]) == 0
    (tmp_path / "LOCALAPPDATA" / name).mkdir()
    assert evidence.main(["sentinels", "--out", str(after)]) == 0
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 1


def test_isolation_reports_but_never_gates_the_candidates_own_footprint(tmp_path, monkeypatch, capsys):
    _real_profile(tmp_path, monkeypatch)
    watch = ["--informational", "APPDATA/HermesBundledCommit0488ac4"]
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before), *watch]) == 0
    (tmp_path / "APPDATA" / "HermesBundledCommit0488ac4").mkdir()
    assert evidence.main(["sentinels", "--out", str(after), *watch]) == 0
    capsys.readouterr()
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after)]) == 0
    assert "candidate footprint: dir:%APPDATA%/HermesBundledCommit0488ac4" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        evidence.main(["sentinels", "--out", str(before), "--informational", "no-separator"])


def test_watched_locations_must_stay_absent_and_the_message_names_the_stage(tmp_path, monkeypatch, capsys):
    _real_profile(tmp_path, monkeypatch)
    watch = ["--watch", "APPDATA/HermesBundledCommit0488ac4", "--watch", "LOCALAPPDATA/hermes-clarify-candidate"]
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before), *watch]) == 0
    assert json.loads(before.read_text(encoding="utf-8-sig"))["dir:%APPDATA%/HermesBundledCommit0488ac4"] is False
    leaked = tmp_path / "LOCALAPPDATA" / "hermes-clarify-candidate"
    leaked.mkdir()
    (leaked / "config.yaml").write_text("x", encoding="utf-8")
    assert evidence.main(["sentinels", "--out", str(after), *watch]) == 0
    capsys.readouterr()
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after), "--label", "packaged"]) == 1
    error = capsys.readouterr().err
    assert "packaged run created a real-install location: dir:%LOCALAPPDATA%/hermes-clarify-candidate (entries: config.yaml)" in error
    with pytest.raises(SystemExit):
        evidence.main(["sentinels", "--out", str(before), "--watch", "no-separator"])


def test_a_watched_pattern_catches_whatever_new_entry_it_matches(tmp_path, monkeypatch, capsys):
    _real_profile(tmp_path, monkeypatch)
    watch = ["--watch", "APPDATA/Hermes*", "--watch", "LOCALAPPDATA/hermes-*"]
    before, after = tmp_path / "before.json", tmp_path / "after.json"
    assert evidence.main(["sentinels", "--out", str(before), *watch]) == 0
    snapshot = json.loads(before.read_text(encoding="utf-8-sig"))
    assert snapshot["dir:%APPDATA%/Hermes*"] is False and snapshot["dir:%LOCALAPPDATA%/hermes-*"] is False
    # Electron's default user data for the product name is a name nobody listed: only the pattern can see it.
    (tmp_path / "APPDATA" / "Hermes Agent 0488ac4").mkdir()
    (tmp_path / "APPDATA" / "Roaming-unrelated").mkdir()
    assert evidence.main(["sentinels", "--out", str(after), *watch]) == 0
    capsys.readouterr()
    assert evidence.main(["isolation", "--before", str(before), "--after", str(after), "--label", "packaged"]) == 1
    assert "real-install location: dir:%APPDATA%/Hermes* (entries: Hermes Agent 0488ac4)" in capsys.readouterr().err
    entries = json.loads((tmp_path / "after.entries.json").read_text(encoding="utf-8-sig"))
    assert list(entries) == ["dir:%APPDATA%/Hermes*"], "an unmatched pattern is not listed"


def test_verify_messages_name_what_is_being_verified(tmp_path, capsys):
    code, verdict = _verify(tmp_path, _report("unexpected"), _complete_evidence(tmp_path / "ev"), "--label", "packaged")
    assert code == 1 and verdict["verdict"] == "failed"
    captured = capsys.readouterr()
    assert "packaged evidence:" in captured.err and "packaged evidence verdict: failed" in captured.out


def test_gate_titles_the_summary_for_the_stage_that_wrote_it(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    (tmp_path / "verdict.json").write_text(json.dumps({"verdict": "passed", "problems": []}), encoding="utf-8")
    assert evidence.main(["gate", "--outcome", "accept=success", "--verify", str(tmp_path / "verdict.json"),
                          "--title", "Candidate acceptance", "--note", "Unsigned candidate."]) == 0
    text = summary.read_text(encoding="utf-8-sig")
    assert "## Candidate acceptance" in text and "Unsigned candidate." in text
