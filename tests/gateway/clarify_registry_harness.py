"""One open batch ``clarify`` request on a REAL registry, driven through the same verbs whichever registry holds it.

The TUI/Desktop sidecar (``tui_gateway/server_requests.py``) and the session owner (``gateway/session_server_requests.py``)
each keep batch requests, and both keep one ``tools.clarify_drafts.DraftBook`` per request. A test written against
:class:`OpenBatch` states an invariant once and is run against both (``@pytest.fixture(params=KINDS)``), so a draft
means exactly the same thing on every surface. The request is asked on a worker thread, exactly where a model's tool call
asks it; everything between (registry, book, disk store) is production code.
"""
import json
import threading

from tests.waiting import wait_until
from tools.clarify_tool import _normalize_questions, _result

KINDS = ['sidecar', 'owner']
SESSION = 's1'
QUESTIONS = [{'qid': 'q0', 'question': 'colour?', 'choices': ['red', 'blue'], 'multi_select': False},
             {'qid': 'q1', 'question': 'size?', 'choices': None, 'multi_select': False}]


class _Peer:
    def __init__(self):
        self.frames = []

    def write(self, frame):
        self.frames.append(frame)
        return True

    def close(self):
        pass


class OpenBatch:
    def __init__(self, kind, monkeypatch, scope=None, *, timeout=30, questions=QUESTIONS):
        self.kind, self.out, self.interrupted = kind, {}, threading.Event()
        qids = [question['qid'] for question in questions]
        if kind == 'sidecar':
            from tui_gateway import server_requests as reg
            self.frames = []
            monkeypatch.setattr(reg, '_write', self.frames.append)
            monkeypatch.setattr(reg, '_emit', lambda *a: None)
            monkeypatch.setattr(reg, '_answerable', lambda sid: True)
            reg.reset_for_tests()

            def ask():
                return reg.send('clarify', SESSION, {'questions': questions}, timeout=timeout, qids=qids,
                                draft_scope=scope)
        else:
            from gateway import session_server_requests as reg
            from gateway.session_events import SessionEvents
            events, peer = SessionEvents(), _Peer()
            events.fanout.attach(peer)
            self.frames = peer.frames

            def ask():
                return reg.ask_viewer_result(events, SESSION, 'clarify', {'questions': questions}, timeout=timeout,
                                             cancelled=self.interrupted.is_set, qids=qids, draft_scope=scope)
        self.reg = reg
        self.worker = threading.Thread(target=lambda: self.out.update(result=ask()), daemon=True)
        self.worker.start()
        wait_until(lambda: any(f.get('method') == 'clarify' for f in self.frames), what='the clarify request frame')
        self.rid = next(f['id'] for f in self.frames if f.get('method') == 'clarify')

    @property
    def is_open(self):
        return self.rid in self.reg._open

    def save(self, qid, text='', revision=1, choices=()):
        """The registry's own answer: a status dict, or None when no open request of this id takes it (the RPC layers
        both turn None into ``{'status': 'expired'}``)."""
        if self.kind == 'sidecar':
            return self.reg.save_draft(self.rid, SESSION, qid, list(choices), text, revision)
        return self.reg.save_draft(self.rid, qid, list(choices), text, revision, session_ok=lambda *a: True)

    def lock(self, qid, answer):
        if self.kind == 'sidecar':
            return self.reg.lock_answer(self.rid, qid, answer)
        return self.reg.lock_answer(self.rid, qid, answer, session_ok=lambda *a: True)

    def discard(self):
        if self.kind == 'sidecar':
            return self.reg.discard_open_drafts(self.rid, SESSION)
        return self.reg.discard_open_drafts(self.rid, session_ok=lambda *a: True)

    def interrupt(self):
        if self.kind == 'sidecar':
            return self.reg.cancel(SESSION, 'interrupted')
        self.interrupted.set()  # the owner's wait polls it, as it polls the agent's interrupt flag

    def finish(self):
        """The result the asking side got once the request ended, whichever way it ended."""
        self.worker.join(10)
        assert not self.worker.is_alive(), 'the request never ended'
        return self.out['result']

    def close_with(self, result):
        """The client's closing response frame (Confirm's tail, a cancel-all ``{}``); returns the settled result."""
        frame = {'jsonrpc': '2.0', 'id': self.rid, 'result': result}
        assert self.reg.resolve_response(frame) if self.kind == 'sidecar' else self.reg.resolve(frame)
        return self.finish()

    def cleanup(self):
        if self.kind == 'sidecar':
            self.reg.reset_for_tests()


def model_view(result):
    """What the model reads: the tool JSON for these two questions given the registry's settled *result*."""
    normalized, error = _normalize_questions([{'question': 'colour?', 'choices': ['red', 'blue']}, {'question': 'size?'}])
    assert error is None
    return json.loads(_result(normalized, result))
