"""Package, describe and verify the unsigned Windows candidate (stdlib only).

  locate    find the electron-builder ``win*-unpacked`` directory and its single product exe
  audit     the unpacked app is the bundled commit-build the manifest is about to describe
  assemble  zip app + launcher + MANIFEST.json + FILES.sha256 into one bounded archive, plus the
            outer MANIFEST.json and SHA256SUMS.txt that name that archive's own digest
  verify    a downloaded archive matches its manifest; extract it and re-hash every file
  verdict   fold the verification, the packaged-app evidence and the step outcomes into one acceptance verdict
  outputs   the facts later jobs need (zip name and digest, artifact name) as GitHub step outputs
  bundle-env  the JSON the build bakes into the app (HERMES_BUNDLE_ENV_JSON), which the audit requires

The archive holds one top-level folder ``HermesClarifyCandidate-<sha7>``::

    Start-HermesClarifyCandidate.cmd, Stop-HermesClarifyCandidate.cmd, README-CANDIDATE.txt
    launcher/*.ps1                     the isolating launcher (the only supported way to start it)
    app/<product>.exe, app/resources/  the packaged, unsigned app (never installed, never published)
    MANIFEST.json, FILES.sha256        what the archive claims, and the digest of every other file

The outer ``MANIFEST.json`` repeats the inner one and adds the archive's own size and sha256, which
cannot live inside the archive it describes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PACKAGE_PREFIX = "HermesClarifyCandidate"
FILES_LIST = "FILES.sha256"
MANIFEST = "MANIFEST.json"
SHA_LINE = re.compile(r"([0-9a-f]{64})  (.+)")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
RECORDED_ENV = (
    "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW", "GITHUB_SERVER_URL", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
)
# Non-secret defaults the build bakes into the app's main bundle (HERMES_BUNDLE_ENV_JSON, apps/desktop/BUILDING.md):
# a default home and Electron user-data directory of the candidate's own, and no inherited or registry HERMES_HOME.
# This is what keeps a double-click start WITHOUT the launcher out of the user's real Hermes home. The launcher
# sets the same suffix, and passes HERMES_DESKTOP_USER_DATA_DIR, from which the app derives its sandbox home.
BUNDLE_ENV: dict[str, str | None] = {"HERMES_DATA_DIR_SUFFIX": "-clarify-candidate", "HERMES_HOME": None}
WINDOWS_TEXT = (".cmd", ".ps1", ".txt")
# Source files the shipped payload must carry for the autosave RPCs to exist at all.
CLARIFY_RPCS = ('@method("clarify.draft")', '@method("clarify.drafts")', '@method("clarify.drafts.discard")')
RUNTIME_PREREQUISITES = (
    "Windows on x64. It was built and started only on a GitHub-hosted windows-2025 x64 runner (Windows Server 2025, "
    "build 26100). Electron 40 needs Windows 10 or newer, but the project's own MSIX packaging floor is Windows 11 22H2 "
    "(build 22621); nothing older than the runner was tried.",
    "No Python, Node, Git or Hermes installation is required: the candidate carries its own interpreter, "
    "dependencies, tools and this commit's source under app/resources/agent-payload.",
    "The Microsoft Visual C++ 2015-2022 x64 redistributable is assumed present (ordinary on Windows 10/11).",
    "About twice the zip size in free disk space: the extracted folder plus the isolated candidate home.",
    "Network access only for what you configure (a model provider or a Hermes server); none is needed to start.",
    "Start it only through Start-HermesClarifyCandidate.cmd: it isolates every state location and refuses "
    "to run against a real Hermes home. Unsigned downloads trigger SmartScreen; unblock the zip before extracting.",
)


class CandidateError(Exception):
    """A claim about the candidate does not hold."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def package_name(commit: str) -> str:
    if not FULL_SHA.fullmatch(commit):
        raise CandidateError(f"expected a full lowercase 40-character commit, got {commit!r}")
    return f"{PACKAGE_PREFIX}-{commit[:7]}"


def exe_name(commit: str) -> str:
    """The product executable of a commit build: its CLI name, ``hermes-<sha7>`` (product-identity.cjs)."""
    return f"hermes-{commit[:7]}.exe"


