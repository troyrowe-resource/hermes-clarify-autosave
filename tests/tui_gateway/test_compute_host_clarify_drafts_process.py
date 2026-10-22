"""Unsent clarify drafts through a REAL compute-host child process (turn isolation), end to end.

A real ``HostSupervisor`` starts ``tests/tui_gateway/_compute_host_clarify_child.py``: the production
``compute_host.run_host`` loop whose only fake is the agent, which asks one batch ``clarify`` through the real
clarify tool where a model's tool call would. The serving-process side is production code too
(``_submit_prompt_to_compute_host``, ``_relay_compute_host_rpc``, the ``clarify.draft`` / ``clarify.lock`` /
``clarify.drafts*`` handlers). What this proves that the fake-supervisor tests cannot: the child persists under
the SAME ``DraftScope`` (profile home + stored session key + gateway) the parent reads, so recall works after the
child exits; the statuses and the reconnect snapshot cross a real pipe; the model-facing result marks drafts as
not submitted; and a wedged or dead child is an error, never a durable save.
"""
import json
import os
import signal
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.waiting import wait_until
from tools.clarify_drafts import DraftScope, list_records
from tui_gateway import host_supervisor, server
from tui_gateway.host_supervisor import HostSupervisor
from tui_gateway.transport import bind_transport, reset_transport

pytestmark = pytest.mark.platforms("posix")

CHILD = Path(__file__).with_name("_compute_host_clarify_child.py")
ANSWERABLE_SECS = 120.0  # a deadline for a cold child (full agent-stack imports on a loaded box), never a delay


class _Peer:
    """A client connection attached to the live session."""

    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


@pytest.fixture()
def hosted(monkeypatch, tmp_path):
    monkeypatch.setattr(host_supervisor, "_HELLO_TIMEOUT_SECS", ANSWERABLE_SECS)
    import hermes_cli.banner as banner
    monkeypatch.setattr(banner, "get_update_result", lambda timeout=0.5: None)
    out = tmp_path / "child-out"
    out.mkdir()
    supervisor = HostSupervisor(
        registry_path=tmp_path / "host.json", argv=[sys.executable, "-P", str(CHILD)],
        rpc_sink=server._relay_compute_host_rpc, respawn_max=0, expected_build_sha="unknown",
        env={"CLARIFY_CHILD_OUT": str(out), "HOME": str(tmp_path), "USERPROFILE": str(tmp_path)})
    monkeypatch.setattr(server, "_load_cfg", lambda: {"dashboard": {"turn_isolation": True}})
    monkeypatch.setattr(server, "_get_compute_host_supervisor", lambda _cfg=None: supervisor)
    sessions = []
    try:
        yield SimpleNamespace(supervisor=supervisor, out=out, home=tmp_path, sessions=sessions, monkeypatch=monkeypatch)
    finally:
        for sid in sessions:
            server._sessions.pop(sid, None)
        supervisor.shutdown()


def _session(hosted, sid, key="stored-1"):
    peer = _Peer()
    session = {"session_key": key, "transport": peer, "history": [], "history_lock": threading.Lock(),
               "agent": None, "agent_ready": threading.Event(), "profile_home": str(hosted.home),
               "running": False, "attached_images": [], "cols": 80}
    server._sessions[sid] = session
    hosted.sessions.append(sid)
    return SimpleNamespace(sid=sid, peer=peer, session=session)


def _ask(hosted, sid="host-s1", key="stored-1"):
    """Start an isolated turn whose agent asks the batch clarify; returns once the client holds the request."""
    live = _session(hosted, sid, key)
    started = server._submit_prompt_to_compute_host("rid", sid, live.session, "ask me")
    assert started["result"]["turn_isolation"] is True, started
    live.request_id = wait_until(
        lambda: next((f["id"] for f in list(live.peer.frames) if f.get("method") == "clarify"), None),
        timeout=ANSWERABLE_SECS, what="the child's batch clarify request frame")
    return live


def _call(live, method, params):
    token = bind_transport(live.peer)
    try:
        return server.handle_request({"id": "t", "method": method, "params": params})
    finally:
        reset_transport(token)


def _draft(live, qid, *, choices=(), text="", revision):
    return _call(live, "clarify.draft", {"session_id": live.sid, "request_id": live.request_id, "question_id": qid,
                                         "choices": list(choices), "text": text, "revision": revision})


