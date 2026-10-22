"""Unsent clarify drafts for a batch request the compute-host (turn isolation) CHILD owns.

Under ``dashboard.turn_isolation`` the batch ``clarify`` request is minted by the child; the serving
process holds only a mirror (``session["_compute_host_open_request"]``). ``clarify.lock`` was already
proxied into the child, but ``clarify.draft`` / ``clarify.drafts.discard`` only looked at the parent's own
registry, found no request and answered ``expired``, so the card fell back to device-only protection while
the model was told nothing. These tests pin the relay: the parent (the sole entitlement authority) forwards a
draft op to the child that owns the book, with the same statuses, a reconnect snapshot that follows the
child's book, and a dead child that can never read as a durable save.

Parent half: a fake supervisor stands in for ``HostSupervisor`` (no child is started). Child half: a real
``ComputeHost`` over real ``server_requests`` / ``DraftBook`` / disk store. The real-process end to end is
``test_compute_host_clarify_drafts_process.py``.
"""
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.tui_gateway._compute_host_frames import FrameSink
from tests.waiting import wait_until
from tools.clarify_drafts import DraftScope, list_records
from tui_gateway import server, server_requests
from tui_gateway.compute_host import ComputeHost
from tui_gateway.contracts import registry as contracts
from tui_gateway.transport import bind_transport, reset_transport

SID = "host-clarify"
RID = "srq-0123456789ab"
QUESTIONS = [{"qid": "q0", "question": "Open with?", "choices": None, "multi_select": False},
             {"qid": "q1", "question": "Which exhibitors?", "choices": ["Acme", "Bolt"], "multi_select": True}]


class _Peer:
    """A client connection attached to the live session."""

    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


