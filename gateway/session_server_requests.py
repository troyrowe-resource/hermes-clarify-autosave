"""The session owner's server→client requests to a local viewer, and who may settle them.

The owner sends a request frame (``tui_gateway/contracts/server_requests.py``: ``sudo``, ``secret``,
``clarify``, the Desktop UI requests) to the viewers attached to a session's event stream and blocks the
agent thread until one answers, the turn is interrupted, or it times out: the canonical side of main's
sidecar ``tui_gateway/server_requests.py``. A viewer answers with a JSON-RPC response frame
(:func:`resolve`) or, for a batch clarify, per question with ``clarify.lock`` (:func:`lock_answer`); both go
through :func:`may_settle`, and a batch's terminal result comes from ``tools.clarify_batch.settle_batch``,
the rule the sidecar uses too. Values are never published, journaled or logged: they travel only in the
viewer's response frame.

A batch also keeps the viewer's unsent drafts (``clarify.draft`` → :func:`save_draft`), through the same
``tools.clarify_drafts.DraftBook`` the sidecar uses and behind the same :func:`may_settle` rule: a draft
never settles, a lock or skip supersedes it, and what is still drafted when the wait ends rides the
terminal result beside ``answers``.

A request frame is written once, to the transports attached when it is asked, so a socket that drops and
re-attaches (a 1006 close, a renderer reload) would never see it again. :func:`snapshot_fields` restores it
in the ``session.resume`` / ``session.events.since`` answers as ``open_requests`` entries (the sidecar's
``ServerRequest.snapshot``: the request as sent plus the locks and drafts so far), to exactly the viewers
:func:`may_settle` entitles, so a reconnecting card keeps every answer and draft it already saved.
"""
from __future__ import annotations

import contextlib
import threading
import time
import uuid

from tools.clarify_batch import settle_batch
from tools.clarify_drafts import DraftBook

REQUEST_TIMEOUT_S = 120  # main: ``_ask("sudo", ..., timeout=120)``
_POLL_S = 0.25


class _Pending:
    __slots__ = ("created_at", "drafts", "event", "events", "locked", "method", "params", "qids", "request_id",
                 "result", "session_id", "value")

    def __init__(self, session_id, qids=None, events=None, *, request_id=None, method=None, params=None):
        self.event = threading.Event()
        self.session_id = session_id
        # What a viewer that missed the frame needs to see the request again (``snapshot``).
        self.request_id, self.method, self.params = request_id, method, params
        self.created_at = time.monotonic()
        # The live session's own event stream the request went out on: one per authority (profile) and
        # session mount, so a viewer of another profile's same-named session can never settle it.
        self.events = events
        self.value = ""
        self.result = None
        # A batch clarify: its question ids and the answers ``clarify.lock`` has locked so far.
        self.qids = tuple(qids) if qids else None
        self.locked = {}
        self.drafts = None  # a batch's DraftBook, bound once the request id exists (``_ask``)

    def snapshot(self, locked: dict) -> dict:
        """The ``open_requests`` entry for a viewer that missed the request frame: the request as sent, plus the
        batch answers *locked* so far (a copy taken under the registry lock) and the unsent drafts no lock
        superseded (``ServerRequest.snapshot``)."""
        params = {"session_id": self.session_id, **self.params}
        if locked:
            params["answers"] = locked
        if self.drafts is not None and (drafts := self.drafts.snapshot(locked)):
            params["drafts"] = drafts
        return {"id": self.request_id, "method": self.method, "params": params}


_lock = threading.Lock()
_open: dict[str, _Pending] = {}


def owned_by(authority, session_id, events) -> bool:
    """True when *authority*'s live *session_id* is the very stream a request was sent on."""
    live = authority.sessions.get(session_id)
    return live is not None and events is not None and live.event_stream is events


def may_settle(authority, actor, session_id, events) -> bool:
    """The one rule for who may settle an owner request (a response frame or ``clarify.lock``): the
    request went out on *authority*'s own live stream for that session (session ids repeat across
    profiles and ``_open`` is process-wide), *actor* holds ``session:respond`` there, and *actor* is
    attached to that session, the same set of connections the request frame was written to."""
    return owned_by(authority, session_id, events) and may_act_on_session(authority, actor, session_id)


