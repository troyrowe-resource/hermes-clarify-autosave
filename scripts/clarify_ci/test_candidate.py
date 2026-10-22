"""Behaviour tests for scripts/clarify_ci/candidate.py (runs on Linux and Windows)."""

from __future__ import annotations

import importlib.util
import json
import os
import struct
import sys
import zipfile
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location("clarify_ci_candidate", Path(__file__).with_name("candidate.py"))
assert _SPEC is not None and _SPEC.loader is not None
candidate = importlib.util.module_from_spec(_SPEC)
sys.modules["clarify_ci_candidate"] = candidate
_SPEC.loader.exec_module(candidate)

COMMIT = "abcdef0123456789abcdef0123456789abcdef01"
EXE = "hermes-abcdef0.exe"
TEMPLATE = Path(__file__).with_name("candidate-package")


def _pe(certificate_bytes: int = 0, pe32_plus: bool = True, directories: int = 16) -> bytes:
    """A minimal PE header: DOS stub, PE signature, COFF header, optional header with its data directories."""
    optional_size = (112 if pe32_plus else 96) + directories * 8
    optional = bytearray(optional_size)
    struct.pack_into("<H", optional, 0, 0x20B if pe32_plus else 0x10B)
    count_at = 108 if pe32_plus else 92
    struct.pack_into("<I", optional, count_at, directories)
    if directories >= 5:
        base = (112 if pe32_plus else 96) + 4 * 8
        struct.pack_into("<II", optional, base, 0x1000 if certificate_bytes else 0, certificate_bytes)
    dos = bytearray(0x40)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 0x40)
    return bytes(dos) + b"PE\0\0" + bytes(20) + bytes(optional) + b"\0" * 64


def _stamp(**overrides) -> dict:
    runtime = {"repoDir": "hermes-agent", "toolsDir": "tools", "storePython": "tools/python/python.exe",
               "sitePackages": "venv/Lib/site-packages", "commands": {"hermes": f"bin/{EXE}"}}
    stamp = {"schemaVersion": 1, "commit": COMMIT, "dirty": False, "source": "commit-build", "payload": "bundled",
             "distribution": "desktop-app", "updateMechanism": "external", "tag": None, "branch": None,
             "displayVersion": "0.1.0", "baseVersion": "0.1.0", "builtAt": "2026-10-22T00:00:00Z", "runtime": runtime}
    stamp.update(overrides)
    return stamp


METHODS = '@method("clarify.draft")\n@method("clarify.drafts")\n@method("clarify.drafts.discard")\n'


def _fake_app(root: Path, **stamp_overrides) -> Path:
    app = root / "win-unpacked"
    resources = app / "resources"
    payload = resources / "agent-payload"
    repo = payload / "hermes-agent"
    for relative, data in {
        EXE: _pe(), "resources/app.asar": b"asar", "chrome_100_percent.pak": b"pak",
        "resources/agent-payload/tools/python/python.exe": _pe(),
        "resources/agent-payload/venv/Lib/site-packages/dep.py": b"x = 1\n",
        f"resources/agent-payload/bin/{EXE}": _pe(),
        "resources/agent-payload/hermes-agent/hermes_cli/main.py": b"",
        "resources/agent-payload/hermes-agent/tools/clarify_drafts.py": b"",
        "resources/agent-payload/hermes-agent/tui_gateway/methods_prompt.py": METHODS.encode(),
    }.items():
        path = app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    stamp = json.dumps(_stamp(**stamp_overrides), indent=2) + "\n"
    (resources / "install-stamp.json").write_text(stamp, encoding="utf-8")
    (repo / "install-stamp.json").write_text(stamp, encoding="utf-8")
    (payload / "manifest.json").write_text(json.dumps({
        "target": "win32-x64", "launchers": ["hermes-abcdef0"], "runtime": _stamp()["runtime"]}), encoding="utf-8")
    return app


