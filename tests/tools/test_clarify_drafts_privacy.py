"""The clarify draft store's privacy and lifecycle contract per host.

Owner-only means mode ``0600``/``0700`` on POSIX. Windows has no mode bits (``st_mode`` is synthesized), so
there the contract is the directory ACL: every private directory is created through
``hermes_dir_acl.make_user_dir``, which keeps a directory an ELEVATED process creates usable by the same user
unelevated (CPython >= 3.13 gives a plain ``mkdir(mode=0o700)`` an Administrators-only DACL that strands the
user's own token with ``WinError 5``). The Windows ACL effect itself is proved by
``tests/test_hermes_dir_acl_windows.py``; no test here pretends to be on Windows.
"""
import stat
from pathlib import Path

import pytest

import hermes_dir_acl
from hermes_constants import mark_named_profile_deleted, named_profile_home
from tools import clarify_drafts as store

QUESTIONS = [{"qid": "q0", "question": "Q?", "choices": None, "multi_select": False}]
RID = "srq-aaaaaaaaaaaa"


def _save(home: Path, revision: int = 1) -> tuple[store.DraftScope, Path]:
    scope = store.DraftScope(home, "tui_gateway", "stored-1")
    store.persist(scope, RID, QUESTIONS, {"q0": {"choices": [], "text": "typed answer", "revision": revision}})
    return scope, scope.path(RID)


@pytest.mark.platforms("posix")
def test_posix_a_record_is_owner_only_and_so_is_the_directory_holding_it(tmp_path):
    scope, path = _save(tmp_path)
    assert path.stat().st_mode & 0o777 == 0o600
    assert scope.directory.stat().st_mode & 0o777 == 0o700


@pytest.mark.platforms("windows")
def test_windows_a_record_is_never_left_read_only_so_the_next_autosave_can_replace_it(tmp_path):
    """Mode bits are synthesized on Windows: the ``0600`` chmod must not mark the record read-only (the next
    save, a discard or a purge would then be refused)."""
    scope, path = _save(tmp_path)
    assert not path.stat().st_file_attributes & stat.FILE_ATTRIBUTE_READONLY
    _save(tmp_path, revision=2)
    assert store.load(scope, RID)["drafts"]["q0"]["revision"] == 2
    assert store.discard(scope, RID) is True


def test_private_directories_are_created_through_the_elevation_aware_helper(tmp_path, monkeypatch):
    """Elevation is a host fact; the probe stands in for it on this production path (the pattern of
    ``tests/test_hermes_dir_acl.py``). Every directory the save creates is granted, parents first, so the
    leaf inherits from a granted parent."""
    granted: list[Path] = []
    monkeypatch.setattr(hermes_dir_acl, "process_is_elevated", lambda: True)
    monkeypatch.setattr(hermes_dir_acl, "grant_user_access", lambda p, **_k: granted.append(Path(p)) or True)
    monkeypatch.setattr(hermes_dir_acl, "_granted", set())
    scope, path = _save(tmp_path)
    assert path.is_file()
    leaf = scope.directory
    assert granted == [leaf.parent.parent, leaf.parent, leaf]
    # A later save into the existing directory repairs nothing twice (granted once per directory object).
    _save(tmp_path, revision=2)
    assert granted == [leaf.parent.parent, leaf.parent, leaf]


def test_a_save_for_a_deleted_profile_is_not_durable_and_never_recreates_its_home(tmp_path):
    """An in-flight autosave can outlive ``hermes profile delete``: it must fail like any refused disk write
    (``durable: false``), not resurrect ``profiles/<name>/`` with a bare ``mkdir(parents=True)``."""
    (tmp_path / "config.yaml").write_text("{}\n", encoding="utf-8")
    profile = tmp_path / "profiles" / "p1"
    profile.mkdir(parents=True)
    mark_named_profile_deleted(profile)
    profile.rmdir()
    assert named_profile_home(profile) is not None and not profile.exists()
    book = store.DraftBook(RID, QUESTIONS, store.DraftScope(profile, "tui_gateway", "stored-1"))
    saved = book.save("q0", [], "typed after the delete", 1, locked=set, is_open=lambda: True)
    assert saved == {"status": "ok", "revision": 1, "durable": False}
    assert not profile.exists()
    assert book.settle({}, "timed_out")["drafts_durable"] is False
