"""Unsent clarify drafts on the session OWNER (canonical gateway): ``clarify.draft`` / ``clarify.drafts`` /
``clarify.drafts.discard``, driven through the real ``AuthorityConnection`` dispatcher against a real
``ask_clarify_batch`` wait.

Regression: the owner's batch request (Desktop / CLI viewers of a canonical gateway) had no draft verb, so
typed text and staged picks on a card that timed out never reached the backend at all and the model saw
every question ``unanswered``. A draft never settles anything, a lock or skip supersedes it, and it is
recoverable after the request ends, only by a viewer attached to that session with ``session:respond``.
"""
import asyncio
import itertools
import json
import threading
from types import SimpleNamespace

import pytest

from gateway.config import Platform
from tests.gateway.test_surface_admission import _authority

def _questions():
    from tools.clarify_tool import _normalize_questions
    normalized, error = _normalize_questions([
        {'question': '6. Opening line?'},
        {'question': '7. Exhibitors?', 'choices': ['Acme', 'Bolt', 'Cobalt'], 'multi_select': True},
        {'question': '8. Format?', 'choices': ['Panel', 'Fireside']}])
    assert error is None
    return normalized


QUESTIONS = _questions()


class _Peer:
    def __init__(self):
        self.frames = []

    def write(self, frame):
        self.frames.append(frame)
        return True

    def close(self):
        pass


async def _wait_for(predicate, timeout=5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline
        await asyncio.sleep(0.01)


def _start_batch(authority, monkeypatch, *, timeout=60, interrupted=None):
    from gateway.session_clarify_batch import ask_clarify_batch
    monkeypatch.setattr('tools.clarify_gateway.get_clarify_timeout', lambda: timeout)
    peer = _Peer()
    authority.sessions['s'].event_stream.fanout.attach(peer)
    agent = interrupted if interrupted is not None else SimpleNamespace(_interrupt_requested=False)
    turn = SimpleNamespace(_approval_owner=(authority, 's', 1), _ctx=SimpleNamespace(
        source=SimpleNamespace(platform=Platform.LOCAL), agent_holder=[agent]))
    out = {}
    worker = threading.Thread(target=lambda: out.update(ask_clarify_batch(turn, QUESTIONS)), daemon=True)
    worker.start()
    return peer, worker, out


async def _rid(peer):
    await _wait_for(lambda: any(f.get('method') == 'clarify' for f in peer.frames))
    return next(f['id'] for f in peer.frames if f.get('method') == 'clarify')


_ids = itertools.count(100)


async def _rpc(connection, method, params):
    return await connection.dispatch({'id': next(_ids), 'method': method, 'params': params})


async def _draft(connection, rid, qid, *, choices=(), text='', revision, session_id='s', **extra):
    return await _rpc(connection, 'clarify.draft', {'session_id': session_id, 'request_id': rid, 'question_id': qid,
                                                    'choices': list(choices), 'text': text, 'revision': revision,
                                                    **extra})


async def _owner(tmp_path, monkeypatch, user='owner', own_home=False):
    from gateway.session_controls import AuthorityConnection

    async def answer(event):
        return 'ok'
    authority = await _authority(tmp_path, monkeypatch, answer)
    if own_home:  # a multiplexed profile: its id is its own home
        authority.profile_id = str(tmp_path)
    connection = AuthorityConnection(authority, object(), {'user_id': user})
    resumed = await connection.dispatch({'id': 1, 'method': 'session.resume', 'params': {'session_id': 's'}})
    assert 'result' in resumed, resumed
    return authority, connection


@pytest.mark.asyncio
async def test_owner_timeout_returns_drafts_separately_and_never_as_answers(tmp_path, monkeypatch):
    from tools.clarify_tool import _result
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=2)
        rid = await _rid(peer)
        typed = await _draft(connection, rid, 'q0', text='Open with the\nrecycling stats ✓', revision=1)
        assert typed.get('result') == {'status': 'ok', 'revision': 1, 'durable': True}, typed
        picked = await _draft(connection, rid, 'q1', choices=['Acme', 'Cobalt'], text='plus Delta', revision=1)
        assert picked['result']['status'] == 'ok'
        await asyncio.to_thread(worker.join, 10)
    finally:
        await connection.close()
    assert out['answers'] == {} and out['outcome'] == 'timed_out'
    assert out['drafts'] == {'q0': {'choices': [], 'text': 'Open with the\nrecycling stats ✓', 'revision': 1},
                             'q1': {'choices': ['Acme', 'Cobalt'], 'text': 'plus Delta', 'revision': 1}}
    assert out['drafts_durable'] is True
    assert out['drafts_request_id'] == rid
    result = json.loads(_result(QUESTIONS, out))
    assert [r['status'] for r in result['responses']] == ['unanswered'] * 3
    assert all(r['user_response'] is None for r in result['responses'])
    assert result['drafts_submitted'] is False
    assert [d['question_index'] for d in result['drafts']] == [0, 1]


