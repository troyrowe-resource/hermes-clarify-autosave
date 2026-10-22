"""A chat deleted by ANY path takes the unsent clarify drafts saved for it with it; a deliberate archive does not.

``emit_session_deleted`` is the one seam every ``SessionDB`` removal passes (``hermes sessions delete``, the sidecar's
and the canonical gateway's ``session.delete``, Desktop's DELETE, bulk delete, the empty sweep, retention prune, ghost
prune, the profile repair) and it already derives the profile home the stored drafts live under, from the store that
lost the row (``<home>/state.db``), never from the process: a gateway serving many profiles purges the right one.
Real ``SessionDB``, real draft files for both gateways. Before this, only the sidecar's ``session.delete`` purged, so a
chat Desktop deleted through the canonical gateway (or the CLI, or a prune) left its drafts on disk for good.
"""
import logging
import time

import pytest

import hermes_state_runtime as rt
from hermes_cli.plugins import get_plugin_manager
from hermes_constants import get_hermes_home
from hermes_state import SessionDB
from tools import clarify_drafts as store

GATEWAYS = ("tui_gateway", "session_owner")
QUESTIONS = [{"qid": "q0", "question": "Open with?", "choices": None, "multi_select": False}]
TYPED = {"q0": {"choices": [], "text": "typed, never sent", "revision": 1}}


@pytest.fixture()
def home(tmp_path):
    path = tmp_path / "profile"
    path.mkdir()
    assert path != get_hermes_home(), "the store's profile is not the process's"
    return path


@pytest.fixture()
def db(home):
    session_db = SessionDB(db_path=home / "state.db")
    yield session_db
    session_db.close()


@pytest.fixture()
def deleted_hook():
    """Register an ``on_session_delete`` callback on the registry ``invoke_hook`` reads; restore it afterwards."""
    manager = get_plugin_manager()
    saved = {name: list(callbacks) for name, callbacks in manager._hooks.items()}
    events: list[dict] = []
    manager._hooks.setdefault("on_session_delete", []).append(lambda **kw: events.append(kw))
    try:
        yield events
    finally:
        manager._hooks = saved


def _save(home, session_id):
    """One saved request per gateway for *session_id* in *home*."""
    for index, gateway in enumerate(GATEWAYS):
        store.persist(store.DraftScope(home, gateway, session_id), f"srq-{index:012x}", QUESTIONS, TYPED)


def _saved(home, session_id):
    """The gateways that still hold a record for *session_id* in *home*."""
    return [gateway for gateway in GATEWAYS if store.list_records(store.DraftScope(home, gateway, session_id))]


def _canonical(db, session_id, operation, payload):
    epoch = rt.begin_runtime_epoch(db, instance_id="test")
    row = db.get_session(session_id)
    return rt.mutate_runtime_session(
        db, epoch=epoch, principal_id="human", session_id=session_id, request_id=f"{operation}-{session_id}",
        expected_revision=row["runtime_revision"], expected_generation=row["runtime_generation"],
        operation=operation, payload=payload)


def _chat(db, session_id, *, ended=False):
    db.create_session(session_id, source="cli")
    db.append_message(session_id, role="user", content="hi")
    if ended:
        db.end_session(session_id, "done")


def _empty(db, session_id, *, source="cli", ended=False):
    db.create_session(session_id, source=source)
    if ended:
        db.end_session(session_id, "done")


def _ghost(db, session_id):
    _empty(db, session_id, source="tui", ended=True)
    db._execute_write(lambda conn: conn.execute(
        "UPDATE sessions SET started_at = ? WHERE id = ?", (time.time() - 3 * 86400, session_id)))


# path name -> (make the doomed session eligible for that path, delete it)
PATHS = {
    "delete": (_chat, lambda db, sid: db.delete_session(sid)),
    "delete_with_compression_chain": (_chat, lambda db, sid: db.delete_session(sid, include_compression_chain=True)),
    "bulk_delete": (_chat, lambda db, sid: db.delete_sessions([sid]) == 1),
    "canonical_delete": (_chat, lambda db, sid: _canonical(db, sid, "delete", {})),
    "empty_sweep": (lambda db, sid: _empty(db, sid, ended=True), lambda db, sid: db.delete_empty_sessions() == 1),
    "delete_if_empty": (_empty, lambda db, sid: db.delete_session_if_empty(sid)),
    "prune": (lambda db, sid: _chat(db, sid, ended=True), lambda db, sid: db.prune_sessions(older_than_days=0) == 1),
    "ghost_prune": (_ghost, lambda db, sid: db.prune_empty_ghost_sessions() == 1),
    "profile_repair": (_chat, lambda db, sid: db.delete_moved_session(sid)),
}


