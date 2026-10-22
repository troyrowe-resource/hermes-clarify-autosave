"""Terminal draft versions and durability evidence reach the model-facing clarify result.

The Desktop reconciles its device copy against the server's by per-question revision, and shows whether
the server copy is on disk. Both must survive settlement into the tool JSON, as additive fields only:
``drafts[].question_id`` / ``drafts[].revision`` (only when valid, never invented) and ``drafts_durable``
(only when known, ``false`` kept explicitly).
"""
import json

import pytest

from tools import clarify_drafts as store
from tools.clarify_tool import _normalize_questions, _result


def _questions():
    normalized, error = _normalize_questions([{"question": "One?"}, {"question": "Pick?", "choices": ["a", "b"],
                                                                     "multi_select": True}])
    assert error is None
    return normalized


def test_a_failed_disk_write_reaches_the_tool_json_as_durable_false_with_the_saved_revision(tmp_path, monkeypatch):
    questions = _questions()
    book = store.DraftBook("srq-aaaaaaaaaaaa", questions, store.DraftScope(tmp_path, "tui_gateway", "k"))

    def refuse(*_a, **_k):
        raise OSError("disk full")
    monkeypatch.setattr(store, "_atomic_write", refuse)
    book.save("q0", [], "typed\nline ✓", 1792632412001, locked=set, is_open=lambda: True)
    book.save("q1", ["b"], "", 7, locked=set, is_open=lambda: True)
    reply = {"answers": {}, "outcome": "timed_out", **book.settle({}, "timed_out")}
    result = json.loads(_result(questions, reply))
    assert result["drafts_durable"] is False
    assert result["drafts_request_id"] == "srq-aaaaaaaaaaaa"
    assert result["drafts"] == [
        {"question_index": 0, "question_id": "q0", "question": "One?", "selected_choices": [],
         "typed_text": "typed\nline ✓", "revision": 1792632412001},
        {"question_index": 1, "question_id": "q1", "question": "Pick?", "selected_choices": ["b"],
         "typed_text": "", "revision": 7}]
    assert [r["status"] for r in result["responses"]] == ["unanswered", "unanswered"]


def test_a_persisted_settlement_reports_durable_true(tmp_path):
    questions = _questions()
    book = store.DraftBook("srq-bbbbbbbbbbbb", questions, store.DraftScope(tmp_path, "session_owner", "k"))
    book.save("q0", [], "on disk", 3, locked=set, is_open=lambda: True)
    result = json.loads(_result(questions, {"answers": {}, "outcome": "cancelled", **book.settle({}, "cancelled")}))
    assert result["drafts_durable"] is True and result["drafts"][0]["revision"] == 3


@pytest.mark.parametrize("revision", [None, True, "5", -1, 0, 2 ** 53])
def test_unknown_or_invalid_versions_and_durability_are_never_invented(revision):
    draft = {"choices": [], "text": "old payload"}
    if revision is not None:
        draft["revision"] = revision
    result = json.loads(_result(_questions(), {"answers": {}, "outcome": "timed_out", "drafts": {"q0": draft}}))
    assert "revision" not in result["drafts"][0] and result["drafts"][0]["question_id"] == "q0"
    assert "drafts_durable" not in result
    result = json.loads(_result(_questions(), {"answers": {}, "outcome": "timed_out", "drafts": {"q0": draft},
                                               "drafts_durable": "yes"}))
    assert "drafts_durable" not in result


def test_a_stale_retry_reports_the_held_copys_real_durability(tmp_path, monkeypatch):
    """``stale`` says whether the HELD (newer or equal) revision is on disk, never inferred from staleness."""
    book = store.DraftBook("srq-cccccccccccc", _questions(), store.DraftScope(tmp_path, "tui_gateway", "k"))
    real_write = store._atomic_write

    def refuse(*_a, **_k):
        raise OSError("disk full")
    monkeypatch.setattr(store, "_atomic_write", refuse)
    assert book.save("q0", [], "v5", 5, locked=set, is_open=lambda: True) == {
        "status": "ok", "revision": 5, "durable": False}
    assert book.save("q0", [], "v5 retry", 5, locked=set, is_open=lambda: True) == {
        "status": "stale", "revision": 5, "durable": False}
    monkeypatch.setattr(store, "_atomic_write", real_write)
    assert book.save("q0", [], "v6", 6, locked=set, is_open=lambda: True)["durable"] is True
    assert book.save("q0", [], "v6 retry", 6, locked=set, is_open=lambda: True) == {
        "status": "stale", "revision": 6, "durable": True}
    # Another question's later disk failure leaves q0's retained copy where it was: still on disk.
    monkeypatch.setattr(store, "_atomic_write", refuse)
    assert book.save("q1", ["a"], "", 1, locked=set, is_open=lambda: True)["durable"] is False
    assert book.save("q0", [], "v6 again", 6, locked=set, is_open=lambda: True)["durable"] is True
