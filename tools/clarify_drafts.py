"""Unsent clarify drafts: what the user typed or picked on an open batch card, kept without answering it.

A batch ``clarify`` request is answered per question with ``clarify.lock`` (final, can complete the
batch). A draft is the other half: the card's staged picks and typed text, saved as the user works
(``clarify.draft``) so a timeout, a cancel, a reconnect or a backend restart does not lose them. A
draft never enters ``answers``, never completes a batch and is never consent: the model sees it only
in a separate ``drafts`` list with ``drafts_submitted: false``.

Both registries that hold batch requests (the TUI/Desktop sidecar ``tui_gateway/server_requests.py`` and
the session owner ``gateway/session_server_requests.py``) keep one :class:`DraftBook` per open batch,
so save / supersede / discard / settle mean exactly the same thing on every surface. Each registry
decides only WHO may touch a request (its own entitlement rule) and whether it is still open.

Scope: one JSON file per request under ``<profile home>/clarify_drafts/<gateway>/<session digest>/``,
written atomically (``0600``, file and directory fsynced). The file holds the request's original
questions and choices, so a draft keeps its meaning after the live request is gone. It stays until it is
discarded (``clarify.drafts.discard``), every draft in it is superseded by a lock or skip, or its owning
session is deleted through a wired deletion path (:func:`purge_session`). Retention is NOT tied to the
clarify timeout or any timer: timing out is exactly when the drafts are needed.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Collection

from hermes_dir_acl import make_user_dir
from utils import atomic_replace

logger = logging.getLogger(__name__)

STORE_DIRNAME = "clarify_drafts"
SCHEMA_VERSION = 1
# The messaging ``clarify.respond`` answer cap: a draft is never larger than an answer could be.
MAX_DRAFT_TEXT_CHARS = 16384
# Revisions are client-minted monotonic integers (a millisecond clock floor); JS-safe integer bound.
MAX_REVISION = 2 ** 53 - 1
# Records listed for one session (newest first); older files stay on disk until discarded.
MAX_LISTED_RECORDS = 50
# Request ids of both registries: ``srq-`` + 12 hex (``uuid4().hex[:12]``).
_REQUEST_ID = re.compile(r"^srq-[0-9a-f]{12}$")
GATEWAYS = frozenset({"tui_gateway", "session_owner"})
# Striped file locks: bounded no matter how many requests a long-lived process sees.
_FILE_LOCKS = tuple(threading.Lock() for _ in range(64))

DRAFTS_NOTICE = (
    "The user typed or selected these drafts on the clarify form, but they were not submitted before the "
    "wait ended. They may inform the discussion, but they are incomplete: not answers, not consent and not "
    "a final decision. Do not act on them as the user's choice; show them to the user and wait for the "
    "user to finish or confirm their answers.")


class DraftError(ValueError):
    """A draft the request's question cannot hold (unknown choice, oversize text, bad revision)."""


def _bare(choice: str) -> str:
    from tools.clarify_tool import strip_recommended
    return strip_recommended(choice)


def normalize_draft(question: dict, choices, text, revision) -> dict:
    """``{choices, text, revision}`` for *question* (a wire entry: ``qid``, ``question``, ``choices``,
    ``multi_select``). Choices must be the question's own offered labels (bare, recommendation label
    stripped), at most one for a single-select; text is the typed/"Other" answer verbatim."""
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 < revision <= MAX_REVISION:
        raise DraftError("revision must be a positive integer")
    if not isinstance(text, str):
        raise DraftError("text must be a string")
    if len(text) > MAX_DRAFT_TEXT_CHARS:
        raise DraftError(f"text is {len(text)} characters; the limit is {MAX_DRAFT_TEXT_CHARS}")
    if not isinstance(choices, list) or not all(isinstance(c, str) for c in choices):
        raise DraftError("choices must be a list of strings")
    offered = [_bare(c) for c in (question.get("choices") or [])]
    picked: list[str] = []
    for choice in choices:
        bare = _bare(choice)
        if bare not in offered:
            raise DraftError("choices must be labels the question offered")
        if bare not in picked:
            picked.append(bare)
    if len(picked) > 1 and not question.get("multi_select"):
        raise DraftError("a single-select question takes at most one choice")
    return {"choices": picked, "text": text, "revision": revision}


