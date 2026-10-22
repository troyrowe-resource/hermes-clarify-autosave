"""The clarify tool result's unsent drafts: beside ``responses``, never inside them.

A draft is what the user typed or picked on a batch card without submitting it
(``tools/clarify_drafts.py``). The model must see it as incomplete and non-consenting, and the three
response statuses must keep their meaning.
"""
import json

from tools.clarify_tool import clarify_tool

QUESTIONS = [{"question": "One?"}, {"question": "Two?", "choices": ["a", "b"], "multi_select": True},
             {"question": "Three?"}]


def _ask(reply):
    return json.loads(clarify_tool(QUESTIONS, callback=lambda questions: reply))


def test_batch_drafts_are_not_answers():
    result = _ask({"answers": {"q2": "locked"}, "outcome": "timed_out",
                   "drafts": {"q0": {"choices": [], "text": "typed\nline 2"},
                              "q1": {"choices": ["a"], "text": "other"}}})
    assert [r["status"] for r in result["responses"]] == ["unanswered", "unanswered", "answered"]
    assert [r["user_response"] for r in result["responses"]] == [None, None, "locked"]
    assert result["outcome"] == "timed_out"
    assert result["drafts_submitted"] is False
    assert result["drafts"] == [
        {"question_index": 0, "question_id": "q0", "question": "One?", "selected_choices": [], "typed_text": "typed\nline 2"},
        {"question_index": 1, "question_id": "q1", "question": "Two?", "selected_choices": ["a"], "typed_text": "other"}]
    assert "not consent" in result["drafts_notice"]


def test_a_draft_for_an_answered_or_skipped_question_is_never_reported():
    """Whatever the callback carried, a settled question's draft is superseded by its answer or skip."""
    result = _ask({"answers": {"q0": "final", "q1": None}, "outcome": "cancelled",
                   "drafts": {"q0": {"choices": [], "text": "older draft"},
                              "q1": {"choices": ["a"], "text": ""}}})
    assert [r["status"] for r in result["responses"]] == ["answered", "skipped", "unanswered"]
    assert "drafts" not in result and "drafts_submitted" not in result


def test_no_drafts_keeps_the_result_shape_unchanged():
    result = _ask({"answers": {}, "outcome": "timed_out", "drafts": {"q0": {"choices": [], "text": "  "}}})
    assert set(result) == {"responses", "outcome"}
