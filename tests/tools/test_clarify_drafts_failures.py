"""The durable draft store and its book under real failures and real races (``tools/clarify_drafts.py``).

``test_clarify_drafts_store.py`` swaps ``_atomic_write`` for a stub that raises. Here the REAL write path is refused the
way a disk refuses it (ENOSPC at the fsync, a read-only replace, a denied temp file, a path that is not a directory),
damaged and foreign files are planted where recall looks, and the real ``DraftBook`` is raced against a save held
mid-write. The contract: ``durable`` never claims more than the disk confirmed, a failed write never damages the last good
copy or leaves debris, recall ignores what it cannot trust, and no ordering of save / discard / settle / lock leaves a
draft behind that the user dropped or answered.
"""
import errno
import json
import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from tools import clarify_drafts as store

RID = "srq-aaaaaaaaaaaa"
QUESTIONS = [{"qid": "q0", "question": "Open with?", "choices": None, "multi_select": False},
             {"qid": "q1", "question": "Which?", "choices": ["A", "B"], "multi_select": True}]
REFUSALS = ["enospc_at_fsync", "read_only_replace", "denied_temp_file"]


def _save(book, qid, text, revision, *, choices=(), locked=set):
    return book.save(qid, list(choices), text, revision, locked=locked, is_open=lambda: True)


class _Disk:
    """The real write path with the next failure on demand: each wrapper delegates until ``broken`` names it."""

    def __init__(self, monkeypatch):
        self.broken = None
        for owner, name, code, kind in ((os, "fsync", errno.ENOSPC, "enospc_at_fsync"),
                                        (store, "atomic_replace", errno.EROFS, "read_only_replace"),
                                        (tempfile, "mkstemp", errno.EACCES, "denied_temp_file")):
            monkeypatch.setattr(owner, name, self._wrap(getattr(owner, name), code, kind))

    def _wrap(self, real, code, kind):
        def wrapper(*args, **kwargs):
            if self.broken == kind:
                raise OSError(code, os.strerror(code))
            return real(*args, **kwargs)
        return wrapper


class _HeldWrite:
    """Holds the first real ``_atomic_write`` open mid-flight (the book's lock is held for it) until released."""

    def __init__(self, monkeypatch):
        self.inside, self.release = threading.Event(), threading.Event()
        self._first = threading.Lock()
        real = store._atomic_write

        def held(path, payload):
            if self._first.acquire(blocking=False):
                self.inside.set()
                assert self.release.wait(10), "the test never released the held write"
            return real(path, payload)
        monkeypatch.setattr(store, "_atomic_write", held)


@pytest.fixture()
def scope(tmp_path):
    return store.DraftScope(tmp_path, "tui_gateway", "k")


@pytest.mark.parametrize("refusal", REFUSALS)
def test_a_refusing_disk_is_never_durable_never_damages_the_last_good_copy_and_heals(scope, monkeypatch, refusal):
    disk = _Disk(monkeypatch)
    book = store.DraftBook(RID, QUESTIONS, scope)
    assert _save(book, "q0", "first", 1) == {"status": "ok", "revision": 1, "durable": True}
    good = scope.path(RID).read_bytes()

    disk.broken = refusal
    assert _save(book, "q0", "second", 2) == {"status": "ok", "revision": 2, "durable": False}
    assert _save(book, "q1", "", 1, choices=["B"]) == {"status": "ok", "revision": 1, "durable": False}
    assert scope.path(RID).read_bytes() == good, "a failed overwrite leaves the last good copy exactly as it was"
    assert [p.name for p in scope.directory.iterdir()] == [scope.path(RID).name], "no temp file left behind"
    # A retry of the held revision reports the held copy's real durability: not on disk.
    assert _save(book, "q0", "second", 2) == {"status": "stale", "revision": 2, "durable": False}

    disk.broken = None
    assert _save(book, "q0", "third", 3) == {"status": "ok", "revision": 3, "durable": True}
    assert store.load(scope, RID)["drafts"] == {"q0": {"choices": [], "text": "third", "revision": 3},
                                                "q1": {"choices": ["B"], "text": "", "revision": 1}}, (
        "the save after the disk came back writes every held draft, the ones refused earlier included")
    assert book.settle({}, "timed_out")["drafts_durable"] is True