def _is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def tree_files(root: Path) -> tuple[list[Path], list[str]]:
    """Every regular file under ``root`` (sorted), and the symlinks/junctions that make a zip non-portable."""
    files: list[Path] = []
    links: list[str] = []
    for current, directories, names in os.walk(root):
        here = Path(current)
        for name in list(directories):
            if _is_link(here / name):
                links.append((here / name).relative_to(root).as_posix())
                directories.remove(name)
        for name in names:
            path = here / name
            if _is_link(path):
                links.append(path.relative_to(root).as_posix())
            else:
                files.append(path)
    return sorted(files), sorted(links)


def _sha256_many(paths: list[Path], workers: int = 4) -> list[str]:
    """Digests of many files in parallel (hashlib releases the GIL while it hashes)."""
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_sha256, paths))


def digest_files(root: Path, files: list[Path]) -> list[tuple[str, int, str]]:
    """``(posix path relative to root, size, sha256)`` for every file."""
    return [(path.relative_to(root).as_posix(), path.stat().st_size, digest)
            for path, digest in zip(files, _sha256_many(files))]


def pe_certificate_table_size(path: Path) -> int | None:
    """Size of the Authenticode certificate table a PE image declares (0: none), or None if not a PE32/PE32+."""
    with path.open("rb") as stream:
        head = stream.read(0x40)
        if len(head) < 0x40 or head[:2] != b"MZ":
            return None
        pe_offset = struct.unpack_from("<I", head, 0x3C)[0]
        stream.seek(pe_offset)
        header = stream.read(24 + 112 + 16 * 8)
    if len(header) < 24 + 96 or header[:4] != b"PE\0\0":
        return None
    magic = struct.unpack_from("<H", header, 24)[0]
    if magic not in (0x10B, 0x20B):
        return None
    directories = 24 + (96 if magic == 0x10B else 112)
    count_at = directories - 4
    if struct.unpack_from("<I", header, count_at)[0] < 5 or len(header) < directories + 5 * 8:
        return 0
    return struct.unpack_from("<I", header, directories + 4 * 8 + 4)[0]


def find_unpacked(release_dir: Path, commit: str) -> Path:
    """The one electron-builder ``win*-unpacked`` directory that holds this commit's bundled payload."""
    found = sorted(
        path for path in release_dir.glob("win*-unpacked")
        if (path / "resources" / "agent-payload" / "manifest.json").is_file()
    )
    if len(found) != 1:
        listing = ", ".join(sorted(child.name for child in release_dir.iterdir())[:30]) if release_dir.is_dir() else "(no such directory)"
        raise CandidateError(f"expected exactly one win*-unpacked bundled app under {release_dir}, found {len(found)}; contents: {listing}")
    if not (found[0] / exe_name(commit)).is_file():
        tops = sorted(child.name for child in found[0].iterdir() if child.suffix.lower() == ".exe")
        raise CandidateError(f"{found[0]} has no {exe_name(commit)}; executables: {tops}")
    return found[0]


def audit_app(app: Path, commit: str, authenticode: dict | None = None) -> tuple[dict, list[str]]:
    """Facts about the unpacked app and every reason it is not the bundled, updater-less commit build."""
    problems: list[str] = []
    facts: dict[str, object] = {"app_dir": str(app)}
    exe = app / exe_name(commit)
    resources = app / "resources"
    if not exe.is_file():
        problems.append(f"missing product executable {exe_name(commit)}")
    else:
        size = pe_certificate_table_size(exe)
        exe_facts: dict[str, object] = {"name": exe.name, "bytes": exe.stat().st_size, "pe_certificate_table_bytes": size}
        if size is None:
            problems.append(f"{exe.name} is not a PE executable")
        if authenticode is not None:
            exe_facts["authenticode"] = authenticode
            if authenticode.get("status") == "Valid":
                problems.append(f"{exe.name} carries a VALID Authenticode signature; this pipeline cannot have made one")
        facts["exe"] = exe_facts
    if not (resources / "app.asar").is_file():
        problems.append("missing resources/app.asar")
    for feed in ("app-update.yml", "dev-app-update.yml"):
        if (resources / feed).exists():
            problems.append(f"resources/{feed} is an update feed; a candidate must not be able to update itself")
    msix = sorted(path.name for path in app.rglob("*") if path.suffix.lower() in (".msix", ".msixbundle", ".appx", ".appinstaller"))
    if msix:
        problems.append(f"package/installer artifacts inside the app directory: {msix}")

    stamp, payload = _audit_stamp(resources, commit, problems), _audit_payload(resources, commit, problems)
    facts["stamp"] = stamp
    facts["payload"] = payload
    files, links = tree_files(app)
    facts["file_count"] = len(files)
    facts["total_bytes"] = sum(path.stat().st_size for path in files)
    if links:
        problems.append(f"symlinks/junctions would not survive a zip: {links[:5]}")
    return facts, problems


