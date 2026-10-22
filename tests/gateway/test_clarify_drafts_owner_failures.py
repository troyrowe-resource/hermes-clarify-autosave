"""The session owner's draft verbs under failure: a refused disk, damaged and foreign records, no home at all.

Driven through the real ``AuthorityConnection`` dispatcher against a real ``ask_clarify_batch`` wait, like
``test_clarify_drafts_owner.py`` (the happy paths) but with the store failing the way a disk fails. Whatever the
store does, the owner never reports a draft saved that is not on disk (``durable: false``), never turns an unreadable
or somebody else's record into one of this session's drafts, and never lets a draft become an answer.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from tests.gateway.test_clarify_drafts_owner import QUESTIONS, _draft, _owner, _rid, _rpc, _start_batch
from tools import clarify_drafts as store
from tools.clarify_tool import _result


def _blocked_store(authority):
    """The owner's drafts root is a regular file, so no record can ever be written (the same refusal as a read-only
    or full volume to the code asking, but one that also holds for a root user and on Windows)."""
    from gateway.session_clarify_draft import owner_home
    blocker = owner_home(authority) / store.STORE_DIRNAME
    blocker.write_text('a file where the drafts directory belongs', encoding='utf-8')
    return blocker


@pytest.mark.asyncio
async def test_a_refused_disk_is_durable_false_on_the_wire_and_in_the_model_result(tmp_path, monkeypatch):
    authority, connection = await _owner(tmp_path, monkeypatch)
    _blocked_store(authority)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=1)
        rid = await _rid(peer)
        assert (await _draft(connection, rid, 'q0', text='typed', revision=1))['result'] == {
            'status': 'ok', 'revision': 1, 'durable': False}
        assert (await _draft(connection, rid, 'q1', choices=['Acme', 'Cobalt'], revision=1))['result'] == {
            'status': 'ok', 'revision': 1, 'durable': False}
        # A retry of the held revision reports the held copy's real durability, never "stale means saved".
        assert (await _draft(connection, rid, 'q0', text='typed', revision=1))['result'] == {
            'status': 'stale', 'revision': 1, 'durable': False}
        # Recall on a store that cannot be read answers empty: no error, no invented draft.
        assert (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
        await asyncio.to_thread(worker.join, 10)
    finally:
        await connection.close()
    assert out['answers'] == {} and out['outcome'] == 'timed_out'
    assert out['drafts'] == {'q0': {'choices': [], 'text': 'typed', 'revision': 1},
                             'q1': {'choices': ['Acme', 'Cobalt'], 'text': '', 'revision': 1}}, 'the held copy is kept'
    assert out['drafts_durable'] is False and out['drafts_request_id'] == rid
    view = json.loads(_result(QUESTIONS, out))
    assert view['drafts_durable'] is False and view['drafts_submitted'] is False
    assert [r['status'] for r in view['responses']] == ['unanswered'] * 3


@pytest.mark.asyncio
async def test_a_store_that_comes_back_makes_the_next_save_durable_and_writes_everything_held(tmp_path, monkeypatch):
    authority, connection = await _owner(tmp_path, monkeypatch)
    blocker = _blocked_store(authority)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=2)
        rid = await _rid(peer)
        assert (await _draft(connection, rid, 'q0', text='refused', revision=1))['result']['durable'] is False
        blocker.unlink()  # the volume is writable again
        assert (await _draft(connection, rid, 'q1', choices=['Bolt'], revision=1))['result'] == {
            'status': 'ok', 'revision': 1, 'durable': True}
        records = (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result']['drafts']
        assert set(records[0]['drafts']) == {'q0', 'q1'}, 'the draft refused earlier is written with the next one'
        await asyncio.to_thread(worker.join, 10)
    finally:
        await connection.close()
    assert out['drafts_durable'] is True


@pytest.mark.asyncio
async def test_damaged_and_foreign_records_never_reach_recall_and_never_break_it(tmp_path, monkeypatch):
    from gateway.session_clarify_draft import owner_draft_scope, owner_home
    authority, connection = await _owner(tmp_path / 'a', monkeypatch)
    home, other_home = owner_home(authority), tmp_path / 'b'
    other_home.mkdir()
    mine = owner_draft_scope(authority, 's')
    typed = {'q0': {'choices': [], 'text': 'mine', 'revision': 1}}
    store.persist(mine, 'srq-aaaaaaaaaaaa', QUESTIONS, typed)  # this session's own record
    # Damaged files in this session's own directory.
    damaged = {'srq-bbbbbbbbbbbb': '{not json', 'srq-cccccccccccc': '[]', 'srq-dddddddddddd': ''}
    for request_id, raw in damaged.items():
        mine.path(request_id).write_text(raw, encoding='utf-8')
    # Somebody else's valid records: the same session id under the other gateway, another session of this gateway,
    # and the same gateway + session id in another profile's home.
    foreign = {'srq-eeeeeeeeeeee': store.DraftScope(home, 'tui_gateway', 's'),
               'srq-ffffffffffff': store.DraftScope(home, 'session_owner', 't'),
               'srq-111111111111': store.DraftScope(other_home, 'session_owner', 's')}
    for request_id, scope in foreign.items():
        store.persist(scope, request_id, QUESTIONS, {'q0': {'choices': [], 'text': 'not mine', 'revision': 1}})
    try:
        listed = (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result']['drafts']
        assert [r['request_id'] for r in listed] == ['srq-aaaaaaaaaaaa']
        assert listed[0]['drafts'] == typed
        for request_id in (*damaged, *foreign):
            reply = await _rpc(connection, 'clarify.drafts', {'session_id': 's', 'request_id': request_id})
            assert reply['result'] == {'drafts': []}, (request_id, reply)
        # Discarding a request id that is not this session's own record removes nothing of anybody's.
        for request_id in (*damaged, *foreign):
            reply = await _rpc(connection, 'clarify.drafts.discard', {'session_id': 's', 'request_id': request_id})
            assert reply['result'] == {'status': 'missing'}, (request_id, reply)
        assert all(scope.path(request_id).exists() for request_id, scope in foreign.items()), 'foreign records stay'
        assert all(mine.path(request_id).exists() for request_id in damaged), 'damaged files stay as repair evidence'
        assert [r['request_id'] for r in (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))[
            'result']['drafts']] == ['srq-aaaaaaaaaaaa']
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_a_draft_with_an_unpaired_surrogate_is_refused_before_the_book_and_the_wait_ends_normally(tmp_path, monkeypatch):
    """A JS string with a lone surrogate reaches the backend as JSON ``"\\ud800"`` and decodes to a str UTF-8 cannot
    encode. The canonical dispatcher already refuses such a value against the declared contract (``4001 invalid_params``
    naming ``text``) before any handler runs, so on the owner this route never reaches the book (the sidecar has no
    value check at its dispatcher: tests/tui_gateway/test_clarify_drafts_failures.py; the book itself refuses in
    ``normalize_draft``, tests/tools/test_clarify_drafts_failures.py). A guard, not a regression test: it passes without
    the book's own check. The model-authored route that does reach the owner's book is the registry-level
    ``test_a_request_whose_own_questions_the_store_cannot_encode_still_settles_with_durable_false``."""
    authority, connection = await _owner(tmp_path, monkeypatch)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=1)
        rid = await _rid(peer)
        assert (await _draft(connection, rid, 'q0', text='kept', revision=1))['result']['durable'] is True
        for revision, text in ((2, json.loads('"\\ud800"')), (3, 'half a pair \ud83d')):
            refused = await _draft(connection, rid, 'q1', text=text, revision=revision)
            assert refused['error'] == {'code': 4001, 'message': 'invalid_params',
                                        'data': {'reason': 'invalid_params', 'fields': ['text']}}, refused
        assert [r['drafts'] for r in (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result']['drafts']] == [
            {'q0': {'choices': [], 'text': 'kept', 'revision': 1}}]
        await asyncio.to_thread(worker.join, 10)
        assert not worker.is_alive()
    finally:
        await connection.close()
    assert out['answers'] == {} and out['outcome'] == 'timed_out', 'the wait still ended with its result'
    assert out['drafts'] == {'q0': {'choices': [], 'text': 'kept', 'revision': 1}} and out['drafts_durable'] is True


def test_the_owner_scope_is_this_authoritys_profile_home_the_owner_gateway_and_the_stored_session_id(tmp_path):
    from gateway.session_clarify_draft import owner_draft_scope, owner_home
    profile, multiplexed = tmp_path / 'profile', tmp_path / 'multiplexed'
    multiplexed.mkdir()
    db = SimpleNamespace(db_path=profile / 'state.db')
    plain = SimpleNamespace(profile_id='default', db=db)
    assert owner_draft_scope(plain, 's1') == store.DraftScope(profile, 'session_owner', 's1')
    # A multiplexed authority's id IS its own home, whatever process-wide state says.
    assert owner_draft_scope(SimpleNamespace(profile_id=str(multiplexed), db=db), 's1') == store.DraftScope(
        multiplexed, 'session_owner', 's1')
    # An id that is not a live directory names no home: the authority's own store does.
    assert owner_home(SimpleNamespace(profile_id=str(tmp_path / 'gone'), db=db)) == profile
    # Nothing identifies the profile, or no stored session id: no scope at all, so nothing is ever written anywhere.
    assert owner_home(SimpleNamespace(profile_id='', db=None)) is None
    assert owner_draft_scope(SimpleNamespace(profile_id='', db=None), 's1') is None
    assert owner_draft_scope(plain, '') is None and owner_draft_scope(plain, None) is None


@pytest.mark.asyncio
async def test_an_authority_with_no_resolvable_home_keeps_drafts_in_memory_only_and_says_so(tmp_path, monkeypatch):
    from gateway.session_clarify_draft import owner_home
    authority, connection = await _owner(tmp_path, monkeypatch)
    home = owner_home(authority)
    monkeypatch.setattr('gateway.session_clarify_draft.owner_home', lambda _authority: None)
    try:
        peer, worker, out = _start_batch(authority, monkeypatch, timeout=1)
        rid = await _rid(peer)
        assert (await _draft(connection, rid, 'q0', text='memory only', revision=1))['result'] == {
            'status': 'ok', 'revision': 1, 'durable': False}
        assert (await _rpc(connection, 'clarify.drafts', {'session_id': 's'}))['result'] == {'drafts': []}
        await asyncio.to_thread(worker.join, 10)
    finally:
        await connection.close()
    assert out['drafts'] == {'q0': {'choices': [], 'text': 'memory only', 'revision': 1}}
    assert out['drafts_durable'] is False
    assert not (home / store.STORE_DIRNAME).exists(), 'nothing was written under the profile home'
