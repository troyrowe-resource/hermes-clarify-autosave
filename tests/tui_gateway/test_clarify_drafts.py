"""Unsent clarify drafts on the TUI/Desktop sidecar (``clarify.draft`` / ``clarify.drafts``).

Regression: a Desktop batch card staged every pick and typed answer in React state and sent nothing
until Confirm, so a batch that timed out (Q6-10 of a real session) reached the model as five
``unanswered`` rows and the typed text was gone for good. A draft is saved WITHOUT settling the
request: it never counts as an answer, a lock or skip supersedes it, and the timed-out tool result
reports it separately with ``drafts_submitted: false``.
"""

import io
import json
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tests.waiting import wait_until


@pytest.fixture()
def server():
    import tui_gateway.server_requests
    import tui_gateway.transport
    import hermes_constants
    with patch.dict("sys.modules", {
        "hermes_constants": MagicMock(get_hermes_home=MagicMock(return_value="/tmp/hermes_test"),
                                      get_process_hermes_home=hermes_constants.get_process_hermes_home),
        "hermes_cli.env_loader": MagicMock(),
        "hermes_cli.banner": MagicMock(),
        "hermes_state": MagicMock(),
    }):
        import importlib
        mod = importlib.import_module("tui_gateway.server")
    methods = dict(mod._methods)
    real_stdout = mod._real_stdout
    mod._real_stdout = io.StringIO()
    yield mod
    mod._methods.clear()
    mod._methods.update(methods)
    mod._real_stdout = real_stdout
    for sid in list(mod._sessions):
        mod._sessions.pop(sid, None)
    from tui_gateway import server_requests
    server_requests.reset_for_tests()


class _Peer:
    """A client connection attached to a live session (not a WebSocket build, so always answerable)."""

    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


def _live_session(server, sid, home: Path, *, session_key="stored-1"):
    peer = _Peer()
    server._sessions[sid] = {"session_key": session_key, "transport": peer, "history": [],
                             "history_lock": threading.Lock(), "agent_ready": None, "profile_home": str(home)}
    return peer


def _call(server, peer, method, params):
    from tui_gateway.transport import bind_transport, reset_transport
    token = bind_transport(peer)
    try:
        return server.handle_request({"id": "t", "method": method, "params": params})
    finally:
        reset_transport(token)


QUESTIONS = [
    {"question": "6. What should the panel open with?"},
    {"question": "7. Which exhibitors?", "choices": ["Acme", "Bolt", "Cobalt"], "multi_select": True},
    {"question": "8. Format?", "choices": ["Panel", "Fireside"]},
]


def _normalized():
    from tools.clarify_tool import _normalize_questions
    normalized, error = _normalize_questions(QUESTIONS)
    assert error is None
    return normalized


def _start(server, sid="s1", timeout=None):
    from tui_gateway import server_requests
    box = {}
    normalized = _normalized()
    server._clarify_timeout_seconds = lambda: timeout
    thread = threading.Thread(target=lambda: box.__setitem__("reply", server._clarify_block(sid, normalized)),
                              daemon=True)
    thread.start()
    wait_until(lambda: any(r.sid == sid for r in list(server_requests._open.values())), timeout=10)
    req = next(r for r in list(server_requests._open.values()) if r.sid == sid)
    return thread, box, req, normalized


