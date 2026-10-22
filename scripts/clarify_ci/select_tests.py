"""Python test files the Windows native job runs (stdlib only).

Prints the explicitly listed files, each of which must exist, followed by every other clarify-draft test
under ``tests/`` (``test_*clarify*draft*.py``). The workflow keeps its baseline list in plain sight; the
glob only adds the draft tests a later commit introduces, so a new test cannot be left out of the gate by
forgetting to extend the list.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DISCOVERED = "test_*clarify*draft*.py"


def select(root: Path, listed: list[str]) -> tuple[list[str], list[str]]:
    """The listed files in their given order, then the discovered extras; and the listed files that are absent."""
    absent = [name for name in listed if not (root / name).is_file()]
    known = {Path(name).as_posix() for name in listed}
    extras = sorted(
        path.relative_to(root).as_posix()
        for path in (root / "tests").rglob(DISCOVERED)
        if path.is_file() and "__pycache__" not in path.parts and path.relative_to(root).as_posix() not in known
    )
    return [Path(name).as_posix() for name in listed] + extras, absent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("listed", nargs="+", help="the explicit baseline test files")
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    selected, absent = select(Path(args.root), args.listed)
    for name in absent:
        print(f"::error::listed test file is missing: {name}", file=sys.stderr)
    if absent:
        return 1
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")  # a shell reads this list; Windows text mode would add a CR to every name
    print("\n".join(selected))
    return 0


if __name__ == "__main__":
    sys.exit(main())