def is_blank(draft: dict | None) -> bool:
    """A cleared draft (nothing picked, nothing typed): kept for its revision, never reported."""
    return not draft or (not draft.get("choices") and not str(draft.get("text") or "").strip())


def valid_revision(revision) -> bool:
    return isinstance(revision, int) and not isinstance(revision, bool) and 0 < revision <= MAX_REVISION


def unfinished(drafts: dict, settled_answers: Collection[str]) -> dict:
    """The drafts still worth reporting: non-blank and for a question no lock / skip / answer settled, each
    with the revision it was saved at (a client reconciles its own copy against it)."""
    return {qid: {"choices": list(d["choices"]), "text": d["text"],
                  **({"revision": d["revision"]} if valid_revision(d.get("revision")) else {})}
            for qid, d in drafts.items() if qid not in settled_answers and not is_blank(d)}


def model_view(normalized: list[dict], drafts: dict) -> list[dict]:
    """The model-facing draft list, in question order, beside (never inside) ``responses``. ``revision``
    rides only when the payload carried a valid one: an old payload's version is unknown, never invented."""
    out = []
    for index, entry in enumerate(normalized):
        draft = drafts.get(entry["qid"]) if isinstance(drafts, dict) else None
        if not isinstance(draft, dict) or is_blank(draft):
            continue
        row = {"question_index": index, "question_id": entry["qid"], "question": entry["question"],
               "selected_choices": [str(c) for c in draft.get("choices") or []],
               "typed_text": str(draft.get("text") or "")}
        if valid_revision(draft.get("revision")):
            row["revision"] = draft["revision"]
        out.append(row)
    return out


def valid_request_id(request_id) -> bool:
    return isinstance(request_id, str) and bool(_REQUEST_ID.match(request_id))


def _session_dir(home: Path, gateway: str, session_key: str) -> Path:
    digest = hashlib.sha256(session_key.encode("utf-8")).hexdigest()[:32]
    return home / STORE_DIRNAME / gateway / digest


@dataclass(frozen=True)
class DraftScope:
    """Where one gateway keeps one session's drafts: profile home + gateway kind + stored session id.
    Request ids are random per request, so two requests (even two asking ``q0``) never share a file."""

    home: Path
    gateway: str
    session_key: str

    def __post_init__(self):
        if self.gateway not in GATEWAYS:
            raise ValueError(f"unknown clarify draft gateway {self.gateway!r}")
        if not isinstance(self.session_key, str) or not self.session_key:
            raise ValueError("a clarify draft scope needs the stored session id")

    @property
    def directory(self) -> Path:
        return _session_dir(Path(self.home), self.gateway, self.session_key)

    def path(self, request_id: str) -> Path:
        if not valid_request_id(request_id):
            raise ValueError("invalid clarify request id")
        return self.directory / f"{request_id}.json"


def _lock_for(path: Path) -> threading.Lock:
    return _FILE_LOCKS[int(hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:8], 16) % len(_FILE_LOCKS)]


