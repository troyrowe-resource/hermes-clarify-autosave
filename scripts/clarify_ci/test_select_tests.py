"""Behaviour tests for scripts/clarify_ci/select_tests.py (runs on Linux and Windows)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("clarify_ci_select_tests", Path(__file__).with_name("select_tests.py"))
assert _SPEC is not None and _SPEC.loader is not None
select_tests = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(select_tests)


def _tree(root: Path, *names: str) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")


def test_listed_files_come_first_then_only_the_new_draft_tests(tmp_path, capsys):
    _tree(tmp_path,
          "tests/tools/test_clarify_drafts_store.py", "tests/tools/test_clarify_tool.py",
          "tests/tools/test_clarify_drafts_privacy.py", "tests/gateway/test_clarify_lock_drafts_windows.py",
          "tests/tools/test_unrelated.py", "tests/tools/test_clarify_gateway.py",
          "tests/tools/__pycache__/test_clarify_draft_cache.py")
    code = select_tests.main(["--root", str(tmp_path),
                              "tests/tools/test_clarify_tool.py", "tests/tools/test_clarify_drafts_store.py"])
    assert code == 0
    assert capsys.readouterr().out.split() == [
        "tests/tools/test_clarify_tool.py", "tests/tools/test_clarify_drafts_store.py",
        "tests/gateway/test_clarify_lock_drafts_windows.py", "tests/tools/test_clarify_drafts_privacy.py",
    ]


def test_a_listed_file_that_is_gone_fails_the_selection(tmp_path, capsys):
    _tree(tmp_path, "tests/tools/test_clarify_tool.py")
    assert select_tests.main(["--root", str(tmp_path), "tests/tools/test_clarify_tool.py", "tests/tools/test_renamed.py"]) == 1
    captured = capsys.readouterr()
    assert captured.out == "" and "listed test file is missing: tests/tools/test_renamed.py" in captured.err


def test_no_extras_when_everything_is_already_listed(tmp_path, capsys):
    _tree(tmp_path, "tests/tools/test_clarify_drafts_store.py")
    assert select_tests.main(["--root", str(tmp_path), "tests/tools/test_clarify_drafts_store.py"]) == 0
    assert capsys.readouterr().out.split() == ["tests/tools/test_clarify_drafts_store.py"]
