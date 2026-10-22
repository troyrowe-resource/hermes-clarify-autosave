"""An OPEN batch ``clarify`` request survives a dropped transport: ``session.resume`` and ``session.events.since``
on the canonical gateway restore it, with the locks and unsent drafts so far.

Regression: the owner's batch request lived only in ``session_server_requests._open`` and was written once to the
transports attached when it was asked. A socket that dropped (1006, a renderer reload) and re-attached got a
snapshot built from ``PendingControls.prompts`` alone, which never held it: the live card vanished, the user could
no longer Confirm, and the turn waited out the whole ``clarify_timeout``. The sidecar always replayed it
(``ServerRequest.snapshot``: questions + answers + drafts); the owner now does too, as the same ``open_requests``
entries, entitled exactly like ``clarify.lock``: only a viewer attached to that live session with
``session:respond``, never across sessions or profiles.
"""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from gateway.config import Platform
from tests.gateway.test_clarify_drafts_owner import _draft, _lock, _owner, _rid, _rpc, _start_batch

# Windows children need the system environment (Winsock: without SYSTEMROOT ``import asyncio`` dies in
# ``_overlapped`` with WinError 10106; temp, PATHEXT) that the hermetic test process still carries; POSIX only
# ever uses the first three. Same list as the other real-gateway child probes.
_CHILD_ENV_KEYS = ('PATH', 'LANG', 'TZ', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
                   'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS',
                   'PROCESSOR_ARCHITECTURE')
RESUME = {'id': 1, 'method': 'session.resume', 'params': {'session_id': 's'}}


def _wire(peer):
    """The questions exactly as the request frame carried them to the viewer that was attached."""
    return next(f for f in peer.frames if f.get('method') == 'clarify')['params']['questions']


async def _resume(connection, session_id='s'):
    return (await connection.dispatch({**RESUME, 'params': {'session_id': session_id}})).get('result')


async def _since(connection, resumed, session_id='s'):
    reply = await connection.dispatch({'id': 2, 'method': 'session.events.since', 'params': {
        'session_id': session_id, 'replay_epoch': resumed['replay_epoch'], 'last_sequence': resumed['last_sequence']}})
    return reply.get('result')


async def _reconnect(authority, **identity):
    from gateway.session_controls import AuthorityConnection
    return AuthorityConnection(authority, object(), {'user_id': 'owner', **identity})


@pytest.mark.asyncio
async def test_a_reconnecting_viewer_gets_the_open_batch_with_its_locks_and_drafts(tmp_path, monkeypatch):
    authority, connection = await _owner(tmp_path, monkeypatch)
    peer, worker, out = _start_batch(authority, monkeypatch, timeout=60)
    rid = await _rid(peer)
    await _draft(connection, rid, 'q0', text='half typed', revision=3)
    await _draft(connection, rid, 'q1', choices=['Acme', 'Cobalt'], text='plus Delta', revision=2)
    await _lock(connection, rid, 'q2', 'Panel')
    await _draft(connection, rid, 'q2', choices=['Fireside'], revision=9)  # locked: the lock wins, never listed
    await connection.close()  # the socket drops (1006) with the card still open

    again = await _reconnect(authority)
    try:
        resumed = await _resume(again)
        expected = [{'id': rid, 'method': 'clarify', 'params': {
            'session_id': 's', 'questions': _wire(peer), 'answers': {'q2': 'Panel'},
            'drafts': {'q0': {'choices': [], 'text': 'half typed', 'revision': 3},
                       'q1': {'choices': ['Acme', 'Cobalt'], 'text': 'plus Delta', 'revision': 2}}}}]
        assert resumed['open_requests'] == expected
        # The reconnect handshake's other half (``session.events.since``) restores it too.
        assert (await _since(again, resumed))['open_requests'] == expected
        # Re-delivery is idempotent: the same id and the same locks, never a second request or reset locks.
        assert (await _resume(again))['open_requests'] == expected
        # And the card that came back still works: a lock through the new socket settles the very same request.
        assert (await _lock(again, rid, 'q0', 'final'))['result'] == {'status': 'ok', 'remaining': ['q1']}
        later = (await _resume(again))['open_requests'][0]['params']
        assert later['answers'] == {'q2': 'Panel', 'q0': 'final'} and set(later['drafts']) == {'q1'}
        assert (await _lock(again, rid, 'q1', '["Acme"]'))['result'] == {'status': 'ok', 'remaining': []}
        await asyncio.to_thread(worker.join, 10)
        assert out['outcome'] == 'submitted' and out['answers'] == {'q2': 'Panel', 'q0': 'final', 'q1': '["Acme"]'}
        assert 'open_requests' not in await _resume(again)
    finally:
        await again.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('ending', ['submitted', 'cancelled', 'timed_out', 'interrupted'])