class _Supervisor:
    """``HostSupervisor.respond`` stand-in: returns (or raises) what the test queued for each call."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def respond(self, sid, params, *, timeout=15.0):
        self.calls.append((sid, dict(params), timeout))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def _ack(result=None, *, error=None):
    body = {"error": error} if error is not None else {"result": result}
    return {"type": "respond.ack", "response": {"jsonrpc": "2.0", "id": "relay", **body}}


def _call(peer, method, params):
    token = bind_transport(peer)
    try:
        return server.handle_request({"id": "t", "method": method, "params": params})
    finally:
        reset_transport(token)


def _drafts_frame(drafts, *, sid=SID, request_id=RID):
    return {"jsonrpc": "2.0", "method": "compute_host.drafts",
            "params": {"session_id": sid, "request_id": request_id, "drafts": drafts}}


@pytest.fixture()
def hosted(monkeypatch, tmp_path):
    """A live session whose open batch ``clarify`` request is owned by the compute-host child."""
    supervisor = _Supervisor()
    peer = _Peer()
    session = {"session_key": "stored-1", "transport": peer, "history": [], "history_lock": threading.Lock(),
               "agent": None, "agent_ready": threading.Event(), "profile_home": str(tmp_path),
               "_compute_host_active": True}
    server._sessions[SID] = session
    monkeypatch.setattr(server, "_load_cfg", lambda: {"dashboard": {"turn_isolation": True}})
    monkeypatch.setattr(server, "_get_compute_host_supervisor", lambda _cfg=None: supervisor)
    server._relay_compute_host_rpc({"jsonrpc": "2.0", "id": RID, "method": "clarify",
                                    "params": {"session_id": SID, "questions": QUESTIONS}})
    peer.frames.clear()
    yield SimpleNamespace(supervisor=supervisor, peer=peer, session=session, home=tmp_path)
    server._sessions.pop(SID, None)


def _draft(hosted, *, request_id=RID, question_id="q0", choices=(), text="typed", revision=1, **extra):
    return _call(hosted.peer, "clarify.draft", {
        "session_id": SID, "request_id": request_id, "question_id": question_id, "choices": list(choices),
        "text": text, "revision": revision, **extra})


# ── parent: the relay ────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("result", [
    {"status": "ok", "revision": 3, "durable": True},
    {"status": "ok", "revision": 3, "durable": False},
    {"status": "stale", "revision": 9, "durable": True},
    {"status": "stale", "revision": 9, "durable": False},
    {"status": "locked"},
    {"status": "discarded"},
    {"status": "expired"},
])
def test_a_draft_for_a_host_owned_request_is_saved_by_the_child_and_answers_with_its_exact_status(hosted, result):
    hosted.supervisor.replies.append(_ack(result))
    response = _draft(hosted, choices=["Acme"], text="typed\nline ✓", revision=3, question_id="q1")
    assert response["result"] == result
    [(sid, params, timeout)] = hosted.supervisor.calls
    assert sid == SID
    # Only the draft's own fields cross the process boundary: no profile, no session id, nothing else.
    assert params == {"draft": {"request_id": RID, "question_id": "q1", "choices": ["Acme"],
                                "text": "typed\nline ✓", "revision": 3}}
    assert timeout <= 10.0, "an autosave must never hold the connection as long as Confirm may"


def test_the_child_refusing_a_draft_is_the_clients_error_with_the_childs_code_and_message(hosted):
    hosted.supervisor.replies.append(_ack(error={"code": 4002, "message": "text must be a string"}))
    response = _draft(hosted, text="x")
    assert response["error"]["code"] == 4002 and response["error"]["message"] == "text must be a string"
    assert "result" not in response


@pytest.mark.parametrize("failure", [
    RuntimeError("compute host is not running"),
    queue.Empty(),  # HostSupervisor.respond gives up waiting for the child's ack
    {"type": "respond.error", "message": "session not found"},
    {"type": "respond.ack"},
    {"type": "respond.ack", "response": "not a response"},
])
def test_a_dead_or_unreachable_child_is_an_error_never_a_durable_save(hosted, failure):
    hosted.supervisor.replies.append(failure)
    response = _draft(hosted)
    assert response["error"]["code"] == 5019 and "result" not in response
    # Nothing was claimed saved anywhere, in this process either.
    assert list_records(DraftScope(hosted.home, "tui_gateway", "stored-1")) == []


def test_a_child_that_exited_mid_request_answers_through_the_supervisors_error_frame(hosted):
    hosted.supervisor.replies.append({"type": "error", "reason": "crash", "message": "compute host exited with code -9"})
    response = _draft(hosted)
    assert response["error"]["code"] == 5019 and "exited" in response["error"]["message"]


def test_a_connection_not_attached_to_the_session_never_reaches_the_child(hosted):
    stranger = _Peer()
    refused = _call(stranger, "clarify.draft", {"session_id": SID, "request_id": RID, "question_id": "q0",
                                                "choices": [], "text": "hijack", "revision": 9})
    assert refused["error"]["code"] == 4003
    assert hosted.supervisor.calls == []
    refused = _call(stranger, "clarify.drafts.discard", {"session_id": SID, "request_id": RID})
    assert refused["error"]["code"] == 4003 and hosted.supervisor.calls == []


def test_another_profile_fails_closed_before_the_child_is_asked(hosted, monkeypatch, tmp_path):
    other = tmp_path / "other-profile"
    other.mkdir()
    monkeypatch.setattr(server, "_profile_home", lambda profile: other)
    refused = _draft(hosted, profile="other")
    assert refused["error"]["code"] == 4003 and hosted.supervisor.calls == []
    refused = _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": RID, "profile": "other"})
    assert refused["error"]["code"] == 4003 and hosted.supervisor.calls == []


def test_a_request_id_alone_never_grants_access_to_another_sessions_host_owned_request(hosted):
    """A viewer attached to its OWN session names the id of this host-owned request: not its request, so it is
    answered like any unknown id and the child is never asked."""
    other = _Peer()
    server._sessions["s9"] = {"session_key": "stored-9", "transport": other, "history": [],
                              "history_lock": threading.Lock(), "agent": None, "agent_ready": threading.Event(),
                              "profile_home": str(hosted.home / "b"), "_compute_host_active": True}
    try:
        reply = _call(other, "clarify.draft", {"session_id": "s9", "request_id": RID, "question_id": "q0",
                                               "choices": [], "text": "hijack", "revision": 9})
        assert reply["result"] == {"status": "expired"}
        discard = _call(other, "clarify.drafts.discard", {"session_id": "s9", "request_id": RID})
        assert discard["result"] == {"status": "missing"}
    finally:
        server._sessions.pop("s9", None)
    assert hosted.supervisor.calls == []


def test_an_unknown_or_settled_request_is_expired_without_asking_the_child(hosted):
    reply = _draft(hosted, request_id="srq-ffffffffffff")
    assert reply["result"] == {"status": "expired"} and hosted.supervisor.calls == []
    # The child's withdrawal (timeout / cancel) drops the mirror: the card's late save is expired locally.
    server._relay_compute_host_rpc({"jsonrpc": "2.0", "method": "event", "params": {
        "type": "request.cancel", "session_id": SID, "payload": {"id": RID, "method": "clarify", "reason": "timeout"}}})
    reply = _draft(hosted)
    assert reply["result"] == {"status": "expired"} and hosted.supervisor.calls == []


# ── parent: the reconnect snapshot follows the child's book ──────────────────────────────────────


def _snapshot(hosted):
    return next(r for r in server._open_requests(SID) if r["id"] == RID)["params"]


def test_the_reconnect_snapshot_carries_the_drafts_the_child_holds_and_is_a_valid_request(hosted):
    drafts = {"q0": {"choices": [], "text": "half typed", "revision": 3},
              "q1": {"choices": ["Acme"], "text": "plus Delta", "revision": 2}}
    server._relay_compute_host_rpc(_drafts_frame(drafts))
    params = _snapshot(hosted)
    assert params["drafts"] == drafts and "answers" not in params
    _, problem = contracts.validate_params(contracts.SERVER_REQUESTS["clarify"], params)
    assert problem is None
    # Internal bookkeeping: never a client event, never a replay-ring entry.
    assert hosted.peer.frames == []
    # The child's book is the authority: the next snapshot replaces this one, and an empty one removes the key.
    server._relay_compute_host_rpc(_drafts_frame({"q1": drafts["q1"]}))
    assert _snapshot(hosted)["drafts"] == {"q1": drafts["q1"]}
    server._relay_compute_host_rpc(_drafts_frame({}))
    assert "drafts" not in _snapshot(hosted)


def test_a_snapshot_never_lands_on_another_request_or_session(hosted):
    server._relay_compute_host_rpc(_drafts_frame({"q0": {"choices": [], "text": "x", "revision": 1}},
                                                 request_id="srq-ffffffffffff"))
    server._relay_compute_host_rpc(_drafts_frame({"q0": {"choices": [], "text": "x", "revision": 1}}, sid="nope"))
    assert "drafts" not in _snapshot(hosted)


def test_a_lock_through_the_relay_and_the_childs_following_snapshot_keep_answers_and_drafts_apart(hosted):
    server._relay_compute_host_rpc(_drafts_frame({"q0": {"choices": [], "text": "draft", "revision": 1},
                                                  "q1": {"choices": ["Bolt"], "text": "", "revision": 1}}))
    hosted.supervisor.replies.append(_ack({"status": "ok", "remaining": ["q1"]}))
    locked = _call(hosted.peer, "clarify.lock", {"request_id": RID, "question_id": "q0", "answer": "final"})
    assert locked["result"] == {"status": "ok", "remaining": ["q1"]}
    # The child's lock superseded q0's draft and pushed the book it now holds.
    server._relay_compute_host_rpc(_drafts_frame({"q1": {"choices": ["Bolt"], "text": "", "revision": 1}}))
    params = _snapshot(hosted)
    assert params["answers"] == {"q0": "final"}
    assert params["drafts"] == {"q1": {"choices": ["Bolt"], "text": "", "revision": 1}}


# ── parent: discard ──────────────────────────────────────────────────────────────────────────────


def test_discarding_a_host_owned_requests_drafts_closes_the_childs_book(hosted):
    hosted.supervisor.replies.append(_ack({"live": True}))
    response = _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": RID})
    assert response["result"] == {"status": "ok"}
    [(sid, params, _timeout)] = hosted.supervisor.calls
    assert sid == SID and params == {"drafts_discard": {"request_id": RID}}


def test_discarding_what_the_child_no_longer_holds_still_removes_the_stored_record(hosted):
    scope = DraftScope(hosted.home, "tui_gateway", "stored-1")
    from tools.clarify_drafts import persist
    persist(scope, RID, QUESTIONS, {"q0": {"choices": [], "text": "stored", "revision": 1}}, outcome="timed_out")
    hosted.supervisor.replies.append(_ack({"live": False}))
    response = _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": RID})
    assert response["result"] == {"status": "ok"}
    assert list_records(scope) == []
    hosted.supervisor.replies.append(_ack({"live": False}))
    assert _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": RID})["result"] == {
        "status": "missing"}


def test_a_discard_the_child_could_not_apply_is_an_error_and_removes_nothing(hosted):
    """Fail closed: the child's book may still be open and re-create the record, so no half-discard."""
    scope = DraftScope(hosted.home, "tui_gateway", "stored-1")
    from tools.clarify_drafts import persist
    persist(scope, RID, QUESTIONS, {"q0": {"choices": [], "text": "stored", "revision": 1}})
    hosted.supervisor.replies.append(RuntimeError("compute host is not running"))
    response = _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": RID})
    assert response["error"]["code"] == 5019 and "result" not in response
    assert len(list_records(scope)) == 1


