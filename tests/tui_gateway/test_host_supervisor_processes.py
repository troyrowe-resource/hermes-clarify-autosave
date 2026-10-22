"""Compute-host process lifecycle against real processes: the startup orphan reconcile, PID-reuse
guarding, and the Windows paths (``os.kill(pid, 0)`` is CTRL_C_EVENT there, bpo-14484; there is no
SIGKILL; a venv's ``python.exe`` is a launcher whose child runs the host; ``start_new_session`` is
ignored). One supervisor registers a host, a second one's startup reconcile finds it, as after a
dashboard that died without shutting its host down."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import psutil
import pytest

from gateway.status import get_process_start_time
from tests.waiting import wait_until
from tui_gateway.host_supervisor import HostSupervisor, _pid_alive

# The trailing argv word is what the reconcile's identity check looks for.
_MARKER = "tui_gateway.compute_host"
_HOST = ("import json, os, sys\n"
         "print(json.dumps({'type': 'hello', 'host_pid': os.getpid()}), flush=True)\n"
         "sys.stdin.readline()\n")  # the supervisor's shutdown frame


def _supervisor(tmp_path, argv: list[str] | None = None) -> HostSupervisor:
    # respawn_max=0: the first one's host is killed under it, and it must not start another.
    return HostSupervisor(registry_path=tmp_path / "host.json", argv=argv or [sys.executable, "-c", _HOST, _MARKER],
                          cwd=tmp_path, expected_build_sha="unknown", respawn_max=0, autostart=False)


def _gone(pid: int) -> bool:
    # pid_exists reads the exit code; on Windows Process(pid) still opens an exited process whose
    # handle someone holds (the first supervisor's Popen holds its child's) and reports it running.
    if not psutil.pid_exists(pid):
        return True
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


def _describe(pid: int) -> str:
    try:
        proc = psutil.Process(pid)
        return (f"{proc.name()} ppid={proc.ppid()} created={proc.create_time()} status={proc.status()} "
                f"{' '.join(proc.cmdline())[:160]}")
    except psutil.Error as exc:
        return repr(exc)


def _tree(pid: int) -> dict[int, str]:
    """``pid`` and its descendants, taken while alive: a venv launcher's host is its child."""
    root = psutil.Process(pid)
    return {proc.pid: _describe(proc.pid) for proc in (root, *root.children(recursive=True))}


def _wait_all_gone(tree: dict[int, str], timeout: float = 10.0) -> None:
    try:
        wait_until(lambda: all(map(_gone, tree)), timeout=timeout)
    except AssertionError:
        survivors = {pid: f"was {was}; now {_describe(pid)}" for pid, was in tree.items() if not _gone(pid)}
        raise AssertionError(f"still running after {timeout}s: {survivors}") from None


@pytest.mark.platforms("any")
@pytest.mark.parametrize("bom", ["", "﻿"], ids=["plain", "bom"])
def test_next_supervisor_stops_the_registered_orphan_host(tmp_path, bom):
    """A registry rewritten by Windows tooling (PowerShell ``Set-Content``) carries a BOM; it must still
    be understood, or the orphan keeps running beside the new host."""
    first = _supervisor(tmp_path)
    try:
        first.start()
        tree = _tree(first.pid)
        assert first._hello["host_pid"] in tree
        registry = first.registry_path
        registry.write_text(bom + registry.read_text(encoding="utf-8"), encoding="utf-8")

        assert _supervisor(tmp_path).reconcile_startup_orphan() == "terminated"
        _wait_all_gone(tree)
        assert not registry.exists()
    finally:
        first.shutdown()