def _fsync_dir(directory: Path) -> None:
    if os.name == "nt":
        return  # a directory cannot be opened for fsync on Windows; os.replace is already atomic there
    fd = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, payload: dict) -> None:
    # A save that outlives its profile must fail (``FileNotFoundError``: not durable), never resurrect
    # the deleted home; ``make_user_dir`` keeps a directory an ELEVATED Windows process creates usable
    # by the same user unelevated (a plain ``mkdir(mode=0o700)`` strands it, ``hermes_dir_acl``).
    from hermes_constants import assert_named_profile_home_live
    assert_named_profile_home_live(path.parent)
    make_user_dir(path.parent, mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".draft-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        # Windows refuses a rename onto a file another handle (a concurrent recall read) holds open.
        atomic_replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(path.parent)


def _str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_question(q) -> bool:
    return (isinstance(q, dict) and isinstance(q.get("qid"), str) and isinstance(q.get("question"), str)
            and (q.get("choices") is None or _str_list(q.get("choices")))
            and (q.get("multi_select") is None or isinstance(q.get("multi_select"), bool)))


def _valid_draft(d) -> bool:
    revision = d.get("revision") if isinstance(d, dict) else None
    return (isinstance(d, dict) and _str_list(d.get("choices")) and isinstance(d.get("text"), str)
            and isinstance(revision, int) and not isinstance(revision, bool) and revision > 0)


def _valid_record(payload) -> bool:
    """The exact shape :func:`persist` writes; anything else is refused, never half-read."""
    if not isinstance(payload, dict) or payload.get("version") != SCHEMA_VERSION:
        return False
    header_ok = (payload.get("gateway") in GATEWAYS and isinstance(payload.get("session_key"), str)
                 and valid_request_id(payload.get("request_id"))
                 and _number(payload.get("created_at")) and _number(payload.get("updated_at"))
                 and (payload.get("outcome") is None or isinstance(payload.get("outcome"), str)))
    questions, drafts = payload.get("questions"), payload.get("drafts")
    if not header_ok or not isinstance(questions, list) or not isinstance(drafts, dict):
        return False
    if not all(_valid_question(q) for q in questions):
        return False
    qids = {q["qid"] for q in questions}
    return all(qid in qids and _valid_draft(d) for qid, d in drafts.items())


def _read(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        payload = None
    if not _valid_record(payload):
        # Left in place (evidence for repair), never read as drafts.
        logger.warning("ignoring malformed clarify draft record %s", path)
        return None
    return payload


def _belongs(record: dict, scope: DraftScope, request_id: str) -> bool:
    return (record.get("gateway") == scope.gateway and record.get("session_key") == scope.session_key
            and record.get("request_id") == request_id)


def persist(scope: DraftScope, request_id: str, questions: list[dict], drafts: dict, *,
            outcome: str | None = None) -> None:
    """Write the request's current drafts. A request whose every draft is blank is removed: there is
    nothing left to recover. Raises ``OSError`` when the disk refuses."""
    path = scope.path(request_id)
    with _lock_for(path):
        live = {qid: d for qid, d in drafts.items() if not is_blank(d)}
        if not live:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            return
        existing = _read(path) if path.exists() else None
        now = time.time()
        _atomic_write(path, {
            "version": SCHEMA_VERSION, "gateway": scope.gateway, "session_key": scope.session_key,
            "request_id": request_id,
            "created_at": (existing or {}).get("created_at", now), "updated_at": now,
            "questions": [{"qid": str(q.get("qid")), "question": str(q.get("question")),
                           "choices": list(q["choices"]) if q.get("choices") else None,
                           "multi_select": bool(q.get("multi_select"))} for q in questions],
            "drafts": {qid: {"choices": list(d["choices"]), "text": d["text"], "revision": int(d["revision"])}
                       for qid, d in live.items()},
            "outcome": outcome,
        })


def load(scope: DraftScope, request_id: str) -> dict | None:
    """One request's record, or None (missing, malformed, or not this scope's)."""
    record = _read(scope.path(request_id))
    return record if record is not None and _belongs(record, scope, request_id) else None


def public_record(record: dict) -> dict:
    """A stored record as the read verb returns it."""
    return {"request_id": record["request_id"], "created_at": float(record["created_at"]),
            "updated_at": float(record["updated_at"]), "outcome": record.get("outcome"),
            "questions": list(record["questions"]),
            "drafts": {qid: {"choices": list(d["choices"]), "text": d["text"], "revision": d["revision"]}
                       for qid, d in record["drafts"].items() if not is_blank(d)}}


def list_records(scope: DraftScope, request_id: str | None = None) -> list[dict]:
    """This scope's recoverable records, newest first (or just *request_id*'s)."""
    if request_id is not None:
        record = load(scope, request_id)
        return [public_record(record)] if record else []
    try:
        names = [p.name[:-5] for p in scope.directory.glob("srq-*.json")]
    except OSError:
        return []
    records = [r for r in (load(scope, name) for name in names if valid_request_id(name)) if r]
    records.sort(key=lambda r: float(r["updated_at"]), reverse=True)
    return [public_record(r) for r in records[:MAX_LISTED_RECORDS]]


def discard(scope: DraftScope, request_id: str) -> bool:
    """Explicitly drop one request's drafts. True when a record was removed."""
    path = scope.path(request_id)
    with _lock_for(path):
        if load(scope, request_id) is None:
            return False
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        return True


def purge_session(home: Path, session_key: str) -> int:
    """Remove every gateway's drafts of one deleted session in *home*. Returns the files removed."""
    removed = 0
    for gateway in sorted(GATEWAYS):
        directory = _session_dir(Path(home), gateway, session_key)
        if not directory.is_dir():
            continue
        for path in directory.glob("*.json"):
            with _lock_for(path):
                try:
                    path.unlink()
                    removed += 1
                except FileNotFoundError:
                    pass
        try:
            directory.rmdir()
        except OSError:
            pass
    return removed


class DraftBook:
    """One open batch request's drafts: the single implementation of save, supersede, discard, settle
    and replay for both registries. The registry supplies entitlement and openness; the book guarantees
    no write follows settlement or discard, and a lock or skip always beats a draft."""

    def __init__(self, request_id: str, questions: list[dict], scope: DraftScope | None):
        self.request_id = request_id
        self.questions = [dict(q) for q in questions]
        self.scope = scope
        self._lock = threading.Lock()
        self._drafts: dict[str, dict] = {}
        self._closed = False
        self._discarded = False
        # qid → the revision the store last confirmed on disk. In-memory state can be newer; this never is.
        self._persisted: dict[str, int] = {}

    def _question(self, question_id: str) -> dict:
        question = next((q for q in self.questions if q.get("qid") == question_id), None)
        if question is None:
            raise ValueError(f"unknown question_id {question_id!r}")
        return question

    def _persist(self, outcome: str | None = None) -> bool:
        if self.scope is None:
            return False
        try:
            persist(self.scope, self.request_id, self.questions, self._drafts, outcome=outcome)
        except OSError:
            logger.warning("clarify drafts for %s could not be saved to disk", self.request_id, exc_info=True)
            return False
        self._persisted = {qid: d["revision"] for qid, d in self._drafts.items()}
        return True

    def _on_disk(self, question_id: str) -> bool:
        current = self._drafts.get(question_id)
        return current is not None and self._persisted.get(question_id) == current["revision"]

    def save(self, question_id: str, choices, text, revision, *, locked: Callable[[], Collection[str]],
             is_open: Callable[[], bool]) -> dict:
        """``ok`` (with ``durable``: on disk, survives a restart), ``stale`` (a newer or equal revision is
        held; ``durable`` says whether THAT held revision is on disk, never inferred from staleness), ``locked``
        (the question is answered or skipped), ``discarded`` or ``expired``."""
        draft = normalize_draft(self._question(question_id), choices, text, revision)
        with self._lock:
            if self._closed or not is_open():
                return {"status": "expired"}
            if self._discarded:
                return {"status": "discarded"}
            if question_id in locked():
                return {"status": "locked"}
            current = self._drafts.get(question_id)
            if current is not None and current["revision"] >= draft["revision"]:
                return {"status": "stale", "revision": current["revision"], "durable": self._on_disk(question_id)}
            self._drafts[question_id] = draft
            return {"status": "ok", "revision": draft["revision"], "durable": self._persist()}

    def supersede(self, question_id: str) -> None:
        """A lock (or skip) is the answer: its question's draft stops counting, in memory and on disk."""
        with self._lock:
            if self._drafts.pop(question_id, None) is not None and not self._closed:
                self._persist()

    def discard(self) -> None:
        """The user dropped these drafts: forget them and refuse any later (in-flight) save."""
        with self._lock:
            self._discarded = True
            self._drafts.clear()
            if self.scope is not None:
                discard(self.scope, self.request_id)

    def snapshot(self, locked: Collection[str]) -> dict:
        """Reconnect replay: unfinished drafts with their revisions, never merged into answers."""
        with self._lock:
            return unfinished(self._drafts, locked)

    def settle(self, answers: Collection[str], outcome: str | None) -> dict:
        """Close the book as the request ends; the result fields to add: ``drafts`` (questions no answer
        or skip settled, each with its revision), ``drafts_request_id`` and ``drafts_durable`` (every
        reported revision is the one on disk). ``{}`` when nothing is left."""
        with self._lock:
            self._closed = True
            for qid in [qid for qid in self._drafts if qid in answers]:
                del self._drafts[qid]
            pending = unfinished(self._drafts, answers)
            if self.scope is not None and not self._discarded:
                self._persist(outcome)
            if not pending:
                return {}
            return {"drafts": pending, "drafts_request_id": self.request_id,
                    "drafts_durable": all(self._on_disk(qid) for qid in pending)}