def _snapshot(live):
    return next(r for r in server._open_requests(live.sid) if r["id"] == live.request_id)["params"]


def _cancel_all(live):
    """The card's plain cancel (a response frame with no answers): relayed to the child that owns the wait."""
    assert server.dispatch({"jsonrpc": "2.0", "id": live.request_id, "result": {}}) is None


def _tool_result(hosted, live):
    """What the child's clarify tool handed the model once the wait ended."""
    path = hosted.out / f"{live.sid}.json"
    wait_until(path.exists, timeout=ANSWERABLE_SECS, what="the child's tool result")
    return json.loads(path.read_text(encoding="utf-8"))


def _turn_over(live):
    wait_until(lambda: not live.session.get("running") and "_compute_host_open_request" not in live.session,
               timeout=ANSWERABLE_SECS, what="the isolated turn to complete in the serving process")


def test_a_draft_saved_by_the_child_is_durable_recalled_by_the_parent_after_a_restart_and_never_an_answer(hosted):
    live = _ask(hosted)
    typed = "Open with the\nrecycling statistics — 42 % ✓"
    assert _draft(live, "q0", text=typed, revision=1)["result"] == {"status": "ok", "revision": 1, "durable": True}
    assert _draft(live, "q1", choices=["Acme", "Cobalt"[:0] or "Bolt"], text="plus Delta", revision=1)["result"][
        "durable"] is True
    assert _draft(live, "q0", text="older", revision=1)["result"] == {"status": "stale", "revision": 1, "durable": True}
    # Saving drafts never settles the request, and the reconnect snapshot follows the child's book.
    assert _snapshot(live)["drafts"] == {
        "q0": {"choices": [], "text": typed, "revision": 1},
        "q1": {"choices": ["Acme", "Bolt"], "text": "plus Delta", "revision": 1}}
    assert "answers" not in _snapshot(live)
    # The child's file is under the scope the PARENT reads: profile home + stored session key + gateway.
    scope = DraftScope(hosted.home, "tui_gateway", "stored-1")
    assert [r["request_id"] for r in list_records(scope)] == [live.request_id]

    _cancel_all(live)
    result = _tool_result(hosted, live)
    assert [r["status"] for r in result["responses"]] == ["unanswered", "unanswered"]
    assert all(r["user_response"] is None for r in result["responses"])
    assert result["outcome"] == "cancelled" and result["drafts_submitted"] is False
    assert result["drafts_durable"] is True and result["drafts_request_id"] == live.request_id
    assert [(d["question_id"], d["typed_text"], d["selected_choices"]) for d in result["drafts"]] == [
        ("q0", typed, []), ("q1", "plus Delta", ["Acme", "Bolt"])]
    _turn_over(live)

    # The child exits and the backend "restarts": a fresh runtime id for the same stored session recalls them.
    hosted.supervisor.shutdown()
    fresh = _session(hosted, "host-after-restart")
    [record] = _call(fresh, "clarify.drafts", {"session_id": fresh.sid})["result"]["drafts"]
    assert record["request_id"] == live.request_id and record["outcome"] == "cancelled"
    assert record["drafts"] == {"q0": {"choices": [], "text": typed, "revision": 1},
                                "q1": {"choices": ["Acme", "Bolt"], "text": "plus Delta", "revision": 1}}
    assert record["questions"][1]["question"] == "Which exhibitors?"
    assert _call(fresh, "clarify.drafts.discard", {"session_id": fresh.sid, "request_id": live.request_id})[
        "result"] == {"status": "ok"}
    assert _call(fresh, "clarify.drafts", {"session_id": fresh.sid})["result"] == {"drafts": []}


