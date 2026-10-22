"""A REAL compute-host child whose only fake is the agent (no model, no credentials).

Run as a script by ``test_compute_host_clarify_drafts_process.py`` through a real ``HostSupervisor``. It runs the
production ``tui_gateway.compute_host.run_host`` loop (stdio JSON frames, host transport, ppid guard) over a session
whose "agent" asks one batch ``clarify`` through the real clarify tool and ``server._clarify_block``, exactly where a
model's tool call would. Everything between is production code: the turn frame handler, the server-request registry
and its draft book, the disk store under the ``DraftScope`` the child itself computes from the session it was handed.

Environment: ``CLARIFY_CHILD_OUT`` (a directory), where the child writes ``<sid>.json`` (the tool result the model
would read) when a wait ends; an optional ``clarify-timeout`` file there holds the next waits' timeout in seconds
(absent: wait until answered or cancelled).
"""
import os
import threading
import types
from pathlib import Path

from tui_gateway import compute_host, server

OUT = Path(os.environ["CLARIFY_CHILD_OUT"])
QUESTIONS = [{"question": "Open with?"},
             {"question": "Which exhibitors?", "choices": ["Acme", "Bolt"], "multi_select": True}]


def _agent(sid: str, key: str):
    def run_conversation(prompt, *, conversation_history=None, stream_callback=None, **_kw):
        from tools.clarify_tool import clarify_tool
        result = clarify_tool(QUESTIONS, callback=lambda questions: server._clarify_block(sid, questions))
        (OUT / f"{sid}.json").write_text(result, encoding="utf-8")
        messages = [*(conversation_history or []), {"role": "user", "content": prompt},
                    {"role": "assistant", "content": "done"}]
        return {"final_response": "done", "messages": messages}

    return types.SimpleNamespace(session_id=key, run_conversation=run_conversation, clear_interrupt=lambda: None,
                                 hard_interrupt=lambda *a, **k: None)


def _build_session(self, srv, frame, sid):
    """What the production builder derives from the parent's turn frame, minus the real agent."""
    key = str(frame.get("session_key") or sid)
    session = {
        "agent": _agent(sid, key), "session_key": key, "history": list(frame.get("history") or []),
        "history_lock": threading.Lock(), "history_version": int(frame.get("history_version") or 0),
        "running": False, "attached_images": [], "image_counter": 0, "cols": 80, "slash_worker": None,
        "show_reasoning": False, "tool_progress_mode": "all", "inflight_turn": None,
        "active_session_lease": object(), "profile_home": str(frame.get("profile_home") or ""),
        "transport": self._transport}
    srv._sessions[sid] = session
    return session


def _clarify_timeout():
    path = OUT / "clarify-timeout"
    return float(path.read_text()) if path.exists() else None


compute_host.ComputeHost._build_server_session = _build_session
# The turn pipeline's environment-heavy side paths (the same set tests/tui_gateway/test_compute_host_turn_protocol.py
# neutralizes); the threads stay real.
server._wire_callbacks = lambda sid: None
server._sync_agent_model_with_config = lambda sid, session: None
server._session_cwd = lambda session: str(OUT)
server._register_session_cwd = lambda session: None
server._tts_stream_begin = lambda: None
server._sync_session_key_after_compress = lambda *a, **k: None
server._get_usage = lambda agent: {}
server._clarify_timeout_seconds = _clarify_timeout

if __name__ == "__main__":
    compute_host.run_host()