async def test_a_settled_request_never_reappears_after_a_reconnect(tmp_path, monkeypatch, ending):
    authority, connection = await _owner(tmp_path, monkeypatch)
    agent = SimpleNamespace(_interrupt_requested=False)
    peer, worker, out = _start_batch(authority, monkeypatch, timeout=2 if ending == 'timed_out' else 60,
                                     interrupted=agent)
    rid = await _rid(peer)
    await _draft(connection, rid, 'q0', text='typed', revision=1)
    if ending == 'submitted':
        for qid in ('q0', 'q1', 'q2'):
            await _lock(connection, rid, qid, 'x')
    elif ending == 'cancelled':
        from gateway.session_server_requests import resolve
        resolve({'jsonrpc': '2.0', 'id': rid, 'result': {}})  # the card's plain cancel
    elif ending == 'interrupted':
        agent._interrupt_requested = True
    await asyncio.to_thread(worker.join, 15)
    assert not worker.is_alive()
    await connection.close()
    again = await _reconnect(authority)
    try:
        resumed = await _resume(again)
        assert 'open_requests' not in resumed
        assert 'open_requests' not in await _since(again, resumed)
    finally:
        await again.close()


@pytest.mark.asyncio
async def test_only_a_viewer_attached_with_respond_gets_the_request_never_another_session_or_profile(tmp_path, monkeypatch):
    from gateway.session_authority import LiveSession
    from gateway.session import SessionSource
    authority, owner = await _owner(tmp_path / 'a', monkeypatch)
    foreign_authority, foreign = await _owner(tmp_path / 'b', monkeypatch, own_home=True)
    peer, worker, out = _start_batch(authority, monkeypatch, timeout=60)
    rid = await _rid(peer)
    await _draft(owner, rid, 'q0', text='private text', revision=1)
    read_only = await _reconnect(authority, capabilities=['session:read'])
    unattached = await _reconnect(authority)
    # A second live session of the same authority: its viewers never see the first one's request.
    authority.db.create_session('t', source='telegram')
    authority.sessions['t'] = LiveSession(SessionSource(platform=Platform.TELEGRAM, chat_id='c2'), 't')
    other_session = await _reconnect(authority)
    try:
        resumed = await _resume(read_only)
        assert resumed is not None and 'open_requests' not in resumed  # may read the chat, may not answer or see drafts
        assert 'open_requests' not in await _since(read_only, resumed)
        # Never attached to the session: the same actor identity, no subscription, no entitlement.
        probe = await _resume(owner)
        assert 'open_requests' not in await _since(unattached, probe)
        # Profile B's attached viewer of its OWN same-named session 's' (the table is process-wide).
        foreign_resumed = await _resume(foreign)
        assert 'open_requests' not in foreign_resumed
        assert 'open_requests' not in await _since(foreign, foreign_resumed)
        # Another session of the same profile.
        assert 'open_requests' not in await _resume(other_session, 't')
        # The attached, entitled viewer still has it all along.
        assert [e['id'] for e in (await _resume(owner))['open_requests']] == [rid]
        from gateway.session_server_requests import resolve
        resolve({'jsonrpc': '2.0', 'id': rid, 'result': {}})
        await asyncio.to_thread(worker.join, 10)
    finally:
        for connection in (owner, foreign, read_only, unattached, other_session):
            await connection.close()


def test_a_forced_socket_close_loses_neither_the_open_batch_nor_its_locks_and_drafts_end_to_end(tmp_path):
    """Real gateway process and WebSockets: a Desktop-shaped (``gui``) viewer locks one answer and saves drafts,
    its connection is aborted with no close handshake, and the fresh socket's reconnect handshake restores the
    request with both; the same request then settles through the new socket and the answers reach the real model."""
    home, state = tmp_path / 'home', tmp_path / 'state'
    home.mkdir()
    state.mkdir()
    repo = Path(__file__).resolve().parents[2]
    env = {key: os.environ[key] for key in _CHILD_ENV_KEYS if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(state), PYTHONPATH=str(repo))
    result = subprocess.run(
        [sys.executable, str(Path(__file__).parent / 'fixtures' / 'authority_clarify_reconnect_peer.py')],
        cwd=tmp_path, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (state / 'reconnect-passed').read_text() == 'the open batch survived the forced close'
