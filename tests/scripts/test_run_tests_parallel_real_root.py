"""scripts/run_tests_parallel.py fails a run that created a real Hermes root.

tests/conftest.py fails the test during which ``~/.hermes`` appears (a child
spawned without HERMES_HOME seeds it on its first ``load_config()``), but the
runner's one-shot file retry then finds the root present and passes: a
deterministic leak reported as a green FLAKY run. The run-level check keeps
that run red.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
_RUNNER_PATH = REPO_ROOT / "scripts" / "run_tests_parallel.py"


def _load_runner():
    spec = importlib.util.spec_from_file_location("run_tests_parallel", _RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _runner_homed_in(tmp_path, monkeypatch):
    mod = _load_runner()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    return mod


def test_run_that_creates_the_root_fails_though_every_file_passed(tmp_path, monkeypatch):
    mod = _runner_homed_in(tmp_path, monkeypatch)
    monkeypatch.setattr(mod, "main", lambda: (tmp_path / ".hermes").mkdir() or 0)

    assert mod._main_refusing_created_roots() == 1


def test_root_present_before_the_run_is_not_blamed(tmp_path, monkeypatch):
    """A developer's live install already holds the root: never a failure."""
    mod = _runner_homed_in(tmp_path, monkeypatch)
    (tmp_path / ".hermes").mkdir()
    monkeypatch.setattr(mod, "main", lambda: 0)

    assert mod._main_refusing_created_roots() == 0