def test_lock_stale_and_discard_reach_the_childs_book_while_the_request_is_open(hosted):
    live = _ask(hosted)
    assert _draft(live, "q0", text="draft", revision=5)["result"]["status"] == "ok"
    assert _draft(live, "q0", text="older", revision=4)["result"] == {"status": "stale", "revision": 5, "durable": True}
    assert _draft(live, "q1", choices=["Bolt"], revision=1)["result"]["status"] == "ok"
    # A lock is the answer: it supersedes q0's draft in the child's book, the stored record and the snapshot.
    locked = _call(live, "clarify.lock", {"request_id": live.request_id, "question_id": "q0", "answer": "final"})
    assert locked["result"] == {"status": "ok", "remaining": ["q1"]}
    assert _draft(live, "q0", text="late edit", revision=6)["result"] == {"status": "locked"}
    params = _snapshot(live)
    assert params["answers"] == {"q0": "final"}
    assert params["drafts"] == {"q1": {"choices": ["Bolt"], "text": "", "revision": 1}}
    [record] = list_records(DraftScope(hosted.home, "tui_gateway", "stored-1"))
    assert set(record["drafts"]) == {"q1"}
    # Discarding while open closes the book: an in-flight save cannot bring the drafts back.
    assert _call(live, "clarify.drafts.discard", {"session_id": live.sid, "request_id": live.request_id})[
        "result"] == {"status": "ok"}
    assert _draft(live, "q1", choices=["Bolt"], text="in flight", revision=2)["result"] == {"status": "discarded"}
    assert "drafts" not in _snapshot(live)
    assert list_records(DraftScope(hosted.home, "tui_gateway", "stored-1")) == []

    _cancel_all(live)
    result = _tool_result(hosted, live)
    assert [r["status"] for r in result["responses"]] == ["answered", "unanswered"]
    assert result["responses"][0]["user_response"] == "final"
    assert "drafts" not in result and "drafts_submitted" not in result
    _turn_over(live)


def test_a_real_timeout_without_confirm_keeps_the_drafts_durably_and_the_late_save_is_expired(hosted):
    (hosted.out / "clarify-timeout").write_text("8")
    live = _ask(hosted)
    assert _draft(live, "q1", choices=["Acme"], text="Other: Delta", revision=3)["result"] == {
        "status": "ok", "revision": 3, "durable": True}
    result = _tool_result(hosted, live)  # the child's own clarify deadline passes: nothing was ever submitted
    assert result["outcome"] == "timed_out"
    assert [r["status"] for r in result["responses"]] == ["unanswered", "unanswered"]
    assert result["drafts_submitted"] is False and result["drafts_durable"] is True
    assert [(d["question_id"], d["selected_choices"], d["typed_text"], d["revision"]) for d in result["drafts"]] == [
        ("q1", ["Acme"], "Other: Delta", 3)]
    _turn_over(live)
    assert _draft(live, "q1", choices=["Acme"], text="too late", revision=4)["result"] == {"status": "expired"}
    [record] = _call(live, "clarify.drafts", {"session_id": live.sid})["result"]["drafts"]
    assert record["outcome"] == "timed_out" and record["drafts"] == {
        "q1": {"choices": ["Acme"], "text": "Other: Delta", "revision": 3}}


def test_a_wedged_or_dead_child_is_an_error_never_a_durable_save_and_what_it_saved_survives(hosted):
    live = _ask(hosted)
    assert _draft(live, "q0", text="kept on disk", revision=1)["result"]["durable"] is True
    pid = hosted.supervisor.pid
    hosted.monkeypatch.setattr(server, "_COMPUTE_HOST_DRAFT_WAIT_SECS", 2.0)
    os.kill(pid, signal.SIGSTOP)  # wedged: alive, answers nothing
    try:
        wedged = _draft(live, "q0", text="never acknowledged", revision=2)
        assert wedged["error"]["code"] == 5019 and "result" not in wedged
        gone = _call(live, "clarify.drafts.discard", {"session_id": live.sid, "request_id": live.request_id})
        assert gone["error"]["code"] == 5019 and "result" not in gone
    finally:
        os.kill(pid, signal.SIGKILL)  # dead: the supervisor fails the turn and the mirror goes
    _turn_over(live)
    after = _draft(live, "q0", text="nobody to save against", revision=3)
    assert after.get("result") == {"status": "expired"} or after["error"]["code"] == 5019
    # Recall needs no child: the record the child persisted before it died is still there, unfinished.
    [record] = _call(live, "clarify.drafts", {"session_id": live.sid})["result"]["drafts"]
    assert record["request_id"] == live.request_id and record["outcome"] is None
    assert record["drafts"] == {"q0": {"choices": [], "text": "kept on disk", "revision": 1}}