@pytest.mark.platforms("any")
def test_reconcile_spares_a_live_host_that_is_not_the_registered_incarnation(tmp_path):
    """A stale registry whose pid now belongs to another live compute host (another profile's
    dashboard) passes the command-line check; only the recorded start time tells them apart."""
    first = _supervisor(tmp_path)
    try:
        first.start()
        registry = first.registry_path
        record = json.loads(registry.read_text(encoding="utf-8"))
        assert record["host_start_time"] == get_process_start_time(first.pid)
        record["host_start_time"] -= 10_000  # same pid, an incarnation that started long before
        registry.write_text(json.dumps(record), encoding="utf-8")

        assert _supervisor(tmp_path).reconcile_startup_orphan() == "pid-reuse-ignored"
        assert first.is_running() and _pid_alive(first.pid)
        assert not registry.exists()
    finally:
        first.shutdown()


@pytest.mark.platforms("any")
def test_real_compute_host_is_reaped_by_the_next_supervisor(tmp_path, monkeypatch):
    """The real ``python -m tui_gateway.compute_host`` under the supervisor's spawn flags handshakes,
    is registered, and the next supervisor's startup reconcile stops it."""
    from tui_gateway import host_supervisor

    # The hello waits behind a cold agent-stack import, slowest on a loaded Windows runner.
    monkeypatch.setattr(host_supervisor, "_HELLO_TIMEOUT_SECS", 120.0)
    first = HostSupervisor(registry_path=tmp_path / "host.json", respawn_max=0, autostart=False)
    try:
        first.start()
        tree = {first.pid: "launcher", first._hello["host_pid"]: "host"}

        assert _supervisor(tmp_path).reconcile_startup_orphan() == "terminated"
        _wait_all_gone(tree, timeout=30)
    finally:
        first.shutdown()


@pytest.mark.platforms("windows")
def test_reconcile_kills_the_host_under_a_launcher_pid(tmp_path):
    """A venv's ``python.exe`` is a launcher that runs the interpreter as its child, so the registered
    pid is the launcher's. Terminating that pid alone left the host running, still holding the pipes."""
    launcher = ("import subprocess, sys\n"
                f"sys.exit(subprocess.call([sys.executable, '-c', {_HOST!r}],"
                " stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr))")
    first = _supervisor(tmp_path, [sys.executable, "-c", launcher, _MARKER])
    try:
        first.start()
        tree = {first.pid: "launcher", first._hello["host_pid"]: "host"}

        assert _supervisor(tmp_path).reconcile_startup_orphan() == "terminated"
        _wait_all_gone(tree)
    finally:
        first.shutdown()


@pytest.mark.platforms("windows")
def test_host_runs_outside_the_launching_console(tmp_path):
    """``start_new_session`` is ignored on Windows: the host must get its own (hidden) console, so the
    launching terminal's Ctrl+C or close never reaches it and its git/cmd children do not flash."""
    report = ("import ctypes, json, sys\n"
              "pids = (ctypes.c_ulong * 64)()\n"
              "n = ctypes.windll.kernel32.GetConsoleProcessList(pids, 64)\n"
              "print(json.dumps({'type': 'hello', 'console_pids': list(pids[:n])}), flush=True)\n"
              "sys.stdin.readline()\n")
    sup = _supervisor(tmp_path, [sys.executable, "-c", report, _MARKER])
    try:
        sup.start()
        console = sup._hello["console_pids"]
    finally:
        sup.shutdown()
    assert console, "the host has no console: its console children would each open a window"
    assert os.getpid() not in console


@pytest.mark.platforms("windows")
def test_liveness_probe_leaves_the_probed_process_running():
    """bpo-14484: on Windows ``os.kill(pid, 0)`` sends CTRL_C_EVENT, interrupting the probed process (and
    the rest of its console) instead of asking whether it exists. This child shares our console."""
    child = subprocess.Popen(
        [sys.executable, "-c",
         "import sys\ntry:\n    print('ready', flush=True)\n    sys.stdin.readline()\n"
         "except KeyboardInterrupt:\n    sys.exit(3)\n"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "ready"
        assert _pid_alive(child.pid)
        child.stdin.write("release\n")
        child.stdin.flush()
        assert child.wait(timeout=10) == 0
        assert not _pid_alive(child.pid)
    finally:
        if child.poll() is None:
            child.kill()