def test_a_timed_out_batch_returns_saved_drafts_separately_from_answers(server, tmp_path):
    """The original loss: typed text and multi-select picks saved as drafts survive the timeout, and the
    model sees them as unsubmitted drafts while every response stays ``unanswered``."""
    from tools.clarify_tool import _result
    peer = _live_session(server, "s1", tmp_path)
    original = server._clarify_timeout_seconds
    try:
        thread, box, req, normalized = _start(server, timeout=3)
        typed = _call(server, peer, "clarify.draft", {
            "session_id": "s1", "request_id": req.id, "question_id": "q0",
            "text": "Open with the recycling\nstatistics — 42 % ✓", "revision": 1})
        assert typed["result"]["status"] == "ok"
        picked = _call(server, peer, "clarify.draft", {
            "session_id": "s1", "request_id": req.id, "question_id": "q1",
            "choices": ["Acme", "Cobalt"], "text": "plus Delta", "revision": 1})
        assert picked["result"]["status"] == "ok"
        # Saving every draft never settles or consumes a question.
        assert req.id in {r["id"] for r in server._open_requests("s1")}
        thread.join(timeout=10)
    finally:
        server._clarify_timeout_seconds = original
    reply = box["reply"]
    assert reply["answers"] == {} and reply["outcome"] == "timed_out"
    result = json.loads(_result(normalized, reply))
    assert [r["status"] for r in result["responses"]] == ["unanswered"] * 3
    assert all(r["user_response"] is None for r in result["responses"])
    assert result["outcome"] == "timed_out"
    assert result["drafts_submitted"] is False
    assert result["drafts"] == [
        {"question_index": 0, "question_id": "q0", "question": "6. What should the panel open with?",
         "selected_choices": [], "typed_text": "Open with the recycling\nstatistics — 42 % ✓", "revision": 1},
        {"question_index": 1, "question_id": "q1", "question": "7. Which exhibitors?",
         "selected_choices": ["Acme", "Cobalt"], "typed_text": "plus Delta", "revision": 1},
    ]
    assert "not submitted" in result["drafts_notice"] and "wait" in result["drafts_notice"]


def _draft(server, peer, req, qid, *, choices=(), text="", revision, sid="s1", **extra):
    return _call(server, peer, "clarify.draft", {"session_id": sid, "request_id": req.id, "question_id": qid,
                                                "choices": list(choices), "text": text, "revision": revision,
                                                **extra})


def _finish_by_cancel(server, req, thread, sid="s1"):
    from tui_gateway import server_requests
    server_requests.cancel(sid)
    thread.join(timeout=10)


