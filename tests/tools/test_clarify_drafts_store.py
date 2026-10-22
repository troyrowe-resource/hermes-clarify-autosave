"""The durable clarify draft store (``tools/clarify_drafts.py``): exact record shape, scope isolation,
honest durability, bounded locking and session purge. No timer ever removes a record."""
import json
import logging

import pytest

from tools import clarify_drafts as store

QUESTIONS = [{"qid": "q0", "question": "Q?", "choices": None, "multi_select": False},
             {"qid": "q1", "question": "Pick?", "choices": ["A (Recommended)", "B"], "multi_select": True}]


def _scope(tmp_path, gateway="tui_gateway", key="stored-1"):
    return store.DraftScope(tmp_path, gateway, key)


def test_malformed_records_are_refused_loudly_and_left_in_place(tmp_path, caplog):
    scope = _scope(tmp_path)
    good = "srq-aaaaaaaaaaaa"
    store.persist(scope, good, QUESTIONS, {"q0": {"choices": [], "text": "ok", "revision": 3}})
    bad_shapes = {
        "srq-bbbbbbbbbbbb": "{not json",
        "srq-cccccccccccc": json.dumps({**json.loads(scope.path(good).read_text()), "request_id": "srq-cccccccccccc",
                                         "drafts": {"q0": {"choices": "A", "text": "x", "revision": 1}}}),
        "srq-dddddddddddd": json.dumps({**json.loads(scope.path(good).read_text()), "request_id": "srq-dddddddddddd",
                                         "drafts": {"q9": {"choices": [], "text": "x", "revision": 1}}}),
        "srq-eeeeeeeeeeee": json.dumps({**json.loads(scope.path(good).read_text()), "request_id": "srq-eeeeeeeeeeee",
                                         "drafts": {"q0": {"choices": [], "text": "x", "revision": True}}}),
    }
    for request_id, raw in bad_shapes.items():
        scope.path(request_id).write_text(raw, encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="tools.clarify_drafts"):
        records = store.list_records(scope)
    assert [r["request_id"] for r in records] == [good]
    assert sum("malformed clarify draft record" in r.message for r in caplog.records) == len(bad_shapes)
    for request_id in bad_shapes:
        assert scope.path(request_id).exists() and store.load(scope, request_id) is None


def test_records_never_cross_gateways_sessions_or_requests(tmp_path):
    sidecar, owner = _scope(tmp_path), _scope(tmp_path, "session_owner")
    rid = "srq-aaaaaaaaaaaa"
    store.persist(sidecar, rid, QUESTIONS, {"q0": {"choices": [], "text": "sidecar", "revision": 1}})
    assert store.list_records(owner) == [] and store.load(owner, rid) is None
    assert store.list_records(_scope(tmp_path, key="stored-2")) == []
    assert store.list_records(sidecar, "srq-bbbbbbbbbbbb") == []
    # A file copied under another scope's directory is not that scope's record.
    owner.directory.mkdir(parents=True)
    owner.path(rid).write_bytes(sidecar.path(rid).read_bytes())
    assert store.load(owner, rid) is None
    with pytest.raises(ValueError):
        sidecar.path("../escape")
    with pytest.raises(ValueError):
        store.DraftScope(tmp_path, "other_gateway", "k")


def test_a_failed_disk_write_is_never_acknowledged_as_durable(tmp_path, monkeypatch):
    book = store.DraftBook("srq-aaaaaaaaaaaa", QUESTIONS, _scope(tmp_path))

    def refuse(*_a, **_k):
        raise OSError("disk full")
    monkeypatch.setattr(store, "_atomic_write", refuse)
    saved = book.save("q0", [], "kept in memory", 1, locked=set, is_open=lambda: True)
    assert saved == {"status": "ok", "revision": 1, "durable": False}
    settled = book.settle({}, "timed_out")
    assert settled["drafts"] == {"q0": {"choices": [], "text": "kept in memory", "revision": 1}}
    assert settled["drafts_durable"] is False
    # No scope at all is memory-only too.
    memory = store.DraftBook("srq-bbbbbbbbbbbb", QUESTIONS, None)
    assert memory.save("q0", [], "x", 1, locked=set, is_open=lambda: True)["durable"] is False