def _problems(app: Path, **kwargs) -> list[str]:
    return candidate.audit_app(app, COMMIT, **kwargs)[1]


def test_pe_certificate_table_size_reads_the_security_directory(tmp_path):
    for pe32_plus in (True, False):
        path = tmp_path / "x.exe"
        path.write_bytes(_pe(0, pe32_plus))
        assert candidate.pe_certificate_table_size(path) == 0
        path.write_bytes(_pe(4321, pe32_plus))
        assert candidate.pe_certificate_table_size(path) == 4321
    path.write_bytes(_pe(directories=2))
    assert candidate.pe_certificate_table_size(path) == 0, "an image that declares no security directory is unsigned"
    path.write_bytes(b"#!/bin/sh\n" + b"x" * 200)
    assert candidate.pe_certificate_table_size(path) is None
    path.write_bytes(b"MZ" + b"\0" * 10)
    assert candidate.pe_certificate_table_size(path) is None


def test_audit_accepts_a_bundled_one_commit_build_and_describes_it(tmp_path):
    facts, problems = candidate.audit_app(_fake_app(tmp_path), COMMIT, {"status": "NotSigned", "subject": None})
    assert problems == []
    assert facts["exe"]["pe_certificate_table_bytes"] == 0 and facts["exe"]["authenticode"]["status"] == "NotSigned"
    assert facts["stamp"]["updateMechanism"] == "external" and facts["stamp"]["source"] == "commit-build"
    assert facts["payload"]["manifest_target"] == "win32-x64" and facts["file_count"] == 12


@pytest.mark.parametrize("overrides, needle", [
    ({"updateMechanism": "self"}, "updateMechanism='self'"),
    ({"source": "git"}, "source='git'"),
    ({"payload": "bootstrap"}, "payload='bootstrap'"),
    ({"dirty": True}, "dirty=True"),
    ({"commit": "f" * 40}, "commit='" + "f" * 40),
    ({"tag": "v1.2.3"}, "tag='v1.2.3'"),
    ({"runtime": {}}, "no completed runtime launch contract"),
])
def test_audit_refuses_a_stamp_that_is_not_the_one_commit_bundled_build(tmp_path, overrides, needle):
    problems = _problems(_fake_app(tmp_path, **overrides))
    assert any(needle in problem for problem in problems), problems


def test_audit_refuses_an_app_that_could_update_itself_or_is_an_installer(tmp_path):
    app = _fake_app(tmp_path)
    (app / "resources" / "app-update.yml").write_text("provider: generic\n", encoding="utf-8")
    (app / "Hermes.msix").write_bytes(b"pkg")
    problems = _problems(app)
    assert any("update feed" in problem for problem in problems)
    assert any("package/installer artifacts" in problem and "Hermes.msix" in problem for problem in problems)


def test_audit_refuses_a_payload_without_the_autosave_rpcs_or_with_a_different_stamp(tmp_path):
    app = _fake_app(tmp_path)
    prompt = app / "resources/agent-payload/hermes-agent/tui_gateway/methods_prompt.py"
    prompt.write_text('@method("clarify.draft")\n', encoding="utf-8")
    (app / "resources/agent-payload/hermes-agent/install-stamp.json").write_text("{}", encoding="utf-8")
    (app / "resources/agent-payload/hermes-agent/.env").write_text("SECRET=1", encoding="utf-8")
    problems = _problems(app)
    assert any('does not register @method("clarify.drafts")' in problem for problem in problems)
    assert any("differs from resources/install-stamp.json" in problem for problem in problems)
    assert any("payload carries .env" in problem for problem in problems)


def test_audit_refuses_a_missing_executable_runtime_or_wrong_target(tmp_path):
    app = _fake_app(tmp_path)
    (app / EXE).unlink()
    (app / "resources/agent-payload/tools/python/python.exe").unlink()
    manifest = app / "resources/agent-payload/manifest.json"
    manifest.write_text(json.dumps({"target": "win32-arm64", "runtime": _stamp()["runtime"]}), encoding="utf-8")
    problems = _problems(app)
    assert any(f"missing product executable {EXE}" in problem for problem in problems)
    assert any("runtime.storePython" in problem for problem in problems)
    assert any("payload target 'win32-arm64'" in problem for problem in problems)