def test_discarding_a_settled_requests_stored_drafts_never_asks_the_child(hosted):
    other = "srq-0123456789ac"
    scope = DraftScope(hosted.home, "tui_gateway", "stored-1")
    from tools.clarify_drafts import persist
    persist(scope, other, QUESTIONS, {"q0": {"choices": [], "text": "old", "revision": 1}}, outcome="timed_out")
    response = _call(hosted.peer, "clarify.drafts.discard", {"session_id": SID, "request_id": other})
    assert response["result"] == {"status": "ok"} and hosted.supervisor.calls == []
    assert list_records(scope) == []


# ── child: the half that owns the book ───────────────────────────────────────────────────────────


@pytest.fixture()
def child(monkeypatch, tmp_path):
    """A real ``ComputeHost`` that owns an open batch request: a real ``server_requests.send`` wait with a real
    draft book persisting under the scope ``_clarify_draft_scope`` gives it (what ``_clarify_block`` passes)."""
    monkeypatch.setattr(server_requests, "_write", lambda frame: True)
    monkeypatch.setattr(server_requests, "_emit", lambda event, sid, payload: None)
    sink = FrameSink()
    host = ComputeHost(stdout=sink, heartbeat_secs=0)
    sid = "child-clarify"
    server._sessions[sid] = {"session_key": "stored-1", "history_lock": threading.Lock(),
                             "profile_home": str(tmp_path)}
    scope = server._clarify_draft_scope(sid)
    box = {}
    thread = threading.Thread(target=lambda: box.__setitem__("reply", server_requests.send(
        "clarify", sid, {"questions": QUESTIONS}, timeout=None, qids=["q0", "q1"], draft_scope=scope)), daemon=True)
    thread.start()
    request = wait_until(lambda: next((r for r in list(server_requests._open.values()) if r.sid == sid), None),
                         what="the child's open batch request")
    yield SimpleNamespace(host=host, sink=sink, sid=sid, request=request, scope=scope, home=tmp_path, box=box,
                          thread=thread)
    server_requests.cancel(sid)
    thread.join(timeout=10)
    server._sessions.pop(sid, None)
    server_requests.reset_for_tests()
    host.close()