async def _lock(connection, rid, qid, answer):
    return await _rpc(connection, 'clarify.lock', {'request_id': rid, 'question_id': qid, 'answer': answer})


@pytest.mark.asyncio
async def test_owner_lock_and_skip_supersede_drafts_and_late_or_stale_writes_lose(tmp_path, monkeypatch):
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch)
        rid = await _rid(peer)
        assert (await _draft(connection, rid, 'q0', text='newest', revision=20))['result']['status'] == 'ok'
        assert (await _draft(connection, rid, 'q0', text='older', revision=19))['result'] == {
            'status': 'stale', 'revision': 20, 'durable': True}
        await _draft(connection, rid, 'q2', choices=['Panel'], revision=1)
        await _draft(connection, rid, 'q1', choices=['Bolt'], revision=1)
        assert (await _lock(connection, rid, 'q0', 'final'))['result']['status'] == 'ok'
        assert (await _lock(connection, rid, 'q2', None))['result']['status'] == 'ok'  # explicit skip
        assert (await _draft(connection, rid, 'q0', text='late edit', revision=21))['result'] == {'status': 'locked'}
        assert (await _draft(connection, rid, 'q2', choices=['Fireside'], revision=2))['result'] == {
            'status': 'locked'}
        listed = (await _rpc(connection, 'clarify.drafts', {'session_id': 's', 'request_id': rid}))['result']
        assert set(listed['drafts'][0]['drafts']) == {'q1'}
        assert (await _lock(connection, rid, 'q1', '["Acme"]'))['result'] == {'status': 'ok', 'remaining': []}
        await asyncio.to_thread(worker.join, 5)
        # Confirm is unchanged: the answers alone, no drafts; and nothing left to recover.
        assert out == {'answers': {'q0': 'final', 'q1': '["Acme"]', 'q2': None}, 'outcome': 'submitted'}
        assert (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_owner_interrupt_keeps_drafts_as_cancelled_and_reconnect_reads_them_back(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    authority, connection = await _owner(tmp_path, monkeypatch)
    agent = SimpleNamespace(_interrupt_requested=False)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, interrupted=agent)
        rid = await _rid(peer)
        await _draft(connection, rid, 'q1', choices=['Acme', 'Cobalt'], revision=3)
        await _lock(connection, rid, 'q2', 'Panel')
        agent._interrupt_requested = True
        await asyncio.to_thread(worker.join, 5)
        assert out['outcome'] == 'cancelled' and out['answers'] == {'q2': 'Panel'}
        assert out['drafts'] == {'q1': {'choices': ['Acme', 'Cobalt'], 'text': '', 'revision': 3}}
    finally:
        await connection.close()
    # A reconnecting viewer of the same session reads the saved copy back after the request ended.
    again = AuthorityConnection(authority, object(), {'user_id': 'owner'})
    try:
        await again.dispatch({'id': 1, 'method': 'session.resume', 'params': {'session_id': 's'}})
        records = (await _rpc(again, 'clarify.drafts', {'session_id': 's'}))['result']['drafts']
        assert [(r['request_id'], r['outcome']) for r in records] == [(rid, 'cancelled')]
        assert records[0]['drafts'] == {'q1': {'choices': ['Acme', 'Cobalt'], 'text': '', 'revision': 3}}
        assert records[0]['questions'][1]['choices'] == ['Acme (Recommended)', 'Bolt', 'Cobalt']
        assert (await _rpc(again, 'clarify.drafts.discard', {'session_id': 's', 'request_id': rid}))['result'] == {
            'status': 'ok'}
        assert (await _rpc(again, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
    finally:
        await again.close()


@pytest.mark.asyncio
async def test_owner_drafts_survive_a_restart_mid_wait_on_disk(tmp_path, monkeypatch):
    from gateway.session_server_requests import _lock as registry_lock, _open
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, _out = _start_batch(authority, monkeypatch, timeout=3)
        rid = await _rid(peer)
        await _draft(connection, rid, 'q0', text='typed before the crash', revision=5)
        with registry_lock:  # the process died: the in-memory registry is gone, nothing settled
            pending = _open.pop(rid)
        pending.event.set()
        await asyncio.to_thread(worker.join, 5)
        records = (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result']['drafts']
        assert records[0]['request_id'] == rid
        assert records[0]['drafts']['q0']['text'] == 'typed before the crash'
        assert (await _draft(connection, rid, 'q0', text='after', revision=6))['result'] == {'status': 'expired'}
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_owner_discard_while_open_cannot_be_recreated_by_an_in_flight_save(tmp_path, monkeypatch):
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=2)
        rid = await _rid(peer)
        await _draft(connection, rid, 'q0', text='scrap this', revision=1)
        assert (await _rpc(connection, 'clarify.drafts.discard', {'session_id': 's', 'request_id': rid}))[
            'result'] == {'status': 'ok'}
        assert (await _draft(connection, rid, 'q0', text='in flight', revision=2))['result'] == {'status': 'discarded'}
        await asyncio.to_thread(worker.join, 10)
        assert out == {'answers': {}, 'outcome': 'timed_out'}
        assert (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_owner_drafts_need_the_attached_session_viewer_never_a_request_id_alone(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    authority, owner = await _owner(tmp_path / 'a', monkeypatch)
    _b, foreign = await _owner(tmp_path / 'b', monkeypatch, own_home=True)
    outsider = AuthorityConnection(authority, object(), {'user_id': 'owner'})  # same actor, never attached
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=3)
        rid = await _rid(peer)
        assert (await _draft(owner, rid, 'q0', text='mine', revision=1))['result']['status'] == 'ok'
        for intruder in (outsider, foreign):
            assert (await _draft(intruder, rid, 'q0', text='hijack', revision=9))['result'] == {'status': 'expired'}
        # Naming another session id than the request's own is refused too.
        assert (await _draft(owner, rid, 'q0', text='x', revision=9, session_id='t'))['result'] == {
            'status': 'expired'}
        refused = await _rpc(outsider, 'clarify.drafts', {'session_id': 's'})
        assert refused['error']['message'] == 'permission_denied', refused
        refused = await _rpc(outsider, 'clarify.drafts.discard', {'session_id': 's', 'request_id': rid})
        assert refused['error']['message'] == 'permission_denied', refused
        # Profile B's attached viewer of its own same-named session sees only its own (empty) store.
        assert (await _rpc(foreign, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
        assert (await _rpc(foreign, 'clarify.drafts.discard', {'session_id': 's', 'request_id': rid}))[
            'result'] == {'status': 'missing'}
        await asyncio.to_thread(worker.join, 10)
        assert out['drafts'] == {'q0': {'choices': [], 'text': 'mine', 'revision': 1}}
        # A new request asking q0 again starts empty.
        peer2, worker2, out2 = _start_batch(authority, monkeypatch, timeout=1)
        await _wait_for(lambda: sum(f.get('method') == 'clarify' for f in peer2.frames) >= 1)
        await asyncio.to_thread(worker2.join, 10)
        assert 'drafts' not in out2
    finally:
        for connection in (owner, foreign, outsider):
            await connection.close()


@pytest.mark.asyncio
async def test_owner_draft_input_is_validated_by_contract_and_question(tmp_path, monkeypatch):
    from tui_gateway.contracts.registry import CANONICAL_METHODS
    from tui_gateway.contracts.prompt_voice import ClarifyDraftParams
    assert CANONICAL_METHODS['clarify.draft'].params is ClarifyDraftParams
    assert {'clarify.drafts', 'clarify.drafts.discard'} <= set(CANONICAL_METHODS)
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=2)
        rid = await _rid(peer)
        cases = [
            dict(qid='q1', choices=['Zinc'], text='', revision=1),           # not an offered choice
            dict(qid='q2', choices=['Panel', 'Fireside'], text='', revision=1),  # single-select, two picks
            dict(qid='q9', choices=[], text='x', revision=1),                 # unknown question
            dict(qid='q0', choices=[], text='x' * 16385, revision=1),         # oversize
            dict(qid='q0', choices=[], text='x', revision=0),                 # non-positive revision
        ]
        for case in cases:
            reply = await _draft(connection, rid, case['qid'], choices=case['choices'], text=case['text'],
                                 revision=case['revision'])
            assert 'error' in reply and reply['error']['message'] == 'invalid_params', (case, reply)
        extra = await _draft(connection, rid, 'q0', text='x', revision=1, bogus=1)
        assert extra['error']['data']['fields'] == ['bogus'], extra
        bad_id = await _rpc(connection, 'clarify.drafts', {'session_id': 's', 'request_id': '../x'})
        assert bad_id['error']['message'] == 'invalid_params'
        await asyncio.to_thread(worker.join, 10)
        assert out == {'answers': {}, 'outcome': 'timed_out'}
    finally:
        await connection.close()