def _audit_stamp(resources: Path, commit: str, problems: list[str]) -> dict:
    path = resources / "install-stamp.json"
    try:
        stamp = _read_json(path)
    except (OSError, ValueError) as error:
        problems.append(f"unreadable resources/install-stamp.json: {error}")
        return {}
    expected = {"payload": "bundled", "source": "commit-build", "updateMechanism": "external",
                "commit": commit, "dirty": False, "tag": None, "distribution": "desktop-app"}
    for key, value in expected.items():
        if stamp.get(key) != value:
            problems.append(f"install stamp {key}={stamp.get(key)!r}, expected {value!r}")
    if stamp.get("bundleEnv") != BUNDLE_ENV:
        problems.append(f"install stamp bundleEnv={stamp.get('bundleEnv')!r}, expected {BUNDLE_ENV!r}: "
                        "a start without the launcher would not stay out of the real Hermes home")
    runtime = stamp.get("runtime")
    if not isinstance(runtime, dict) or not runtime.get("commands", {}).get("hermes"):
        problems.append("install stamp has no completed runtime launch contract")
    return {key: stamp.get(key) for key in (*expected, "displayVersion", "baseVersion", "builtAt", "bundleEnv", "runtime")}


def _audit_payload(resources: Path, commit: str, problems: list[str]) -> dict:
    root = resources / "agent-payload"
    try:
        manifest = _read_json(root / "manifest.json")
    except (OSError, ValueError) as error:
        problems.append(f"unreadable agent-payload/manifest.json: {error}")
        return {}
    if manifest.get("target") != "win32-x64":
        problems.append(f"payload target {manifest.get('target')!r}, expected 'win32-x64'")
    runtime = manifest.get("runtime") or {}
    for key in ("repoDir", "toolsDir", "storePython", "sitePackages"):
        relative = runtime.get(key)
        if not relative or not (root / relative).exists():
            problems.append(f"payload runtime.{key}={relative!r} does not exist")
    for name, relative in (runtime.get("commands") or {}).items():
        if not (root / relative).is_file():
            problems.append(f"payload command {name} -> {relative} is missing")
    repo = root / runtime.get("repoDir", "app")
    for relative in ("hermes_cli/main.py", "tools/clarify_drafts.py", "tui_gateway/methods_prompt.py"):
        if not (repo / relative).is_file():
            problems.append(f"payload source lacks {relative}")
    prompt = repo / "tui_gateway" / "methods_prompt.py"
    if prompt.is_file():
        text = prompt.read_text(encoding="utf-8-sig", errors="replace")
        problems += [f"payload source does not register {rpc}" for rpc in CLARIFY_RPCS if rpc not in text]
    inner = repo / "install-stamp.json"
    outer = resources / "install-stamp.json"
    if not inner.is_file() or not outer.is_file() or inner.read_bytes() != outer.read_bytes():
        problems.append("the payload's install-stamp.json differs from resources/install-stamp.json")
    for secret in (".env", ".op.env", "auth.json", "config.yaml"):
        if (repo / secret).exists() or (root / secret).exists():
            problems.append(f"payload carries {secret}")
    return {"manifest_target": manifest.get("target"), "launchers": manifest.get("launchers"), "runtime": runtime}


def _crlf(data: bytes) -> bytes:
    """Windows line endings whatever the checkout produced: cmd.exe mis-parses labels in an LF-only batch file."""
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def _render(template: str, replacements: dict[str, str]) -> str:
    for key, value in replacements.items():
        template = template.replace(f"@{key}@", value)
    return template


def _env_facts(env: dict[str, str]) -> dict[str, str | None]:
    return {name: env.get(name) for name in RECORDED_ENV}


def _run_url(env: dict[str, str]) -> str:
    server, repository, run = env.get("GITHUB_SERVER_URL"), env.get("GITHUB_REPOSITORY"), env.get("GITHUB_RUN_ID")
    return f"{server}/{repository}/actions/runs/{run}" if server and repository and run else ""