def _respond(child, params, request_id="relay"):
    child.host._handle_respond({"sid": child.sid, "request_id": request_id, "params": params})
    return child.sink.wait_for(lambda f: f["type"] == "respond.ack" and f["request_id"] == request_id)


def _spec(child, **fields):
    return {"request_id": child.request.id, "question_id": "q0", "choices": [], "text": "typed", "revision": 1,
            **fields}


def _pushed(child):
    return [f["message"]["params"] for f in child.sink.frames()
            if f["type"] == "rpc" and f["message"].get("method") == "compute_host.drafts"]


def test_the_child_saves_a_relayed_draft_under_the_scope_the_parent_reads_and_reports_the_book(child):
    ack = _respond(child, {"draft": _spec(child, question_id="q1", choices=["Acme", "Bolt"], text="Other: Delta",
                                          revision=7)})
    assert ack["response"]["result"] == {"status": "ok", "revision": 7, "durable": True}
    # The record is on disk where the parent's own read looks, so recall works after the child is gone.
    [record] = list_records(DraftScope(Path(child.home), "tui_gateway", "stored-1"))
    assert record["request_id"] == child.request.id
    assert record["drafts"] == {"q1": {"choices": ["Acme", "Bolt"], "text": "Other: Delta", "revision": 7}}
    # Whatever the child's book holds now is pushed for the parent's reconnect snapshot, ahead of the ack.
    assert _pushed(child) == [{"session_id": child.sid, "request_id": child.request.id, "drafts": {
        "q1": {"choices": ["Acme", "Bolt"], "text": "Other: Delta", "revision": 7}}}]
    frames = [f["type"] for f in child.sink.frames()]
    assert frames.index("rpc") < frames.index("respond.ack")
    # A draft never settles anything.
    assert not child.request.event.is_set() and child.request.id in {r["id"] for r in server_requests.open_requests(child.sid)}