@pytest.mark.parametrize("refusal", REFUSALS)
def test_settling_on_a_refusing_disk_reports_the_newer_held_drafts_as_not_durable(scope, monkeypatch, refusal):
    disk = _Disk(monkeypatch)
    book = store.DraftBook(RID, QUESTIONS, scope)
    _save(book, "q0", "first", 1)
    disk.broken = refusal
    assert _save(book, "q0", "second", 2)["durable"] is False

    settled = book.settle({}, "timed_out")

    assert settled == {"drafts": {"q0": {"choices": [], "text": "second", "revision": 2}},
                       "drafts_request_id": RID, "drafts_durable": False}
    # What the disk holds is the OLDER copy: exactly why the held one must never be called durable.
    assert store.load(scope, RID)["drafts"]["q0"]["revision"] == 1
    assert store.load(scope, RID)["outcome"] is None, "and the refused settlement did not stamp its outcome"


def test_a_drafts_root_that_is_not_a_directory_is_not_durable_recalls_empty_and_heals_when_cleared(tmp_path):
    blocker = tmp_path / store.STORE_DIRNAME
    blocker.write_text("a file where the drafts directory belongs", encoding="utf-8")
    scope = store.DraftScope(tmp_path, "session_owner", "k")
    book = store.DraftBook(RID, QUESTIONS, scope)

    assert _save(book, "q0", "typed", 1) == {"status": "ok", "revision": 1, "durable": False}
    assert store.list_records(scope) == [] and store.load(scope, RID) is None, "recall on it answers empty, not an error"
    assert book.settle({}, "timed_out") == {
        "drafts": {"q0": {"choices": [], "text": "typed", "revision": 1}},
        "drafts_request_id": RID, "drafts_durable": False}

    blocker.unlink()
    fresh = store.DraftBook("srq-bbbbbbbbbbbb", QUESTIONS, scope)
    assert _save(fresh, "q0", "typed again", 1)["durable"] is True
    assert [r["request_id"] for r in store.list_records(scope)] == ["srq-bbbbbbbbbbbb"]


def _good_record(scope):
    store.persist(scope, RID, QUESTIONS, {"q0": {"choices": [], "text": "mine", "revision": 4}})
    return json.loads(scope.path(RID).read_text(encoding="utf-8"))


# name -> (what is planted under another request id, whether the record is damaged (a loud warning) or merely foreign)
def _planted(good):
    def record(**changes):
        return json.dumps({**good, "request_id": "srq-bbbbbbbbbbbb", **changes})
    return {
        "a future schema version": (record(version=2), True),
        "a top level that is not an object": ("[]", True),
        "an empty file": ("", True),
        "a truncated file": (json.dumps(good)[:40], True),
        "bytes that are not text": (b"\xff\xfe\x00\x81", True),
        "drafts that are not an object": (record(drafts=[]), True),
        "a negative revision": (record(drafts={"q0": {"choices": [], "text": "x", "revision": -3}}), True),
        "a record of another gateway": (record(gateway="session_owner"), False),
        "a record of another session": (record(session_key="someone-else"), False),
        "a record filed under the wrong request id": (json.dumps({**good, "request_id": "srq-cccccccccccc"}), False),
    }


@pytest.mark.parametrize("name", sorted(_planted({"": ""})))
def test_a_damaged_or_foreign_record_is_ignored_and_never_hides_the_good_ones(scope, caplog, name):
    good = _good_record(scope)
    planted, damaged = _planted(good)[name]
    bad = scope.path("srq-bbbbbbbbbbbb")
    (bad.write_bytes if isinstance(planted, bytes) else bad.write_text)(planted)

    with caplog.at_level("WARNING", logger="tools.clarify_drafts"):
        records = store.list_records(scope)

    assert [r["request_id"] for r in records] == [RID] and records[0]["drafts"]["q0"]["text"] == "mine"
    assert sum("malformed clarify draft record" in r.getMessage() for r in caplog.records) == (1 if damaged else 0)
    assert store.load(scope, "srq-bbbbbbbbbbbb") is None
    assert store.discard(scope, "srq-bbbbbbbbbbbb") is False and bad.exists(), "left in place, never removed as junk"


