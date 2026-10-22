"""``hermes profile create --clone-all`` leaves the source's unsent clarify drafts behind.

``clarify_drafts/`` holds per-session unsent text keyed by the SOURCE's stored session ids
(``tools/clarify_drafts.py``). The clone inherits none of those sessions (``state.db`` and
``sessions`` are history-excluded), so copied drafts would be unreachable orphans that no
recall shows and no session deletion purges: private unsent text duplicated for nothing.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli.profiles import create_profile


@pytest.fixture()
def profile_env(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    default_home = tmp_path / ".hermes"
    default_home.mkdir(exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    return tmp_path


def test_clone_all_leaves_unsent_clarify_drafts_behind_and_keeps_the_rest(profile_env):
    default_home = profile_env / ".hermes"
    (default_home / "config.yaml").write_text("model: test\n", encoding="utf-8")
    (default_home / "SOUL.md").write_text("soul\n", encoding="utf-8")
    draft = default_home / "clarify_drafts" / "session_owner" / "0123456789abcdef" / "srq-aaaaaaaaaaaa.json"
    draft.parent.mkdir(parents=True)
    draft.write_text('{"drafts": {"q0": {"text": "unsent private text"}}}', encoding="utf-8")

    profile_dir = create_profile("coder", clone_all=True, no_alias=True)

    assert not (profile_dir / "clarify_drafts").exists()
    assert (profile_dir / "SOUL.md").read_text(encoding="utf-8") == "soul\n"
    assert (profile_dir / "config.yaml").is_file()
    assert draft.is_file()  # the source keeps its own drafts
