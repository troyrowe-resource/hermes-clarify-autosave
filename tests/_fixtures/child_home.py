"""A throwaway user home for child processes a test spawns with a rebuilt environment.

Such a child keeps ``HOME`` but loses the hermetic ``HERMES_HOME`` redirect, and its first
``load_config()`` (plain ``import hermes_state`` reaches one through provider discovery) seeds
the platform-default Hermes root of whatever home it names: SOUL.md, sessions/, cron/, ... in
the developer's real ``~/.hermes``. The in-process I/O guard cannot see a child, so the child
gets its own home instead.
"""

import os
from pathlib import Path


def throwaway_home_env(home: Path) -> dict[str, str]:
    """Env overrides that move a child's user home, and with it every platform-default Hermes
    root it resolves, to *home* (created here)."""
    home.mkdir(parents=True, exist_ok=True)
    env = {
        "HOME": str(home),
        "USERPROFILE": str(home),  # native-Windows Path.home() / expanduser("~")
        # Parent of the native-Windows Hermes root (%LOCALAPPDATA%\hermes).
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "APPDATA": str(home / "AppData" / "Roaming"),
    }
    drive, tail = os.path.splitdrive(str(home))
    if drive:  # Windows tools that predate USERPROFILE read HOMEDRIVE + HOMEPATH
        env.update(HOMEDRIVE=drive, HOMEPATH=tail)
    return env