def test_recall_lists_at_most_the_newest_fifty_and_the_older_files_stay_readable_by_id(scope):
    good = _good_record(scope)
    scope.path(RID).unlink()  # only the planted records below are in the directory
    total = store.MAX_LISTED_RECORDS + 7
    for index in range(total):
        request_id = f"srq-{index:012x}"
        scope.path(request_id).write_text(json.dumps({**good, "request_id": request_id, "updated_at": 1000.0 + index}))

    listed = store.list_records(scope)

    assert [r["request_id"] for r in listed] == [f"srq-{index:012x}" for index in range(total - 1, 6, -1)]
    assert len(listed) == store.MAX_LISTED_RECORDS
    assert [r["request_id"] for r in store.list_records(scope, "srq-000000000000")] == ["srq-000000000000"]


# What a JS string with an unpaired surrogate becomes after JSON: ``JSON.stringify("\ud800")`` is the 8-character text
# "\ud800" in quotes and ``json.loads`` turns it into exactly one lone surrogate code point, which UTF-8 cannot encode.
LONE_SURROGATES = [json.loads('"\\ud800"'), json.loads('"\\udfff"'), "half a pair \ud83d, then \ude00"]


@pytest.mark.parametrize("text", LONE_SURROGATES)
def test_a_draft_text_utf8_cannot_encode_is_refused_whole_and_never_held(scope, text):
    book = store.DraftBook(RID, QUESTIONS, scope)
    assert _save(book, "q0", "kept", 1)["durable"] is True

    with pytest.raises(store.DraftError):
        _save(book, "q1", text, 2)

    assert book.snapshot(set()) == {"q0": {"choices": [], "text": "kept", "revision": 1}}, "the refused draft is not held"
    assert _save(book, "q0", "kept, edited", 3) == {"status": "ok", "revision": 3, "durable": True}
    assert book.settle({}, "timed_out")["drafts_durable"] is True


def test_a_pick_of_an_offered_label_utf8_cannot_encode_is_refused_too(scope):
    questions = [{"qid": "q0", "question": "Which?", "choices": ["fine", "broken \ud800"], "multi_select": False}]
    book = store.DraftBook(RID, questions, scope)

    with pytest.raises(store.DraftError):
        book.save("q0", ["broken \ud800"], "", 1, locked=set, is_open=lambda: True)

    assert book.snapshot(set()) == {}
    # The request's own label is unwritable, so no record of it can exist: a good pick is held, honestly not durable.
    assert book.save("q0", ["fine"], "", 2, locked=set, is_open=lambda: True) == {
        "status": "ok", "revision": 2, "durable": False}


def test_a_record_the_store_cannot_encode_is_durable_false_and_neither_save_lock_nor_settle_raises(scope):
    """The MODEL's own question carries an unpaired surrogate (a tool-call JSON ``\\ud800`` decodes to it), so no record
    of this request can be written. That is a persistence problem like a full disk: ``durable: false``, never an exception
    out of a save, a lock's supersede and above all never out of the settlement the model's answers ride on."""
    questions = [{"qid": "q0", "question": "Open with \ud800?", "choices": None, "multi_select": False},
                 {"qid": "q1", "question": "Then?", "choices": None, "multi_select": False}]
    book = store.DraftBook(RID, questions, scope)

    assert _save(book, "q0", "typed", 1) == {"status": "ok", "revision": 1, "durable": False}
    assert _save(book, "q1", "more", 1) == {"status": "ok", "revision": 1, "durable": False}
    book.supersede("q0")  # the lock of q0 re-persists what is left: the same refusal, the same silence
    settled = book.settle({"q0"}, "timed_out")

    assert settled == {"drafts": {"q1": {"choices": [], "text": "more", "revision": 1}},
                       "drafts_request_id": RID, "drafts_durable": False}
    assert not scope.path(RID).exists()
    assert not scope.directory.exists() or list(scope.directory.iterdir()) == [], "no temp file left behind"