def test_audit_refuses_a_valid_signature_but_records_an_invalid_one(tmp_path):
    app = _fake_app(tmp_path)
    assert any("VALID Authenticode" in p for p in _problems(app, authenticode={"status": "Valid", "subject": "CN=Someone"}))
    assert _problems(app, authenticode={"status": "HashMismatch", "subject": "CN=Electron"}) == []


@pytest.mark.skipif(sys.platform == "win32", reason="creating a symlink needs a privilege on Windows")
def test_audit_refuses_links_that_a_zip_cannot_carry(tmp_path):
    app = _fake_app(tmp_path)
    os.symlink(app / "resources" / "app.asar", app / "resources" / "alias.asar")
    assert any("symlinks/junctions" in problem for problem in _problems(app))


def test_find_unpacked_wants_exactly_one_bundled_app_with_the_commits_executable(tmp_path):
    release = tmp_path / "release"
    _fake_app(release)
    assert candidate.find_unpacked(release, COMMIT) == release / "win-unpacked"
    with pytest.raises(candidate.CandidateError, match="has no hermes-1111111.exe"):
        candidate.find_unpacked(release, "1" * 40)
    (release / "win-arm64-unpacked" / "resources" / "agent-payload").mkdir(parents=True)
    (release / "win-arm64-unpacked" / "resources" / "agent-payload" / "manifest.json").write_text("{}", encoding="utf-8")
    with pytest.raises(candidate.CandidateError, match="exactly one"):
        candidate.find_unpacked(release, COMMIT)
    with pytest.raises(candidate.CandidateError, match="exactly one"):
        candidate.find_unpacked(tmp_path / "nothing", COMMIT)


def _assemble(tmp_path, app=None, **overrides):
    app = app or _fake_app(tmp_path)
    provenance = tmp_path / "source-provenance.json"
    provenance.write_text(json.dumps({"source_commit": "b6a1"}), encoding="utf-8")
    env = {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_REPOSITORY": "o/r", "GITHUB_SERVER_URL": "https://github.com",
           "GITHUB_SHA": COMMIT, "SECRET_TOKEN": "must-not-appear"}
    out = tmp_path / "out"
    manifest = candidate.assemble(app, COMMIT, TEMPLATE, out, max_zip_bytes=overrides.pop("max_zip_bytes", 1 << 30),
                                  provenance=provenance, authenticode={"status": "NotSigned", "subject": None}, env=env)
    return app, out, manifest


