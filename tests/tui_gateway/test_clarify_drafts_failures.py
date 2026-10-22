"""The TUI/Desktop sidecar's draft verbs under failure: a refused disk, damaged and foreign records, no stored session.

The same contract the session owner is held to (``tests/gateway/test_clarify_drafts_owner_failures.py``), through the
real server module: a draft the disk refused is reported ``durable: false`` on the wire and in the model-facing result,
recall never turns an unreadable or somebody else's record into one of this session's drafts, and a session with no
stored id has no scope at all, so nothing is ever written anywhere.
"""
import json
import threading
from types import SimpleNamespace

import pytest

from tests.waiting import wait_until
from tools import clarify_drafts as store
from tools.clarify_tool import _normalize_questions, _result
from tui_gateway import server, server_requests
from tui_gateway.transport import bind_transport, reset_transport

SID = 'sidecar-failures'
KEY = 'stored-1'


class _Peer:
    """A client connection attached to the live session."""

    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


def _call(peer, method, params):
    token = bind_transport(peer)
    try:
        return server.handle_request({'id': 't', 'method': method, 'params': params})
    finally:
        reset_transport(token)


def _questions():
    normalized, error = _normalize_questions([{'question': 'Open with?'},
                                              {'question': 'Which exhibitors?', 'choices': ['Acme', 'Bolt', 'Cobalt'],
                                               'multi_select': True}])
    assert error is None
    return normalized


@pytest.fixture()
def sidecar(monkeypatch, tmp_path):
    peer = _Peer()
    server._sessions[SID] = {'session_key': KEY, 'transport': peer, 'history': [], 'history_lock': threading.Lock(),
                             'agent_ready': None, 'profile_home': str(tmp_path)}
    server_requests.reset_for_tests()
    monkeypatch.setattr(server_requests, '_write', peer.write)
    monkeypatch.setattr(server_requests, '_emit', lambda *a: None)
    monkeypatch.setattr(server_requests, '_answerable', lambda sid: True)
    yield SimpleNamespace(peer=peer, home=tmp_path, scope=store.DraftScope(tmp_path, 'tui_gateway', KEY))
    server._sessions.pop(SID, None)
    server_requests.reset_for_tests()


def _ask(monkeypatch, *, timeout=1):
    """The model's batch clarify, asked on a worker thread through the real ``_clarify_block``."""
    monkeypatch.setattr(server, '_clarify_timeout_seconds', lambda: timeout)
    out = {}
    questions = _questions()
    worker = threading.Thread(target=lambda: out.update(result=server._clarify_block(SID, questions)), daemon=True)
    worker.start()
    request = wait_until(lambda: next((r for r in list(server_requests._open.values()) if r.sid == SID), None),
                         what='the open clarify request')
    return worker, out, request.id, questions


def _draft(sidecar, rid, qid, *, text='', choices=(), revision=1):
    return _call(sidecar.peer, 'clarify.draft', {'session_id': SID, 'request_id': rid, 'question_id': qid,
                                                 'choices': list(choices), 'text': text, 'revision': revision})


def test_the_sidecar_scope_is_the_sessions_profile_home_the_tui_gateway_and_the_stored_session_key(sidecar, tmp_path):
    assert server._clarify_draft_scope(SID) == sidecar.scope
    other = tmp_path / 'another-profile'
    server._sessions['rt-2'] = {'session_key': 'stored-2', 'profile_home': str(other)}
    server._sessions['rt-3'] = {'session_key': '', 'profile_home': str(tmp_path)}
    try:
        assert server._clarify_draft_scope('rt-2') == store.DraftScope(other, 'tui_gateway', 'stored-2')
        assert server._clarify_draft_scope('rt-3') is None, 'no stored session id: no scope, nothing is written anywhere'
        assert server._clarify_draft_scope('no-such-session') is None
    finally:
        server._sessions.pop('rt-2', None)
        server._sessions.pop('rt-3', None)


def test_a_refused_disk_is_durable_false_on_the_wire_and_in_the_model_result(sidecar, monkeypatch):
    (sidecar.home / store.STORE_DIRNAME).write_text('a file where the drafts directory belongs', encoding='utf-8')
    worker, out, rid, questions = _ask(monkeypatch)
    assert _draft(sidecar, rid, 'q0', text='typed')['result'] == {'status': 'ok', 'revision': 1, 'durable': False}
    assert _draft(sidecar, rid, 'q1', choices=['Acme', 'Cobalt'])['result'] == {
        'status': 'ok', 'revision': 1, 'durable': False}
    assert _draft(sidecar, rid, 'q0', text='typed')['result'] == {'status': 'stale', 'revision': 1, 'durable': False}
    recalled = _call(sidecar.peer, 'clarify.drafts', {'session_id': SID})
    assert recalled['result'] == {'drafts': []}, 'recall on a store that cannot be read answers empty, never an error'
    worker.join(10)
    assert not worker.is_alive()

    result = out['result']
    assert result['answers'] == {} and result['outcome'] == 'timed_out'
    assert result['drafts'] == {'q0': {'choices': [], 'text': 'typed', 'revision': 1},
                                'q1': {'choices': ['Acme', 'Cobalt'], 'text': '', 'revision': 1}}, 'the held copy is kept'
    assert result['drafts_durable'] is False and result['drafts_request_id'] == rid
    view = json.loads(_result(questions, result))
    assert view['drafts_durable'] is False and view['drafts_submitted'] is False
    assert [r['status'] for r in view['responses']] == ['unanswered', 'unanswered']