def test_purge_also_removes_the_crash_residue_of_an_interrupted_save_but_only_that_sessions(tmp_path):
    """A process killed between the temp file and the rename leaves ``.draft-*.tmp`` holding the draft's full text."""
    mine, other = store.DraftScope(tmp_path, "tui_gateway", "gone"), store.DraftScope(tmp_path, "tui_gateway", "kept")
    store.persist(mine, RID, QUESTIONS, {"q0": {"choices": [], "text": "typed", "revision": 1}})
    store.persist(other, RID, QUESTIONS, {"q0": {"choices": [], "text": "typed", "revision": 1}})
    residue = {"gone": mine.directory / ".draft-abc123.tmp", "kept": other.directory / ".draft-def456.tmp"}
    for path in residue.values():
        path.write_text('{"drafts": "full text of an unsent answer"}', encoding="utf-8")

    assert store.purge_session(tmp_path, "gone") == 2, "the record and the residue"

    assert not mine.directory.exists(), "nothing of the chat is left, so its directory goes too"
    assert residue["kept"].exists() and other.path(RID).exists(), "another session's files, residue included, stay"


# --- races: one save held inside the real write while the other verb arrives ----------------------------------------

def test_a_discard_that_arrives_while_a_save_is_mid_write_leaves_nothing_behind(scope, monkeypatch):
    book, held = store.DraftBook(RID, QUESTIONS, scope), _HeldWrite(monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(_save, book, "q0", "in flight", 1)
        assert held.inside.wait(10)
        discarding = pool.submit(book.discard)
        held.release.set()
        assert saving.result(10) == {"status": "ok", "revision": 1, "durable": True}
        discarding.result(10)
    assert not scope.path(RID).exists() and store.list_records(scope) == []
    assert _save(book, "q0", "later", 2) == {"status": "discarded"} and not scope.path(RID).exists()
    assert book.settle({}, "timed_out") == {}


def test_a_settlement_that_arrives_while_a_save_is_mid_write_reports_that_save_and_closes_the_book(scope, monkeypatch):
    book, held = store.DraftBook(RID, QUESTIONS, scope), _HeldWrite(monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(_save, book, "q0", "in flight", 1)
        assert held.inside.wait(10)
        settling = pool.submit(book.settle, {}, "timed_out")
        held.release.set()
        assert saving.result(10) == {"status": "ok", "revision": 1, "durable": True}
        assert settling.result(10) == {"drafts": {"q0": {"choices": [], "text": "in flight", "revision": 1}},
                                       "drafts_request_id": RID, "drafts_durable": True}
    assert store.load(scope, RID)["outcome"] == "timed_out"
    assert _save(book, "q0", "late", 2) == {"status": "expired"}
    assert store.load(scope, RID)["drafts"]["q0"]["text"] == "in flight"


def test_a_lock_that_arrives_while_a_draft_of_that_question_is_mid_write_still_wins(scope, monkeypatch):
    """The registry records the lock first, then supersedes the draft. A draft that read ``locked`` just before it
    and lands on disk after must not survive the supersede, and nothing later can bring it back."""
    book, held, locked = store.DraftBook(RID, QUESTIONS, scope), _HeldWrite(monkeypatch), set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(_save, book, "q0", "in flight", 1, locked=lambda: locked)
        assert held.inside.wait(10)
        locked.add("q0")
        superseding = pool.submit(book.supersede, "q0")
        held.release.set()
        assert saving.result(10)["status"] == "ok"
        superseding.result(10)
    assert not scope.path(RID).exists() and store.list_records(scope) == []
    assert _save(book, "q0", "later", 2, locked=lambda: locked) == {"status": "locked"}
    assert book.settle(locked, "submitted") == {}


def test_an_older_revision_that_arrives_while_a_newer_one_is_mid_write_never_overwrites_it(scope, monkeypatch):
    book, held = store.DraftBook(RID, QUESTIONS, scope), _HeldWrite(monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        newer = pool.submit(_save, book, "q0", "newer", 5)
        assert held.inside.wait(10)
        older = pool.submit(_save, book, "q0", "older", 4)
        held.release.set()
        assert newer.result(10) == {"status": "ok", "revision": 5, "durable": True}
        assert older.result(10) == {"status": "stale", "revision": 5, "durable": True}
    assert store.load(scope, RID)["drafts"]["q0"] == {"choices": [], "text": "newer", "revision": 5}
