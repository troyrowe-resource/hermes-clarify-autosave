"""The TUI/desktop clarify bridge tells ``server_requests.send`` where the request's unsent drafts persist:
the session's profile home and STORED session id (the runtime id is re-minted on resume, so drafts keyed on
it would be orphaned). A session without a live record forwards no scope: its drafts stay with the request.
See tui_gateway.server._clarify_block and methods_prompt._clarify_draft_scope."""

from pathlib import Path

import pytest

from tools.clarify_drafts import DraftScope
from tui_gateway import server, server_requests

QUESTIONS = [{"qid": "q0", "question": "Pick one", "choices": ["a", "b"], "multi_select": False}]


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake_send(method, sid, params, *, timeout, qids=None, draft_scope=None):
        calls.append(draft_scope)
        return {"answers": {"q0": "a"}, "outcome": "submitted"}

    monkeypatch.setattr(server_requests, "send", fake_send)
    return calls


def test_live_session_drafts_persist_under_its_profile_home_and_stored_id(monkeypatch, tmp_path, sent):
    monkeypatch.setitem(server._sessions, "runtime-7", {"session_key": "stored-1", "profile_home": str(tmp_path)})

    server._agent_cbs("runtime-7")["clarify_callback"](QUESTIONS)

    assert sent == [DraftScope(Path(tmp_path), "tui_gateway", "stored-1")]


def test_session_without_a_live_record_forwards_no_draft_scope(monkeypatch, sent):
    monkeypatch.delitem(server._sessions, "gone-1", raising=False)

    server._agent_cbs("gone-1")["clarify_callback"](QUESTIONS)

    assert sent == [None]