def assemble(app: Path, commit: str, template: Path, out_dir: Path, *, max_zip_bytes: int,
             provenance: Path | None, authenticode: dict | None, env: dict[str, str]) -> dict:
    """Build the archive and its manifests; returns the outer manifest."""
    facts, problems = audit_app(app, commit, authenticode)
    if problems:
        raise CandidateError("the unpacked app is not a valid candidate: " + "; ".join(problems))
    name = package_name(commit)
    exe = app / exe_name(commit)
    files, _ = tree_files(app)
    entries = [(f"app/{relative}", size, digest) for relative, size, digest in digest_files(app, files)]
    shipped: dict[str, bytes] = {}
    replacements = {"COMMIT": commit, "SHA7": commit[:7], "EXE": f"app/{exe.name}", "EXE_NAME": exe.name,
                    "RUN_URL": _run_url(env) or "(local build)"}
    for source in sorted(path for path in template.rglob("*") if path.is_file()):
        relative = source.relative_to(template).as_posix()
        data = source.read_bytes()
        if relative.endswith(".txt"):
            data = _render(data.decode("utf-8"), replacements).encode("utf-8")
        shipped[relative] = _crlf(data) if relative.endswith(WINDOWS_TEXT) else data
    entries += [(relative, len(data), hashlib.sha256(data).hexdigest()) for relative, data in sorted(shipped.items())]
    entries.sort()
    listing = "".join(f"{digest}  {relative}\n" for relative, _, digest in entries).encode("utf-8")
    exe_digest = next(digest for relative, _, digest in entries if relative == f"app/{exe.name}")
    provenance_data = _read_json(provenance) if provenance and provenance.is_file() else None
    inner = {
        "schema": 1,
        "kind": "hermes-clarify-autosave-windows-candidate",
        "package": name,
        "source": {"commit": commit, "repository": env.get("GITHUB_REPOSITORY"), "ref": env.get("GITHUB_REF_NAME"),
                   "provenance": provenance_data},
        "build": {**_env_facts(env), "run_url": _run_url(env)},
        "app": {"exe": f"app/{exe.name}", "exe_sha256": exe_digest, "exe_bytes": exe.stat().st_size,
                "stamp": facts["stamp"], "payload": facts["payload"], "file_count": facts["file_count"],
                "total_bytes": facts["total_bytes"], "exe_signature": facts["exe"]},
        "files": {"list": FILES_LIST, "list_sha256": hashlib.sha256(listing).hexdigest(), "count": len(entries)},
        "launcher": [relative for relative in sorted(shipped) if relative.endswith((".ps1", ".cmd"))],
        "runtime_prerequisites": list(RUNTIME_PREREQUISITES),
        "signing": {"status": "unsigned",
                    "detail": "No code-signing credential exists in or reaches this pipeline. The product executable "
                              "is not signed by Nous Research or by this repository; Windows will treat the download as "
                              "untrusted. This is a private candidate, not an official Hermes release."},
        "publication": {"status": "disabled", "electron_builder_publish": "never", "github_release": False,
                        "installer": False, "auto_update": "disabled (commit-build stamp: updater is external and refuses)"},
        "verification": {"native_gate": "see the workflow run summary; this manifest is written before acceptance",
                         "packaged_acceptance": "see the acceptance artifact's acceptance-verdict.json for this zip's sha256"},
    }
    inner_bytes = (json.dumps(inner, indent=2, sort_keys=True) + "\n").encode("utf-8")
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"{name}-win-x64.zip"
    _write_zip(archive, name, [(app / relative.removeprefix("app/"), f"{name}/{relative}") for relative, _, _ in entries
                               if relative.startswith("app/")],
               {**{f"{name}/{relative}": data for relative, data in shipped.items()},
                f"{name}/{FILES_LIST}": listing, f"{name}/{MANIFEST}": inner_bytes})
    size = archive.stat().st_size
    if size > max_zip_bytes:
        raise CandidateError(f"{archive.name} is {size} bytes, over the {max_zip_bytes}-byte bound")
    outer = {**inner, "archive": {"name": archive.name, "bytes": size, "sha256": _sha256(archive), "top_level": name}}
    _write_json(out_dir / MANIFEST, outer)
    (out_dir / "SHA256SUMS.txt").write_text(
        f"{outer['archive']['sha256']}  {archive.name}\n{_sha256(out_dir / MANIFEST)}  {MANIFEST}\n", encoding="utf-8")
    return outer


