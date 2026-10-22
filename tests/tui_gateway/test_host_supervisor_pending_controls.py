"""A compute host that dies while a ``respond`` / ``control`` waiter is blocked on it answers the waiter at once.

The supervisor already failed pending TURNS and late control acks when the child exited, but a waiter still blocked
in ``respond`` (a Confirm lock, a draft autosave) or ``control`` (a compress) was left to sit out its own timeout
before its caller learned the host was gone. It now gets an ``error`` frame carrying the exit code, so a dead host
can never look like a slow one, and nothing is ever reported saved that the host did not confirm.
"""
import sys
import textwrap

import pytest

from tui_gateway.host_supervisor import HostSupervisor

# ``HostSupervisor`` is POSIX-only in practice (``os.kill(pid, 0)`` is a CTRL_C_EVENT on Windows, ``signal.SIGKILL`` does
# not exist there, ``/proc`` / ``ps`` identify its host); see test_compute_host_clarify_drafts_process.py.
pytestmark = pytest.mark.platforms("posix")

# A host that says hello, reads the first frame the supervisor sends and dies without answering it.
DYING_HOST = textwrap.dedent("""
    import json, os, sys
    print(json.dumps({"type": "hello", "host_pid": os.getpid(), "boot_id": "t", "build_sha": "unknown",
                      "hermes_home": os.environ.get("HERMES_HOME", "")}), flush=True)
    sys.stdin.readline()
    os._exit(3)
""")
WAITER_DEADLINE_SECS = 30.0  # a deadline for the waiter, never reached when the host's death wakes it


def _supervisor(tmp_path):
    return HostSupervisor(registry_path=tmp_path / "host.json", argv=[sys.executable, "-c", DYING_HOST],
                          respawn_max=0, expected_build_sha="unknown")


def test_a_respond_waiter_is_woken_with_the_exit_code_when_the_host_dies(tmp_path):
    supervisor = _supervisor(tmp_path)
    try:
        ack = supervisor.respond("sid", {"draft": {"request_id": "srq-0123456789ab"}}, timeout=WAITER_DEADLINE_SECS)
    finally:
        supervisor.shutdown()
    assert ack["type"] == "error" and ack["reason"] == "crash"
    assert "exited with code 3" in ack["message"]


def test_a_control_waiter_is_woken_the_same_way(tmp_path):
    supervisor = _supervisor(tmp_path)
    try:
        ack = supervisor.control("sid", route_name="session.save", timeout=WAITER_DEADLINE_SECS)
    finally:
        supervisor.shutdown()
    assert ack["type"] == "error" and "exited with code 3" in ack["message"]