def test_a_stale_revision_never_overwrites_a_newer_draft(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, _ = _start(server)
    assert _draft(server, peer, req, "q0", text="newest", revision=20)["result"] == {
        "status": "ok", "revision": 20, "durable": True}
    # A slow earlier save (lower revision) and a replay of the same revision both lose.
    assert _draft(server, peer, req, "q0", text="older", revision=19)["result"] == {
        "status": "stale", "revision": 20, "durable": True}
    assert _draft(server, peer, req, "q0", text="dupe", revision=20)["result"]["status"] == "stale"
    _finish_by_cancel(server, req, thread)
    assert box["reply"]["drafts"] == {"q0": {"choices": [], "text": "newest", "revision": 20}}


def test_a_lock_or_skip_supersedes_the_draft_and_a_later_draft_cannot_overwrite_it(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, _ = _start(server)
    _draft(server, peer, req, "q0", text="draft zero", revision=1)
    _draft(server, peer, req, "q2", choices=["Panel"], revision=1)
    assert _call(server, peer, "clarify.lock", {"request_id": req.id, "question_id": "q0", "answer": "final"})[
        "result"]["status"] == "ok"
    assert _call(server, peer, "clarify.lock", {"request_id": req.id, "question_id": "q2", "answer": None})[
        "result"]["status"] == "ok"
    assert _draft(server, peer, req, "q0", text="late edit", revision=2)["result"]["status"] == "locked"
    _finish_by_cancel(server, req, thread)
    reply = box["reply"]
    assert reply["answers"] == {"q0": "final", "q2": None} and reply["outcome"] == "cancelled"
    assert "drafts" not in reply  # both superseded; nothing unfinished left
    assert _call(server, peer, "clarify.drafts", {"session_id": "s1"})["result"] == {"drafts": []}


def test_confirm_submits_normally_and_leaves_no_draft_behind(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, normalized = _start(server)
    _draft(server, peer, req, "q1", choices=["Acme"], text="x", revision=1)
    for qid, answer in (("q0", "open"), ("q1", '["Acme"]'), ("q2", "Panel")):
        _call(server, peer, "clarify.lock", {"request_id": req.id, "question_id": qid, "answer": answer})
    thread.join(timeout=10)
    assert box["reply"] == {"answers": {"q0": "open", "q1": '["Acme"]', "q2": "Panel"}, "outcome": "submitted"}
    from tools.clarify_tool import _result
    assert "drafts" not in json.loads(_result(normalized, box["reply"]))
    assert not list((tmp_path / "clarify_drafts").rglob("*.json"))


def test_exact_choice_state_cleared_answers_and_validation(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, _ = _start(server)
    _draft(server, peer, req, "q1", choices=["Acme", "Bolt", "Cobalt"], revision=1)
    # Deselect Bolt: the newest revision is the exact set, not a union.
    _draft(server, peer, req, "q1", choices=["Cobalt", "Acme"], text="", revision=2)
    _draft(server, peer, req, "q2", choices=["Panel (Recommended)"], revision=1)  # label stripped
    _draft(server, peer, req, "q0", text="typed then cleared", revision=1)
    _draft(server, peer, req, "q0", text="", revision=2)  # cleared answer is not reported
    bad = [
        _draft(server, peer, req, "q2", choices=["Panel", "Fireside"], revision=5),  # single-select, two picks
        _draft(server, peer, req, "q1", choices=["Zinc"], revision=5),  # not an offered choice
        _draft(server, peer, req, "q9", text="x", revision=1),  # unknown qid
        _draft(server, peer, req, "q0", text="x" * 16385, revision=9),  # oversize
        _draft(server, peer, req, "q0", text="x", revision=0),  # non-positive revision
    ]
    assert all("error" in r for r in bad), bad
    _finish_by_cancel(server, req, thread)
    assert box["reply"]["drafts"] == {"q1": {"choices": ["Cobalt", "Acme"], "text": "", "revision": 2},
                                      "q2": {"choices": ["Panel"], "text": "", "revision": 1}}


def test_drafts_replay_on_reconnect_separately_from_locked_answers(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, _box, req, _ = _start(server)
    _call(server, peer, "clarify.lock", {"request_id": req.id, "question_id": "q2", "answer": "Panel"})
    _draft(server, peer, req, "q0", text="half typed", revision=3)
    params = next(r for r in server._open_requests("s1") if r["id"] == req.id)["params"]
    assert params["answers"] == {"q2": "Panel"}
    assert params["drafts"] == {"q0": {"choices": [], "text": "half typed", "revision": 3}}
    from tui_gateway.contracts import registry as contracts
    _, problem = contracts.validate_params(contracts.SERVER_REQUESTS["clarify"], params)
    assert problem is None
    _finish_by_cancel(server, req, thread)


def test_drafts_survive_a_backend_restart_on_disk_and_can_be_discarded(server, tmp_path):
    """The request is gone from memory (a restart drops ``_open``); the profile-home file still answers the
    same stored session, with the question text and choices as asked, until it is discarded."""
    from tui_gateway import server_requests
    peer = _live_session(server, "s1", tmp_path)
    thread, _box, req, _ = _start(server)
    _draft(server, peer, req, "q1", choices=["Bolt"], text="Other: Delta", revision=7)
    # Simulate the process dying mid-wait: the in-memory registry vanishes without settling.
    with server_requests._lock:
        server_requests._open.clear()
    req.event.set()
    thread.join(timeout=10)
    # A fresh runtime id for the same stored session after restart.
    server._sessions.pop("s1")
    peer2 = _live_session(server, "s2", tmp_path)
    records = _call(server, peer2, "clarify.drafts", {"session_id": "s2"})["result"]["drafts"]
    assert len(records) == 1 and records[0]["request_id"] == req.id and records[0]["outcome"] is None
    assert records[0]["drafts"] == {"q1": {"choices": ["Bolt"], "text": "Other: Delta", "revision": 7}}
    assert records[0]["questions"][1]["question"] == "7. Which exhibitors?"
    assert records[0]["questions"][1]["choices"] == ["Acme (Recommended)", "Bolt", "Cobalt"]
    stored = next((tmp_path / "clarify_drafts").rglob("*.json"))
    assert stored.stat().st_mode & 0o777 == 0o600
    assert _call(server, peer2, "clarify.drafts.discard", {"session_id": "s2", "request_id": req.id})[
        "result"] == {"status": "ok"}
    assert _call(server, peer2, "clarify.drafts", {"session_id": "s2"})["result"] == {"drafts": []}


def test_drafts_do_not_leak_across_sessions_profiles_requests_or_unattached_viewers(server, tmp_path):
    home_a, home_b = tmp_path / "a", tmp_path / "b"
    peer = _live_session(server, "s1", home_a, session_key="stored-1")
    other = _live_session(server, "s9", home_b, session_key="stored-9")
    thread, box, req, _ = _start(server)
    _draft(server, peer, req, "q0", text="mine", revision=1)
    # Another session's attached viewer, naming its own session: the request is not its own.
    assert _draft(server, other, req, "q0", text="hijack", revision=2, sid="s9")["result"] == {"status": "expired"}
    # The same viewer naming s1 is not attached to it: refused, never answered by request id alone.
    assert _draft(server, other, req, "q0", text="hijack", revision=3)["error"]["code"] == 4003
    assert _call(server, other, "clarify.drafts", {"session_id": "s1"})["error"]["code"] == 4003
    assert _call(server, other, "clarify.drafts", {"session_id": "s9"})["result"] == {"drafts": []}
    # An explicit profile that is not the session's own fails closed.
    server._profile_home = lambda profile: home_b
    assert _draft(server, peer, req, "q0", text="x", revision=4, profile="other")["error"]["code"] == 4003
    _finish_by_cancel(server, req, thread)
    assert box["reply"]["drafts"] == {"q0": {"choices": [], "text": "mine", "revision": 1}}
    # A new request in the same session asks q0 again: no draft carries over.
    thread2, box2, req2, _ = _start(server)
    assert req2.id != req.id and req2.drafts.snapshot({}) == {}
    assert "drafts" not in server._open_requests("s1")[0]["params"]
    _finish_by_cancel(server, req2, thread2)
    assert "drafts" not in box2["reply"]
    assert _call(server, peer, "clarify.drafts", {"session_id": "s1"})["result"]["drafts"][0]["request_id"] == req.id


def test_a_draft_is_not_a_pending_prompt_after_settlement(server, tmp_path):
    from tui_gateway import server_requests
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, _ = _start(server)
    _draft(server, peer, req, "q0", text="kept", revision=1)
    _finish_by_cancel(server, req, thread)
    assert server_requests.open_request_count() == 0
    assert server_requests.pending_kind("s1") == ""
    assert server._open_requests("s1") == []
    assert _draft(server, peer, req, "q0", text="after", revision=2)["result"] == {"status": "expired"}
    assert box["reply"]["drafts"] == {"q0": {"choices": [], "text": "kept", "revision": 1}}


def test_discarding_an_open_requests_drafts_stops_an_in_flight_save_recreating_them(server, tmp_path):
    peer = _live_session(server, "s1", tmp_path)
    thread, box, req, _ = _start(server)
    _draft(server, peer, req, "q0", text="scrap this", revision=1)
    assert _call(server, peer, "clarify.drafts.discard", {"session_id": "s1", "request_id": req.id})[
        "result"] == {"status": "ok"}
    assert _draft(server, peer, req, "q0", text="in flight", revision=2)["result"] == {"status": "discarded"}
    _finish_by_cancel(server, req, thread)
    assert "drafts" not in box["reply"] and box["reply"]["outcome"] == "cancelled"
    assert _call(server, peer, "clarify.drafts", {"session_id": "s1"})["result"] == {"drafts": []}
    other = _live_session(server, "s9", tmp_path / "other", session_key="stored-9")
    assert _call(server, other, "clarify.drafts.discard", {"session_id": "s1", "request_id": req.id})[
        "error"]["code"] == 4003