@pytest.mark.parametrize("path", sorted(PATHS))
def test_every_deletion_path_purges_that_sessions_drafts_in_that_profile_only(db, home, path):
    prepare, delete = PATHS[path]
    prepare(db, "doomed")
    _chat(db, "kept")
    process_home = get_hermes_home()
    for where in (home, process_home):
        _save(where, "doomed")
        _save(where, "kept")
    assert _saved(home, "doomed") == list(GATEWAYS)

    assert delete(db, "doomed")

    assert db.get_session("doomed") is None and db.get_session("kept") is not None
    assert _saved(home, "doomed") == [], "both gateways' drafts go with the chat"
    assert not any(store.DraftScope(home, gateway, "doomed").directory.exists() for gateway in GATEWAYS)
    assert _saved(home, "kept") == list(GATEWAYS), "another chat of the same profile keeps its drafts"
    assert _saved(process_home, "doomed") == list(GATEWAYS), "another profile's same-named chat is not this store's"
    assert _saved(process_home, "kept") == list(GATEWAYS)


def test_a_bulk_delete_purges_every_removed_session_and_nothing_else(db, home):
    for session_id in ("a", "b", "kept"):
        _chat(db, session_id)
        _save(home, session_id)

    assert db.delete_sessions(["a", "b", "missing"]) == 2

    assert [_saved(home, session_id) for session_id in ("a", "b")] == [[], []]
    assert _saved(home, "kept") == list(GATEWAYS)


def test_a_compression_chain_takes_the_drafts_saved_under_every_key_it_had_with_it(db, home):
    """Compression re-keys a live sidecar session (``session_key``): a batch asked before it saved its drafts under
    the ROOT's id, which recall under the continuation's id no longer lists. They are not leaked for good: deleting the
    conversation removes every segment, and so every key's drafts."""
    _chat(db, "chain-root")
    db.end_session("chain-root", "compression")
    _chat(db, "chain-tip")
    db._execute_write(lambda conn: conn.execute(
        "UPDATE sessions SET parent_session_id = ? WHERE id = ?", ("chain-root", "chain-tip")))
    _save(home, "chain-root")
    _save(home, "chain-tip")
    assert _saved(home, "chain-tip") == list(GATEWAYS)

    assert db.delete_session("chain-tip", include_compression_chain=True)

    assert db.get_session("chain-root") is None and db.get_session("chain-tip") is None
    assert _saved(home, "chain-root") == [] and _saved(home, "chain-tip") == []


@pytest.mark.parametrize("archive", ["set_session_archived", "canonical_sidebar"])
def test_a_deliberate_archive_keeps_the_drafts_and_so_does_un_archiving(db, home, archive):
    _chat(db, "arch")
    _save(home, "arch")

    if archive == "set_session_archived":
        assert db.set_session_archived("arch", True)
    else:
        _canonical(db, "arch", "sidebar", {"archived": True})
    assert db.get_session("arch")["archived"]
    assert _saved(home, "arch") == list(GATEWAYS), "archived is hidden, not deleted: the chat can be reopened"

    assert db.set_session_archived("arch", False)
    assert _saved(home, "arch") == list(GATEWAYS)


def test_archiving_a_chain_tip_keeps_the_drafts_of_the_root_it_hides_too(db, home):
    _chat(db, "tip-root")
    db.end_session("tip-root", "compression")
    _chat(db, "tip")
    db._execute_write(lambda conn: conn.execute("UPDATE sessions SET parent_session_id = ? WHERE id = ?",
                                                ("tip-root", "tip")))
    _save(home, "tip-root")
    _save(home, "tip")

    assert db.set_session_archived("tip", True)

    assert db.get_session("tip-root")["archived"] and db.get_session("tip")["archived"]
    assert _saved(home, "tip-root") == list(GATEWAYS) and _saved(home, "tip") == list(GATEWAYS)


def test_a_purge_that_fails_is_logged_and_neither_breaks_the_delete_nor_the_other_sessions_nor_the_plugin_hook(
        db, home, deleted_hook, monkeypatch, caplog):
    for session_id in ("a", "b"):
        _chat(db, session_id)
        _save(home, session_id)
    real_purge, attempted = store.purge_session, []

    def purge(purge_home, session_id):
        attempted.append(session_id)
        if session_id == "a":
            raise OSError("the drafts directory is locked")
        return real_purge(purge_home, session_id)
    monkeypatch.setattr(store, "purge_session", purge)

    with caplog.at_level(logging.WARNING):
        assert db.delete_sessions(["a", "b"]) == 2

    assert db.get_session("a") is None and db.get_session("b") is None, "the delete itself is never undone"
    assert attempted == ["a", "b"], "one session's failure does not stop the next one's purge"
    assert _saved(home, "a") == list(GATEWAYS) and _saved(home, "b") == []
    assert [record.getMessage() for record in caplog.records if "clarify drafts" in record.getMessage()] == [
        "clarify drafts of deleted session a could not be purged"]
    assert [event["session_id"] for event in deleted_hook] == ["a"] and deleted_hook[0]["deleted_ids"] == ["a", "b"], (
        "plugins are told about the delete whatever the draft purge did")