def may_act_on_session(authority, actor, session_id) -> bool:
    """*actor* holds ``session:respond`` on *authority*'s live *session_id* and is attached to it: who may
    answer its requests, and read or discard the session's saved clarify drafts once a request ended."""
    from gateway.session_contract import SessionRef
    from hermes_state_runtime import RuntimeStoreError
    try:
        authority.authorize(actor, SessionRef(authority.profile_id, session_id), "session:respond")
    except RuntimeStoreError:
        return False
    live = authority.sessions.get(session_id)
    return live is not None and actor in live.subscribers.values()


def is_response_frame(frame) -> bool:
    """A viewer's answer to one of the owner's requests: a string ``srq-`` id, a result/error, no method."""
    return (isinstance(frame, dict) and "method" not in frame and isinstance(frame.get("id"), str)
            and frame["id"].startswith("srq-") and ("result" in frame or "error" in frame))


def resolve(frame, *, session_ok=lambda session_id, events: True) -> bool:
    """Settle the open request *frame* answers; False when nothing (here) waits for that id.
    ``session_ok(session_id, events)`` lets the caller refuse an answer from a connection not entitled
    to that session: the caller's own authority must own ``events``, the stream the request was sent on
    (session ids are only unique per profile, and ``_open`` is process-wide)."""
    with _lock:
        pending = _open.get(frame["id"])
        if pending is None or not session_ok(pending.session_id, pending.events):
            return False
        _open.pop(frame["id"], None)
        locked = dict(pending.locked) if pending.qids is not None else None
    result = frame.get("result") if "error" not in frame else None
    if locked is not None:
        # One rule with main's sidecar registry: the frame's answers over the locks, or a cancel-all.
        result = settle_batch(locked, result)
    value = result.get("value") if isinstance(result, dict) else ""
    pending.value = value if isinstance(value, str) else ""
    pending.result = result if isinstance(result, dict) else None
    pending.event.set()
    return True


def ask_viewer(events, session_id, method, params, *, cancelled=lambda: False, timeout=REQUEST_TIMEOUT_S) -> str:
    """Send one one-string server→client request (``sudo``, ``secret``: ``ValueResult``) to the
    session's attached viewers and wait for its ``value``; "" on skip, interrupt, timeout or no viewer."""
    pending = _ask(events, session_id, method, params, cancelled=cancelled, timeout=timeout)
    return pending.value if pending is not None else ""


def ask_viewer_result(events, session_id, method, params, *, cancelled=lambda: False, timeout=REQUEST_TIMEOUT_S,
                      qids=None, draft_scope=None):
    """The same round trip for a structured answer (``clarify``: ``ClarifyResult``): the viewer's
    ``result`` dict, or None on interrupt, timeout, an error response or no attached viewer.
    ``qids`` makes it a batch, which always ends with ``{answers: <locked so far>, outcome}`` once
    asked: ``lock_answer`` (the ``clarify.lock`` verb) answers it per question."""
    pending = _ask(events, session_id, method, params, cancelled=cancelled, timeout=timeout, qids=qids,
                   draft_scope=draft_scope)
    return pending.result if pending is not None else None


def lock_answer(request_id, question_id, answer, *, session_ok=lambda session_id, events: False):
    """Lock one answer of an open batch request (``clarify.lock``; editable until the last lock;
    ``None`` = skipped). Returns the question ids still unanswered; the lock that empties it settles
    the request with ``{answers, outcome: submitted}``. ``None`` when no open batch has that id or the
    caller may not answer its session (expired, or another profile's / session's request: see
    :func:`resolve`); ``ValueError`` for an unknown question id."""
    with _lock:
        pending = _open.get(request_id)
        if pending is None or pending.qids is None or not session_ok(pending.session_id, pending.events):
            return None
        if question_id not in pending.qids:
            raise ValueError(question_id)
        pending.locked[question_id] = answer
        remaining = [qid for qid in pending.qids if qid not in pending.locked]
        if not remaining:
            _open.pop(request_id, None)
            pending.result = settle_batch(pending.locked, ended="submitted")
    pending.drafts.supersede(question_id)
    if not remaining:
        pending.event.set()
    return remaining


def _open_batch(request_id, session_ok):
    with _lock:
        pending = _open.get(request_id)
        if pending is None or pending.drafts is None or not session_ok(pending.session_id, pending.events):
            return None
        return pending