def test_assemble_builds_a_zip_whose_manifest_digests_and_prerequisites_describe_it(tmp_path):
    app, out, manifest = _assemble(tmp_path)
    name = f"HermesClarifyCandidate-{COMMIT[:7]}"
    archive = out / f"{name}-win-x64.zip"
    assert manifest["archive"]["name"] == archive.name and manifest["archive"]["bytes"] == archive.stat().st_size
    assert manifest["archive"]["sha256"] == candidate._sha256(archive)
    assert manifest["source"]["commit"] == COMMIT and manifest["source"]["provenance"] == {"source_commit": "b6a1"}
    assert manifest["build"]["run_url"] == "https://github.com/o/r/actions/runs/42"
    assert manifest["signing"]["status"] == "unsigned" and manifest["publication"]["status"] == "disabled"
    assert manifest["publication"]["electron_builder_publish"] == "never"
    assert manifest["app"]["exe"] == f"app/{EXE}" and manifest["app"]["exe_sha256"] == candidate._sha256(app / EXE)
    assert any("windows-2025" in line for line in manifest["runtime_prerequisites"])
    assert "must-not-appear" not in json.dumps(manifest)
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert all(item.startswith(f"{name}/") for item in names)
        assert {f"{name}/MANIFEST.json", f"{name}/FILES.sha256", f"{name}/app/{EXE}",
                f"{name}/Start-HermesClarifyCandidate.cmd", f"{name}/launcher/Start-HermesClarifyCandidate.ps1"} <= set(names)
        inner = json.loads(bundle.read(f"{name}/MANIFEST.json"))
        readme = bundle.read(f"{name}/README-CANDIDATE.txt").decode("utf-8")
    assert {key: inner[key] for key in ("package", "source", "files", "app")} == {key: manifest[key] for key in ("package", "source", "files", "app")}
    assert COMMIT in readme and "@COMMIT@" not in readme and "actions/runs/42" in readme
    sums = (out / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines()
    assert sums[0] == f"{manifest['archive']['sha256']}  {archive.name}"
    assert sums[1].endswith("  MANIFEST.json") and sums[1].split()[0] == candidate._sha256(out / "MANIFEST.json")


def test_assemble_refuses_an_app_that_fails_the_audit(tmp_path):
    with pytest.raises(candidate.CandidateError, match="not a valid candidate"):
        _assemble(tmp_path, _fake_app(tmp_path, updateMechanism="self"))


def test_assemble_refuses_an_archive_over_its_bound(tmp_path):
    with pytest.raises(candidate.CandidateError, match="over the 10-byte bound"):
        _assemble(tmp_path, max_zip_bytes=10)


def test_verify_accepts_what_assemble_wrote_and_extracts_a_usable_package(tmp_path):
    _, out, manifest = _assemble(tmp_path)
    archive = out / manifest["archive"]["name"]
    facts, problems = candidate.verify_archive(archive, out / "MANIFEST.json", tmp_path / "extracted", COMMIT)
    assert problems == [], problems
    root = tmp_path / "extracted" / manifest["package"]
    assert facts["sha256"] == manifest["archive"]["sha256"] and facts["files_checked"] == manifest["files"]["count"]
    assert (root / "app" / EXE).read_bytes() == _pe() and (root / "launcher" / "CandidateCommon.ps1").is_file()


def _rewrite_zip(source: Path, destination: Path, edit) -> None:
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as new:
        for item in old.infolist():
            data = edit(item.filename, old.read(item.filename))
            if data is not None:
                new.writestr(item.filename, data)


def _outer_for(tmp_path: Path, manifest: dict, tampered: Path) -> Path:
    """An outer manifest that vouches for the tampered archive, so only the per-file checks can object."""
    forged = {**manifest, "archive": {**manifest["archive"], "name": tampered.name, "bytes": tampered.stat().st_size,
                                      "sha256": candidate._sha256(tampered)}}
    path = tmp_path / "forged-MANIFEST.json"
    path.write_text(json.dumps(forged), encoding="utf-8")
    return path


def test_verify_refuses_an_archive_that_is_not_the_one_the_manifest_names(tmp_path):
    _, out, manifest = _assemble(tmp_path)
    tampered = tmp_path / "t.zip"
    tampered.write_bytes((out / manifest["archive"]["name"]).read_bytes() + b"\0")
    _, problems = candidate.verify_archive(tampered, out / "MANIFEST.json", tmp_path / "x", COMMIT)
    joined = " ".join(problems)
    assert "differs from the manifest's" in joined and "manifest says" in joined


def test_verify_refuses_a_changed_unlisted_or_missing_file_even_when_the_archive_digest_matches(tmp_path):
    _, out, manifest = _assemble(tmp_path)
    source = out / manifest["archive"]["name"]
    name = manifest["package"]

    def edit(member, data):
        if member == f"{name}/app/{EXE}":
            return data + b"tampered"
        if member == f"{name}/app/chrome_100_percent.pak":
            return None
        return data

    tampered = tmp_path / "tampered.zip"
    _rewrite_zip(source, tampered, edit)
    with zipfile.ZipFile(tampered, "a") as bundle:
        bundle.writestr(f"{name}/app/extra.dll", b"unlisted")
    _, problems = candidate.verify_archive(tampered, _outer_for(tmp_path, manifest, tampered), tmp_path / "x", COMMIT)
    joined = " ".join(problems)
    assert "differ from FILES.sha256" in joined and "not listed in FILES.sha256" in joined
    assert "listed file(s) are missing after extraction" in joined and "differs from the manifest's exe sha256" in joined


def test_verify_refuses_members_outside_the_package_folder_and_a_foreign_commit(tmp_path):
    _, out, manifest = _assemble(tmp_path)
    escaped = tmp_path / "escape.zip"
    _rewrite_zip(out / manifest["archive"]["name"], escaped, lambda member, data: data)
    with zipfile.ZipFile(escaped, "a") as bundle:
        bundle.writestr("elsewhere/evil.txt", b"x")
    with pytest.raises(candidate.CandidateError, match="outside"):
        candidate.verify_archive(escaped, _outer_for(tmp_path, manifest, escaped), tmp_path / "x", COMMIT)
    _, problems = candidate.verify_archive(out / manifest["archive"]["name"], out / "MANIFEST.json", tmp_path / "y", "1" * 40)
    assert any("expected " + "1" * 40 in problem for problem in problems)
    with pytest.raises(candidate.CandidateError, match="not empty"):
        candidate.verify_archive(out / manifest["archive"]["name"], out / "MANIFEST.json", tmp_path / "y", COMMIT)


def test_cli_audit_assemble_and_verify_round_trip(tmp_path, monkeypatch, capsys):
    app = _fake_app(tmp_path)
    monkeypatch.setenv("GITHUB_RUN_ID", "7")
    audit = tmp_path / "audit.json"
    assert candidate.main(["audit", "--app", str(app), "--commit", COMMIT, "--out", str(audit)]) == 0
    assert json.loads(audit.read_text(encoding="utf-8"))["verdict"] == "passed"
    assert candidate.main(["assemble", "--app", str(app), "--commit", COMMIT, "--template", str(TEMPLATE),
                           "--out-dir", str(tmp_path / "out"), "--provenance", str(tmp_path / "none.json")]) == 0
    archive = next((tmp_path / "out").glob("*.zip"))
    verdict = tmp_path / "verdict.json"
    assert candidate.main(["verify", "--zip", str(archive), "--manifest", str(tmp_path / "out" / "MANIFEST.json"),
                           "--extract-to", str(tmp_path / "x"), "--commit", COMMIT, "--out", str(verdict)]) == 0
    assert json.loads(verdict.read_text(encoding="utf-8"))["verdict"] == "passed"
    assert candidate.main(["audit", "--app", str(_fake_app(tmp_path / "bad", source="git")), "--commit", COMMIT,
                           "--out", str(audit)]) == 1
    assert "source='git'" in capsys.readouterr().err
    assert candidate.main(["locate", "--release-dir", str(tmp_path / "missing"), "--commit", COMMIT]) == 1


def test_the_shipped_template_has_every_file_the_manifest_and_readme_promise():
    shipped = sorted(path.relative_to(TEMPLATE).as_posix() for path in TEMPLATE.rglob("*") if path.is_file())
    assert shipped == ["README-CANDIDATE.txt", "Start-HermesClarifyCandidate.cmd", "Stop-HermesClarifyCandidate.cmd",
                       "launcher/CandidateCommon.ps1", "launcher/Start-HermesClarifyCandidate.ps1",
                       "launcher/Stop-HermesClarifyCandidate.ps1"]
    readme = (TEMPLATE / "README-CANDIDATE.txt").read_text(encoding="utf-8")
    for placeholder in ("@COMMIT@", "@SHA7@", "@EXE@", "@RUN_URL@"):
        assert placeholder in readme
    assert "Start-HermesClarifyCandidate.cmd" in readme and "Stop-HermesClarifyCandidate.cmd" in readme