def _write_zip(archive: Path, name: str, disk: list[tuple[Path, str]], memory: dict[str, bytes]) -> None:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as bundle:
        for source, arcname in disk:
            bundle.write(source, arcname)
        for arcname, data in sorted(memory.items()):
            bundle.writestr(arcname, data)


def verify_archive(archive: Path, manifest_path: Path, extract_to: Path, commit: str | None,
                   expected_sha256: str | None = None) -> tuple[dict, list[str]]:
    """Check a downloaded archive against its outer manifest, extract it, and re-hash every file.

    ``expected_sha256`` is a digest that travelled by another route than the artifact (a job output), so an
    archive and a manifest that were swapped together still disagree with it."""
    problems: list[str] = []
    outer = _read_json(manifest_path)
    claim = outer.get("archive") or {}
    facts: dict[str, object] = {"archive": archive.name, "bytes": archive.stat().st_size}
    if archive.name != claim.get("name"):
        problems.append(f"archive is named {archive.name}, manifest says {claim.get('name')}")
    if archive.stat().st_size != claim.get("bytes"):
        problems.append(f"archive is {archive.stat().st_size} bytes, manifest says {claim.get('bytes')}")
    digest = _sha256(archive)
    facts["sha256"] = digest
    if digest != claim.get("sha256"):
        problems.append(f"archive sha256 {digest} differs from the manifest's {claim.get('sha256')}")
    if expected_sha256 and digest != expected_sha256:
        problems.append(f"archive sha256 {digest} differs from the {expected_sha256} the build job reported")
    source = outer.get("source") or {}
    if commit and source.get("commit") != commit:
        problems.append(f"manifest names commit {source.get('commit')}, expected {commit}")
    if extract_to.exists() and any(extract_to.iterdir()):
        raise CandidateError(f"extraction target is not empty: {extract_to}")
    extract_to.mkdir(parents=True, exist_ok=True)
    top = claim.get("top_level") or outer.get("package")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        outside = [item for item in names if item.split("/", 1)[0] != top]
        if outside:
            raise CandidateError(f"archive members outside {top}/: {outside[:5]}")
        bundle.extractall(extract_to)
    root = extract_to / top
    inner = _read_json(root / MANIFEST)
    for key in ("package", "source", "files", "app"):
        if inner.get(key) != outer.get(key):
            problems.append(f"inner MANIFEST.json {key} differs from the outer manifest")
    listing = (root / FILES_LIST).read_bytes()
    if hashlib.sha256(listing).hexdigest() != inner["files"]["list_sha256"]:
        problems.append("FILES.sha256 does not match the digest in MANIFEST.json")
    expected: dict[str, tuple[str, str]] = {}
    for line in listing.decode("utf-8").splitlines():
        match = SHA_LINE.fullmatch(line)
        if not match:
            problems.append(f"malformed FILES.sha256 line: {line[:80]!r}")
            continue
        expected[match.group(2)] = (match.group(1), line)
    present, links = tree_files(root)
    if links:
        problems.append(f"extracted tree contains links: {links[:5]}")
    relatives = {path.relative_to(root).as_posix(): path for path in present}
    unlisted = sorted(set(relatives) - set(expected) - {FILES_LIST, MANIFEST})
    missing = sorted(set(expected) - set(relatives))
    if unlisted:
        problems.append(f"{len(unlisted)} extracted file(s) are not listed in FILES.sha256, e.g. {unlisted[:3]}")
    if missing:
        problems.append(f"{len(missing)} listed file(s) are missing after extraction, e.g. {missing[:3]}")
    checked = sorted(set(relatives) & set(expected))
    actual = _sha256_many([relatives[name] for name in checked])
    bad = [name for name, digest_ in zip(checked, actual) if digest_ != expected[name][0]]
    if bad:
        problems.append(f"{len(bad)} file(s) differ from FILES.sha256, e.g. {bad[:3]}")
    exe = inner["app"]["exe"]
    exe_path = root / exe
    if not exe_path.is_file() or _sha256(exe_path) != inner["app"]["exe_sha256"]:
        problems.append(f"{exe} is missing or differs from the manifest's exe sha256")
    facts.update({"extracted_to": str(root), "files_checked": len(checked), "exe": exe, "exe_sha256": inner["app"]["exe_sha256"]})
    return facts, problems


