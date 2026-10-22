"""Deleting a chat (``session.delete``) deletes its saved, unsent clarify drafts, for every gateway that
kept them in that profile home, and nothing else's. A refused or missed delete keeps them: drafts are
recoverable until explicitly discarded or their conversation is deleted, never expired by a timer."""

from pathlib import Path

from tui_gateway import server


class _DB:
    def __init__(self, found=True):
        self.found = found

    def get_session_model_config_value(self, *_args):
        return None

    def resolve_resume_session_id(self, *_args):
        return None

    def delete_session(self, sid, sessions_dir=None, **_kw):
        return self.found


def _seed(home: Path, session_key: str, request_id: str, gateway: str) -> Path:
    from tools.clarify_drafts import DraftScope, list_records, persist
    scope = DraftScope(home, gateway, session_key)
    persist(scope, request_id, [{"qid": "q0", "question": "Q?", "choices": None, "multi_select": False}],
            {"q0": {"choices": [], "text": f"draft of {session_key}", "revision": 1}}, outcome="timed_out")
    assert list_records(scope)
    return scope.path(request_id)


def _delete(monkeypatch, session_id, found=True):
    monkeypatch.setattr(server, "_get_db", lambda: _DB(found))
    return server.handle_request({"id": "1", "method": "session.delete", "params": {"session_id": session_id}})


def test_deleting_a_session_purges_its_drafts_from_every_gateway_and_no_other(monkeypatch):
    home = Path(server.get_hermes_home())
    sidecar = _seed(home, "doomed", "srq-aaaaaaaaaaaa", "tui_gateway")
    owner = _seed(home, "doomed", "srq-bbbbbbbbbbbb", "session_owner")
    other = _seed(home, "kept", "srq-cccccccccccc", "tui_gateway")
    assert _delete(monkeypatch, "doomed")["result"] == {"deleted": "doomed"}
    assert not sidecar.exists() and not owner.exists()
    assert other.exists()


def test_a_delete_that_found_nothing_or_was_refused_keeps_the_drafts(monkeypatch):
    home = Path(server.get_hermes_home())
    kept = _seed(home, "ghost", "srq-dddddddddddd", "tui_gateway")
    assert _delete(monkeypatch, "ghost", found=False)["error"]["code"] == 4007
    monkeypatch.setitem(server._sessions, "live", {"session_key": "ghost"})
    assert _delete(monkeypatch, "ghost")["error"]["code"] == 4023
    assert kept.exists()
