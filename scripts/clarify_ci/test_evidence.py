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


def _complete_evidence(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in evidence.NATIVE_SCREENSHOTS:
        (directory / name).write_bytes(PNG)
    (directory / evidence.NATIVE_OBSERVATIONS).write_text(json.dumps({
        "liveState": "saved", "liveText": "Draft saved", "timeoutSeconds": 25,
        "rowStates": [{"disk": "saved", "transcript": "saved"}, {"disk": "saved", "transcript": "saved"}],
    }), encoding="utf-8")
    return directory


def _verify(tmp_path: Path, report: dict | None, evidence_dir: Path) -> tuple[int, dict]:
    results = tmp_path / "results.json"
    if report is not None:
        results.write_text(json.dumps(report), encoding="utf-8")
    out = tmp_path / "verdict.json"
    code = evidence.main(["verify", "--evidence", str(evidence_dir), "--results", str(results), "--out", str(out)])
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