def test_book_semantics_stale_locked_discarded_and_closed(tmp_path):
    scope = _scope(tmp_path)
    book = store.DraftBook("srq-aaaaaaaaaaaa", QUESTIONS, scope)
    def is_open():
        return True
    assert book.save("q1", ["A (Recommended)", "B"], "", 5, locked=set, is_open=is_open)["status"] == "ok"
    assert store.load(scope, book.request_id)["drafts"]["q1"]["choices"] == ["A", "B"]
    assert book.save("q1", ["A"], "", 4, locked=set, is_open=is_open) == {"status": "stale", "revision": 5, "durable": True}
    assert book.save("q0", [], "x", 1, locked=lambda: {"q0"}, is_open=is_open) == {"status": "locked"}
    for choices, text, revision in ((["C"], "", 9), ([], "x" * 16385, 9), ([], "x", 0), ([], 7, 9)):
        with pytest.raises(store.DraftError):
            book.save("q1", choices, text, revision, locked=set, is_open=is_open)
    with pytest.raises(store.DraftError):
        store.DraftBook("srq-cccccccccccc", [{**QUESTIONS[1], "multi_select": False}], None).save(
            "q1", ["A", "B"], "", 1, locked=set, is_open=is_open)
    with pytest.raises(ValueError):
        book.save("q7", [], "x", 1, locked=set, is_open=is_open)
    book.discard()
    assert not scope.path(book.request_id).exists()
    # An in-flight save arriving after the discard cannot recreate the record.
    assert book.save("q0", [], "late", 99, locked=set, is_open=is_open) == {"status": "discarded"}
    assert not scope.path(book.request_id).exists() and book.settle({}, "timed_out") == {}
    closed = store.DraftBook("srq-dddddddddddd", QUESTIONS, scope)
    closed.settle({}, "cancelled")
    assert closed.save("q0", [], "after settle", 1, locked=set, is_open=is_open) == {"status": "expired"}
    assert store.list_records(scope) == []


def test_file_locks_stay_bounded_and_purge_removes_only_that_session(tmp_path):
    scope = _scope(tmp_path)
    locks = {id(store._lock_for(scope.directory / f"srq-{i:012x}.json")) for i in range(2000)}
    assert len(locks) <= len(store._FILE_LOCKS)
    for gateway, key, rid in (("tui_gateway", "gone", "srq-aaaaaaaaaaaa"), ("session_owner", "gone", "srq-bbbbbbbbbbbb"),
                              ("tui_gateway", "kept", "srq-cccccccccccc")):
        store.persist(store.DraftScope(tmp_path, gateway, key), rid, QUESTIONS,
                      {"q0": {"choices": [], "text": "x", "revision": 1}})
    assert store.purge_session(tmp_path, "gone") == 2
    assert store.list_records(store.DraftScope(tmp_path, "tui_gateway", "kept"))
    assert not store.DraftScope(tmp_path, "session_owner", "gone").directory.exists()


def test_a_bom_prefixed_record_is_read_like_any_other(tmp_path):
    # Windows tooling (PowerShell Set-Content/Out-File, some editors) BOMs files it touches.
    scope = _scope(tmp_path)
    rid = "srq-aaaaaaaaaaaa"
    store.persist(scope, rid, QUESTIONS, {"q1": {"choices": ["B"], "text": "Ünïcode ✓\nline two", "revision": 7}})
    scope.path(rid).write_bytes(b"\xef\xbb\xbf" + scope.path(rid).read_bytes())
    record = store.load(scope, rid)
    assert record is not None and record["drafts"]["q1"] == {"choices": ["B"], "text": "Ünïcode ✓\nline two", "revision": 7}
    assert [r["request_id"] for r in store.list_records(scope)] == [rid]