def build_verdict(manifest: dict, archive_verify: dict, evidence: dict, outcomes: dict[str, str]) -> dict:
    """One verdict for the candidate: the zip that was verified is the zip the manifest names, the packaged
    app passed its evidence, and every step the workflow ran succeeded."""
    claim = manifest.get("archive") or {}
    facts = archive_verify.get("facts") or {}
    problems = [f"step {name} was {outcome}" for name, outcome in sorted(outcomes.items()) if outcome != "success"]
    if archive_verify.get("verdict") != "passed":
        problems.append("the downloaded archive did not verify against its manifest")
    if facts.get("sha256") != claim.get("sha256") or not claim.get("sha256"):
        problems.append("the verified archive is not the archive the manifest names")
    if evidence.get("verdict") != "passed":
        problems.append("the packaged-app evidence did not verify")
    problems += [f"packaged evidence: {item}" for item in evidence.get("problems") or []]
    return {
        "schema": 1,
        "kind": "hermes-clarify-autosave-windows-candidate-acceptance",
        "passed": not problems,
        "problems": problems,
        "commit": (manifest.get("source") or {}).get("commit"),
        "package": manifest.get("package"),
        "run_url": (manifest.get("build") or {}).get("run_url"),
        "archive": {key: claim.get(key) for key in ("name", "bytes", "sha256")},
        "exe": {"path": (manifest.get("app") or {}).get("exe"), "sha256": (manifest.get("app") or {}).get("exe_sha256")},
        "steps": dict(sorted(outcomes.items())),
        "archive_verification": {"verdict": archive_verify.get("verdict"), "files_checked": facts.get("files_checked")},
        "packaged_evidence": {"verdict": evidence.get("verdict"), "specs": evidence.get("specs"), "stats": evidence.get("stats")},
        "signing": (manifest.get("signing") or {}).get("status"),
        "publication": (manifest.get("publication") or {}).get("status"),
        "scope": "Passed on a clean GitHub-hosted windows-2025 x64 runner, from the downloaded and re-verified zip. "
                 "It does not show that the candidate works on any other machine, with a real model provider or "
                 "server, beside an installed Hermes, or through any update path.",
    }


def _authenticode(path: str | None) -> dict | None:
    return _read_json(Path(path)) if path else None


def _github_output(lines: list[str]) -> None:
    """Append ``name=value`` lines to ``$GITHUB_OUTPUT`` with LF endings, which Windows text mode would turn into CRLF."""
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8", newline="\n") as stream:
            stream.write("".join(f"{line}\n" for line in lines))


def _locate(args) -> int:
    app = find_unpacked(Path(args.release_dir), args.commit)
    print(app)
    if args.github_output:
        _github_output([f"unpacked={app.as_posix()}"])
    return 0


def _audit(args) -> int:
    facts, problems = audit_app(Path(args.app), args.commit, _authenticode(args.authenticode))
    _write_json(Path(args.out), {"facts": facts, "problems": problems, "verdict": "failed" if problems else "passed"})
    for problem in problems:
        print(f"::error::candidate audit: {problem}", file=sys.stderr)
    print(f"candidate audit: {len(problems)} problem(s); {facts.get('file_count')} files, {facts.get('total_bytes')} bytes")
    return 1 if problems else 0


def _assemble(args) -> int:
    outer = assemble(Path(args.app), args.commit, Path(args.template), Path(args.out_dir),
                     max_zip_bytes=int(args.max_zip_mb * 1024 * 1024), provenance=Path(args.provenance) if args.provenance else None,
                     authenticode=_authenticode(args.authenticode), env=dict(os.environ))
    archive = outer["archive"]
    print(f"assembled {archive['name']}: {archive['bytes']} bytes, sha256 {archive['sha256']}, exe sha256 {outer['app']['exe_sha256']}")
    return 0


