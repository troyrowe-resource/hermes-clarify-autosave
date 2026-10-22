"""Draft invariants that hold identically on BOTH registries: the TUI/Desktop sidecar and the session owner.

A draft is the user's unsent card state, saved so a timeout, a cancel or a restart does not lose it. It is never an
answer, never completes a batch and never consent. Each test states one such invariant once and runs against both
registries through the same verbs (``tests/gateway/clarify_registry_harness.py``), real registry, real draft book,
real disk store.
"""
import pytest

from tests.gateway.clarify_registry_harness import KINDS, OpenBatch, model_view
from tools import clarify_drafts as store


def _lock_every_question(batch):
    batch.lock('q0', 'blue')
    batch.lock('q1', 'large')
    batch.finish()


def _interrupt(batch):
    batch.interrupt()
    batch.finish()


# Each way a batch ends -> (how it is brought to that end, the outcome stamped on the record it leaves; None: nothing
# is left to recover).
ENDINGS = {
    'every_question_locked': (_lock_every_question, None),
    'confirm_frame': (lambda batch: batch.close_with({'answers': {'q0': 'blue', 'q1': 'large'}}), None),
    'cancel_all_frame': (lambda batch: batch.close_with({}), 'cancelled'),
    'timeout': (OpenBatch.finish, 'timed_out'),  # the short deadline the batch was asked with
    'interrupt': (_interrupt, 'cancelled'),
}


@pytest.fixture(params=KINDS)
def registry(request, monkeypatch):
    made = []

    def make(scope=None, **kwargs):
        made.append(OpenBatch(request.param, monkeypatch, scope, **kwargs))
        return made[-1]
    yield make
    for batch in made:
        batch.cleanup()


@pytest.fixture()
def scope(tmp_path):
    return store.DraftScope(tmp_path, 'tui_gateway', 'stored-1')


def _on_disk(scope):
    """request id -> (outcome, drafts) of every record the session's store holds."""
    return {r['request_id']: (r['outcome'], r['drafts']) for r in store.list_records(scope)}


def test_a_draft_for_every_question_never_settles_the_batch_and_each_lock_retires_only_its_own(registry, scope):
    batch = registry(scope)
    assert batch.save('q0', '', 1, ['red']) == {'status': 'ok', 'revision': 1, 'durable': True}
    assert batch.save('q1', 'large', 1) == {'status': 'ok', 'revision': 1, 'durable': True}
    assert batch.is_open and batch.out == {}, 'a draft for every question still left the request waiting'

    assert batch.lock('q0', 'blue') == ['q1']
    assert batch.is_open
    assert _on_disk(scope)[batch.rid][1] == {'q1': {'choices': [], 'text': 'large', 'revision': 1}}

    result = batch.close_with({'answers': {'q1': 'xl'}})
    assert result == {'answers': {'q0': 'blue', 'q1': 'xl'}, 'outcome': 'submitted'}, 'Confirm: answers only'
    assert _on_disk(scope) == {}, 'nothing left to recover once every question has its answer'


def test_drafts_for_every_question_stay_drafts_when_the_wait_ends_unanswered(registry, scope):
    batch = registry(scope)
    batch.save('q0', '', 1, ['blue'])
    batch.save('q1', 'large', 1)

    result = batch.close_with({})  # the card's plain cancel

    assert result['answers'] == {} and result['outcome'] == 'cancelled'
    assert set(result['drafts']) == {'q0', 'q1'} and result['drafts_durable'] is True
    view = model_view(result)
    assert [r['status'] for r in view['responses']] == ['unanswered', 'unanswered']
    assert [r['user_response'] for r in view['responses']] == [None, None]
    assert view['drafts_submitted'] is False
    assert [d['question_id'] for d in view['drafts']] == ['q0', 'q1']


@pytest.mark.parametrize('ending', sorted(ENDINGS))
def test_a_draft_after_the_request_ended_reaches_nothing_and_writes_nothing(registry, scope, ending):
    batch = registry(scope, timeout=0.5 if ending == 'timeout' else 30)
    assert batch.save('q0', '', 1, ['red'])['status'] == 'ok'
    end, outcome = ENDINGS[ending]
    end(batch)
    kept = _on_disk(scope)
    assert not batch.is_open
    assert kept == ({} if outcome is None else
                    {batch.rid: (outcome, {'q0': {'choices': ['red'], 'text': '', 'revision': 1}})})

    for qid in ('q0', 'q1'):
        assert batch.save(qid, 'too late', 99) is None, 'no open request takes it (both RPC layers answer expired)'
    assert batch.discard() is False
    assert _on_disk(scope) == kept, 'and nothing was written or removed'


def test_a_draft_utf8_cannot_encode_is_refused_and_the_wait_still_ends_with_the_drafts_it_holds(registry, scope):
    """A JS string with an unpaired surrogate arrives as JSON ``"\\ud800"``. The save must refuse it whole (nothing held), and
    the request must still settle: the model's result may not die because of a draft the store cannot write."""
    batch = registry(scope)
    assert batch.save('q0', '', 1, ['red'])['status'] == 'ok'

    with pytest.raises(store.DraftError):
        batch.save('q1', 'half a pair \ud83d', 2)

    result = batch.close_with({})  # the card's plain cancel
    assert result['answers'] == {} and result['outcome'] == 'cancelled'
    assert result['drafts'] == {'q0': {'choices': ['red'], 'text': '', 'revision': 1}}
    assert result['drafts_durable'] is True


def test_a_request_whose_own_questions_the_store_cannot_encode_still_settles_with_durable_false(registry, scope):
    """The model's own question text can carry an unpaired surrogate (tool-call JSON ``\\ud800``), so no record can be
    written: every save, lock and the settlement report ``durable: false`` and none of them raises."""
    questions = [{'qid': 'q0', 'question': 'colour \ud800?', 'choices': ['red', 'blue'], 'multi_select': False},
                 {'qid': 'q1', 'question': 'size?', 'choices': None, 'multi_select': False}]
    batch = registry(scope, questions=questions)
    assert batch.save('q0', '', 1, ['blue']) == {'status': 'ok', 'revision': 1, 'durable': False}
    assert batch.save('q1', 'large', 1) == {'status': 'ok', 'revision': 1, 'durable': False}
    assert batch.lock('q0', 'red') == ['q1'], 'a lock re-persists what is left and still must not raise'

    result = batch.close_with({})
    assert result['answers'] == {'q0': 'red'} and result['outcome'] == 'cancelled'
    assert result['drafts'] == {'q1': {'choices': [], 'text': 'large', 'revision': 1}}
    assert result['drafts_durable'] is False
    assert _on_disk(scope) == {}