def save_draft(request_id, question_id, choices, text, revision, *, session_ok=lambda session_id, events: False):
    """Save one unsent draft of an open batch (``clarify.draft``; ``tools.clarify_drafts.DraftBook.save``):
    never a lock, never settles. None when no open batch has that id or the caller may not act on its
    session (:func:`may_settle`); ``ValueError`` for an unknown question or a draft it cannot hold."""
    pending = _open_batch(request_id, session_ok)
    if pending is None:
        return None

    def locked():
        with _lock:
            return set(pending.locked)

    def is_open():
        with _lock:
            return _open.get(request_id) is pending
    return pending.drafts.save(question_id, choices, text, revision, locked=locked, is_open=is_open)


def discard_open_drafts(request_id, *, session_ok=lambda session_id, events: False) -> bool:
    """Discard an open batch's drafts so no in-flight save can recreate them; False when none is open
    for an entitled caller."""
    pending = _open_batch(request_id, session_ok)
    if pending is None:
        return False
    pending.drafts.discard()
    return True


def snapshot_fields(authority, actor, session_id) -> dict:
    """``{"open_requests": [...]}`` for a ``session.resume`` / ``session.events.since`` answer: the batch requests
    still open on *authority*'s live *session_id*, oldest first, for a viewer that attached after their frame
    went out. Entitled exactly like :func:`lock_answer` (:func:`may_settle`): only a viewer attached to that live
    session with ``session:respond``, never another session's or another profile's request (the table is
    process-wide). ``{}`` when this viewer has none, so every client that never saw the key sees none."""
    with _lock:
        pending = sorted((p for p in _open.values() if p.qids is not None and p.session_id == session_id),
                         key=lambda p: p.created_at)
        entitled = [(p, dict(p.locked)) for p in pending if may_settle(authority, actor, p.session_id, p.events)]
    # Outside the registry lock: a draft book may be mid-write (fsync) and must never stall other requests.
    entries = [p.snapshot(locked) for p, locked in entitled]
    return {"open_requests": entries} if entries else {}


def _settle_drafts(pending):
    """Close a settled batch's draft book: the result gains the drafts no answer or skip superseded."""
    if pending.drafts is not None and isinstance(pending.result, dict):
        answers = pending.result.get("answers") if isinstance(pending.result.get("answers"), dict) else {}
        pending.result = {**pending.result, **pending.drafts.settle(answers, pending.result.get("outcome"))}


def _ask(events, session_id, method, params, *, cancelled, timeout, qids=None, draft_scope=None):
    if not events.fanout.transports():
        return None
    request_id = f"srq-{uuid.uuid4().hex[:12]}"
    pending = _Pending(session_id, qids, events, request_id=request_id, method=method, params=params)
    if pending.qids is not None:
        pending.drafts = DraftBook(request_id, params.get("questions") or [], draft_scope)
    with _lock:
        _open[request_id] = pending
    events.fanout.write({"jsonrpc": "2.0", "id": request_id, "method": method,
                         "params": {"session_id": session_id, **params}})
    waited = 0.0
    reason = "timeout"
    while not pending.event.wait(_POLL_S):
        waited += _POLL_S
        if cancelled():
            reason = "interrupted"
            break
        if timeout is not None and waited >= timeout:
            break
    with _lock:
        still_open = _open.pop(request_id, None) is pending
        if still_open and pending.qids is not None:
            # A batch keeps every answer locked before the wait ended (main's sidecar: "locked
            # answers survive a timeout"); sudo/secret have no question ids and stay unanswered.
            pending.result = settle_batch(pending.locked,
                                          ended="cancelled" if reason == "interrupted" else "timed_out")
    if still_open:
        # The same teardown main's renderers key on (``request.cancel``): the card closes and a
        # timed-out password prompt says so.
        with contextlib.suppress(Exception):
            events.publish(session_id, {"id": request_id, "method": method, "reason": reason},
                           event_type="request.cancel")
        if pending.qids is None:
            return None
        _settle_drafts(pending)
        return pending
    # Settled by a viewer (a response frame or the last ``clarify.lock``): every OTHER viewer still
    # shows the card, and a classic CLI is parked inside its modal callback. Withdraw it everywhere
    # with ``reason: resolved`` (``RequestCancelReason``) so each renderer closes the matching card and
    # the CLI's connection thread releases its modal (``hermes_cli.gateway_agent``). No answer rides it.
    with contextlib.suppress(Exception):
        events.publish(session_id, {"id": request_id, "method": method, "reason": "resolved"},
                       event_type="request.cancel")
    _settle_drafts(pending)
    return pending
