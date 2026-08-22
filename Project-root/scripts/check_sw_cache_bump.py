#!/usr/bin/env python3
"""Fail when a precached shell asset changes without a CACHE_NAME bump.

static/erp/sw.js precaches the app shell and serves it CACHE-FIRST, so an
already-installed service worker keeps handing out its own copy of every
file in PRECACHE_URLS until CACHE_NAME changes. Edit production.js, deploy,
and the server serves the new file to nobody: every installed tablet answers
from its cache. The deploy succeeds and nothing on the floor changes.

This is easy to ship because nothing announces it. It is worst for
print-only edits, where the app UI looks identical either way, so the first
signal is somebody asking why the printout is still the old layout. It has
happened twice.

Two modes:

    check_sw_cache_bump.py FILE [FILE ...]   # pre-commit: staged files vs HEAD
    check_sw_cache_bump.py --range A..B      # CI: files changed in a range

Exits 0 when there is nothing to say, 1 with an explanation when a bump is
missing. Any state it cannot evaluate (no git, no HEAD, sw.js absent) is a
pass -- this is a guard rail, not a gate, and it must never block a commit
because it could not work out the answer.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

SW_PATH = "Project-root/static/erp/sw.js"
STATIC_PREFIX = "/static/erp/"
REPO_STATIC_PREFIX = "Project-root/static/erp/"

CACHE_NAME_RE = re.compile(r"""const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]""")
PRECACHE_RE = re.compile(r"const PRECACHE_URLS = \[(.*?)\n\];", re.S)


def _git(*args: str) -> str | None:
    """Run a git command, returning None instead of raising on any failure."""
    try:
        out = subprocess.run(
            ["git", *args], capture_output=True, text=True, encoding="utf-8", check=False
        )
    except OSError:
        return None
    return out.stdout if out.returncode == 0 else None


def _cache_name(source: str | None) -> str | None:
    if not source:
        return None
    m = CACHE_NAME_RE.search(source)
    return m.group(1) if m else None


def _precached_repo_paths(source: str | None) -> set[str]:
    """Repo-relative paths of every /static/erp/ entry in PRECACHE_URLS.

    Line comments are stripped first: the entries are grouped under comments
    that contain ordinary apostrophes ("the app's JavaScript"), and a naive
    sweep for quoted strings pairs one of those with the next real quote,
    swallowing the URLs in between.
    """
    if not source:
        return set()
    block = PRECACHE_RE.search(source)
    if not block:
        return set()
    code = re.sub(r"//[^\n]*", "", block.group(1))
    return {
        REPO_STATIC_PREFIX + url[len(STATIC_PREFIX):]
        for url in re.findall(r"'([^']+)'", code)
        if url.startswith(STATIC_PREFIX)
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="changed files (pre-commit passes these)")
    parser.add_argument("--range", dest="rng", help="git range, e.g. origin/main...HEAD")
    args = parser.parse_args()

    if args.rng:
        listing = _git("diff", "--name-only", args.rng)
        if listing is None:
            print(f"[sw-cache] cannot diff {args.rng}; skipping.")
            return 0
        changed = [f for f in listing.splitlines() if f.strip()]
        base = args.rng.split("..")[0] or "HEAD"
        old_sw = _git("show", f"{base}:{SW_PATH}")
        new_sw = _git("show", f"{args.rng.split('..')[-1] or 'HEAD'}:{SW_PATH}")
    else:
        changed = [f.replace("\\", "/") for f in args.files]
        old_sw = _git("show", f"HEAD:{SW_PATH}")
        try:
            with open(SW_PATH, encoding="utf-8") as fh:
                new_sw = fh.read()
        except OSError:
            new_sw = None

    # Nothing to compare against (first commit, fresh clone, file moved).
    if old_sw is None or new_sw is None:
        return 0

    precached = _precached_repo_paths(new_sw)
    touched = sorted(f for f in changed if f in precached)
    if not touched:
        return 0

    old_name, new_name = _cache_name(old_sw), _cache_name(new_sw)
    if old_name is None or new_name is None or old_name != new_name:
        return 0

    print()
    print("  Precached shell asset changed, but CACHE_NAME did not.")
    print()
    for f in touched:
        print(f"      {f}")
    print()
    print(f"  {SW_PATH} still says CACHE_NAME = '{new_name}'.")
    print()
    print("  These files are served cache-first, so every already-installed")
    print("  client keeps its own copy and never sees this change. Bump the")
    print("  version and add a line to the changelog above it saying why:")
    print()
    bumped = re.sub(r"(\d+)$", lambda m: str(int(m.group(1)) + 1), new_name)
    print(f"      const CACHE_NAME = '{bumped}';")
    print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