def _verify(args) -> int:
    facts, problems = verify_archive(Path(args.zip), Path(args.manifest), Path(args.extract_to), args.commit,
                                     args.expect_sha256)
    _write_json(Path(args.out), {"facts": facts, "problems": problems, "verdict": "failed" if problems else "passed"})
    for problem in problems:
        print(f"::error::candidate verification: {problem}", file=sys.stderr)
    print(f"candidate verification: {len(problems)} problem(s); sha256 {facts['sha256']}; {facts.get('files_checked', 0)} files re-hashed")
    return 1 if problems else 0


def _verdict(args) -> int:
    outcomes: dict[str, str] = {}
    for item in args.outcome:
        name, sep, value = item.partition("=")
        if not sep or not name:
            raise CandidateError(f"--outcome expects name=value, got {item!r}")
        outcomes[name] = value or "not-run"
    verdict = build_verdict(_read_json(Path(args.manifest)), _read_json(Path(args.archive_verify)),
                            _read_json(Path(args.evidence_verdict)), outcomes)
    _write_json(Path(args.out), verdict)
    for problem in verdict["problems"]:
        print(f"::error::candidate acceptance: {problem}", file=sys.stderr)
    print(f"candidate acceptance: {'PASSED' if verdict['passed'] else 'FAILED'} for {verdict['package']} "
          f"(zip sha256 {verdict['archive']['sha256']})")
    return 0 if verdict["passed"] else 1


def _bundle_env(_args) -> int:
    print(json.dumps(BUNDLE_ENV, sort_keys=True, separators=(",", ":")))
    return 0


def step_outputs(manifest: dict, env: dict[str, str]) -> list[str]:
    archive = manifest["archive"]
    return [
        f"package={manifest['package']}",
        f"zip_name={archive['name']}",
        f"zip_sha256={archive['sha256']}",
        f"exe_sha256={manifest['app']['exe_sha256']}",
        f"artifact=clarify-candidate-{env['GITHUB_RUN_ID']}-{env['GITHUB_RUN_ATTEMPT']}",
    ]


def _outputs(args) -> int:
    lines = step_outputs(_read_json(Path(args.manifest)), dict(os.environ))
    print("\n".join(lines))
    _github_output(lines)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("locate")
    p.add_argument("--release-dir", required=True)
    p.add_argument("--commit", required=True)
    p.add_argument("--github-output", action="store_true", help="also write unpacked=<dir> to $GITHUB_OUTPUT")
    p.set_defaults(func=_locate)

    p = sub.add_parser("audit")
    p.add_argument("--app", required=True)
    p.add_argument("--commit", required=True)
    p.add_argument("--authenticode", help="JSON from Get-AuthenticodeSignature on the product exe ({status, subject})")
    p.add_argument("--out", required=True)
    p.set_defaults(func=_audit)

    p = sub.add_parser("assemble")
    p.add_argument("--app", required=True)
    p.add_argument("--commit", required=True)
    p.add_argument("--template", required=True, help="directory laid over the package root (launcher, README)")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--max-zip-mb", type=float, default=3072)
    p.add_argument("--provenance", default="source-provenance.json")
    p.add_argument("--authenticode")
    p.set_defaults(func=_assemble)

    p = sub.add_parser("verify")
    p.add_argument("--zip", required=True)
    p.add_argument("--manifest", required=True)
    p.add_argument("--extract-to", required=True)
    p.add_argument("--commit")
    p.add_argument("--expect-sha256", help="digest the archive must have, reported by another route than the artifact")
    p.add_argument("--out", required=True)
    p.set_defaults(func=_verify)

    p = sub.add_parser("verdict")
    p.add_argument("--manifest", required=True, help="the outer MANIFEST.json that travelled with the zip")
    p.add_argument("--archive-verify", required=True, help="the JSON `verify` wrote")
    p.add_argument("--evidence-verdict", required=True, help="the JSON `evidence.py verify` wrote for the packaged spec")
    p.add_argument("--outcome", action="append", default=[], help="step=outcome (every one must be success)")
    p.add_argument("--out", required=True)
    p.set_defaults(func=_verdict)

    p = sub.add_parser("bundle-env")
    p.set_defaults(func=_bundle_env)

    p = sub.add_parser("outputs")
    p.add_argument("--manifest", required=True, help="the outer MANIFEST.json `assemble` wrote")
    p.set_defaults(func=_outputs)

    args = parser.parse_args(argv)
    # Output that a shell step captures must not carry the CR that Windows text mode adds.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")
    try:
        return args.func(args)
    except CandidateError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