def test_a_draft_with_an_unpaired_surrogate_is_invalid_params_and_never_costs_the_wait_its_drafts(sidecar, monkeypatch):
    """The sidecar's dispatcher checks only unknown keys (``validate_params``), so the value check is the book's: a JSON
    ``"\\ud800"`` from a JS string is refused whole (4002), nothing is held, and the real ``_clarify_block`` wait still
    ends with its result and the drafts it does hold (it used to die at the settlement, losing the model's result)."""
    worker, out, rid, questions = _ask(monkeypatch)
    assert _draft(sidecar, rid, 'q0', text='kept')['result'] == {'status': 'ok', 'revision': 1, 'durable': True}
    for revision, text in ((2, json.loads('"\\ud800"')), (3, 'half a pair \ud83d')):
        refused = _draft(sidecar, rid, 'q1', text=text, revision=revision)
        assert refused['error']['code'] == 4002, refused
    recalled = _call(sidecar.peer, 'clarify.drafts', {'session_id': SID})['result']['drafts']
    assert [r['drafts'] for r in recalled] == [{'q0': {'choices': [], 'text': 'kept', 'revision': 1}}]
    worker.join(10)
    assert not worker.is_alive()

    result = out['result']
    assert result['answers'] == {} and result['outcome'] == 'timed_out', 'the wait still ended with its result'
    assert result['drafts'] == {'q0': {'choices': [], 'text': 'kept', 'revision': 1}} and result['drafts_durable'] is True
    view = json.loads(_result(questions, result))
    assert [d['typed_text'] for d in view['drafts']] == ['kept'] and view['drafts_submitted'] is False


def test_damaged_and_foreign_records_never_reach_recall_and_never_break_it(sidecar, tmp_path):
    typed = {'q0': {'choices': [], 'text': 'mine', 'revision': 1}}
    questions = _questions()
    store.persist(sidecar.scope, 'srq-aaaaaaaaaaaa', questions, typed)  # this session's own record
    damaged = {'srq-bbbbbbbbbbbb': '{not json', 'srq-cccccccccccc': '[]', 'srq-dddddddddddd': ''}
    for request_id, raw in damaged.items():
        sidecar.scope.path(request_id).write_text(raw, encoding='utf-8')
    other_home = tmp_path / 'another-profile'
    other_home.mkdir()
    foreign = {'srq-eeeeeeeeeeee': store.DraftScope(sidecar.home, 'session_owner', KEY),  # the other gateway
               'srq-ffffffffffff': store.DraftScope(sidecar.home, 'tui_gateway', 'stored-2'),  # another session
               'srq-111111111111': store.DraftScope(other_home, 'tui_gateway', KEY)}  # another profile's home
    for request_id, scope in foreign.items():
        store.persist(scope, request_id, questions, {'q0': {'choices': [], 'text': 'not mine', 'revision': 1}})

    listed = _call(sidecar.peer, 'clarify.drafts', {'session_id': SID})['result']['drafts']
    assert [r['request_id'] for r in listed] == ['srq-aaaaaaaaaaaa'] and listed[0]['drafts'] == typed
    for request_id in (*damaged, *foreign):
        by_id = _call(sidecar.peer, 'clarify.drafts', {'session_id': SID, 'request_id': request_id})
        assert by_id['result'] == {'drafts': []}, (request_id, by_id)
        discarded = _call(sidecar.peer, 'clarify.drafts.discard', {'session_id': SID, 'request_id': request_id})
        assert discarded['result'] == {'status': 'missing'}, (request_id, discarded)
    assert all(scope.path(request_id).exists() for request_id, scope in foreign.items()), 'foreign records stay'
    assert all(sidecar.scope.path(request_id).exists() for request_id in damaged), 'damaged files stay as evidence'
    again = _call(sidecar.peer, 'clarify.drafts', {'session_id': SID})['result']['drafts']
    assert [r['request_id'] for r in again] == ['srq-aaaaaaaaaaaa']