def test_the_childs_statuses_are_the_in_process_statuses(child):
    assert _respond(child, {"draft": _spec(child, revision=20)}, "a")["response"]["result"] == {
        "status": "ok", "revision": 20, "durable": True}
    assert _respond(child, {"draft": _spec(child, text="older", revision=19)}, "b")["response"]["result"] == {
        "status": "stale", "revision": 20, "durable": True}
    _respond(child, {"lock": {"request_id": child.request.id, "question_id": "q0", "answer": "final"}}, "c")
    assert _respond(child, {"draft": _spec(child, text="late", revision=21)}, "d")["response"]["result"] == {
        "status": "locked"}
    assert _respond(child, {"drafts_discard": {"request_id": child.request.id}}, "e")["response"]["result"] == {
        "live": True}
    assert _respond(child, {"draft": _spec(child, question_id="q1", text="in flight", revision=1)}, "f")[
        "response"]["result"] == {"status": "discarded"}


def test_the_child_refuses_what_the_question_cannot_hold_exactly_as_the_in_process_handler_does(child):
    for bad in (dict(question_id="q1", choices=["Zinc"]), dict(question_id="q9"), dict(text="x" * 16385),
                dict(revision=0), dict(text=7), dict(question_id="q0", choices=["Acme"])):
        error = _respond(child, {"draft": _spec(child, **bad)}, f"bad-{len(child.sink.frames())}")["response"]["error"]
        assert error["code"] == 4002, (bad, error)
    assert list_records(child.scope) == []


def test_a_draft_after_the_wait_ended_is_expired_and_a_request_of_another_session_is_never_touched(child):
    other = server_requests.ServerRequest("someone-else", "clarify", {"questions": QUESTIONS}, qids=["q0", "q1"],
                                          draft_scope=None)
    with server_requests._lock:
        server_requests._open[other.id] = other
    # The relayed sid is the entitled session's: another session's request id is answered like an unknown one.
    assert _respond(child, {"draft": _spec(child, request_id=other.id)}, "x")["response"]["result"] == {
        "status": "expired"}
    assert other.drafts.snapshot(set()) == {}
    server_requests.cancel(child.sid)
    assert _respond(child, {"draft": _spec(child)}, "y")["response"]["result"] == {"status": "expired"}


def test_a_lock_supersedes_the_draft_in_the_childs_book_and_in_the_snapshot_it_pushes(child):
    _respond(child, {"draft": _spec(child, question_id="q0", text="draft zero")}, "a")
    _respond(child, {"draft": _spec(child, question_id="q1", choices=["Bolt"], text="")}, "b")
    ack = _respond(child, {"lock": {"request_id": child.request.id, "question_id": "q0", "answer": "final"}}, "c")
    assert ack["response"]["result"] == {"status": "ok", "remaining": ["q1"]}
    assert _pushed(child)[-1]["drafts"] == {"q1": {"choices": ["Bolt"], "text": "", "revision": 1}}
    assert child.request.locked == {"q0": "final"}


def test_a_discard_closes_the_book_and_pushes_an_empty_snapshot(child):
    _respond(child, {"draft": _spec(child, text="scrap this")}, "a")
    assert list_records(child.scope)
    assert _respond(child, {"drafts_discard": {"request_id": child.request.id}}, "b")["response"]["result"] == {
        "live": True}
    assert list_records(child.scope) == [] and _pushed(child)[-1]["drafts"] == {}
    # No open book at all (settled, or another session's id): nothing live, nothing pushed.
    pushed = len(_pushed(child))
    assert _respond(child, {"drafts_discard": {"request_id": "srq-ffffffffffff"}}, "c")["response"]["result"] == {
        "live": False}
    assert len(_pushed(child)) == pushed


def test_what_the_child_settles_with_carries_the_relayed_drafts_beside_never_inside_the_answers(child):
    _respond(child, {"draft": _spec(child, question_id="q0", text="Open with\nthe stats ✓")}, "a")
    _respond(child, {"draft": _spec(child, question_id="q1", choices=["Acme"], text="plus Delta")}, "b")
    server_requests.cancel(child.sid)
    child.thread.join(timeout=10)
    reply = child.box["reply"]
    assert reply["answers"] == {} and reply["outcome"] == "cancelled"
    assert reply["drafts_durable"] is True and reply["drafts_request_id"] == child.request.id
    assert reply["drafts"]["q0"]["text"] == "Open with\nthe stats ✓"
    assert reply["drafts"]["q1"]["choices"] == ["Acme"]
    # Settled: the book is closed, and the stored record says how the request ended.
    assert _respond(child, {"draft": _spec(child, revision=99)}, "c")["response"]["result"] == {"status": "expired"}
    [record] = list_records(child.scope)
    assert record["outcome"] == "cancelled" and set(record["drafts"]) == {"q0", "q1"}
