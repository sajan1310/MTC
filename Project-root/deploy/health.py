#!/usr/bin/env python3
"""MTC ERP -- the server's vitals as a panel, rather than a wall of JSON.

    mtc-health                  once, formatted
    mtc-health --watch          redraw every 5s
    mtc-health --watch 30       ... every 30s
    mtc-health --json           the raw payload, for a script
    mtc-health --no-color       plain text, for a log or a pipe

/health already collects almost everything here (app/health.py): the
database's size, connection count and the three durability settings a
well-meaning "make it faster" edit turns off, the age and checksum of the
latest snapshot, the backup disk. What it hands back is one line of JSON --
the right shape for an uptime monitor and the wrong shape for someone on the
box at 7am asking whether last night went well.

So this reads that payload and lays it out, adds the four things only the
host can answer (unit states, root disk, memory, load), and says in one line
at the end whether anything wants attention.

Exit codes, so the same command works from cron as it does by hand:

    0   everything healthy
    1   something wants attention (the panel says what)
    2   the application could not be reached at all

That last one is the case this is really built for. The panel still draws
when the app is down -- unit states, disk and memory are exactly what you
want then, and a status tool that only works while everything works is not
a status tool.

Stdlib only, and no PyPI dependency: this has to run from the system
python3 during an incident, without the application's virtualenv being
importable or even intact.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HEALTH_URL = os.getenv("MTC_HEALTH_URL", "http://127.0.0.1:8000/health")

# The units this application actually stands on. nginx is last because it is
# the only one whose failure is visible to a user as something other than an
# error page, and postgresql is first because everything else's failure is
# usually a symptom of it.
UNITS = ("postgresql", "redis-server", "nginx", "mtc")

WIDTH = 74

# Thresholds for the things the host reports and /health does not. The
# payload's own sections carry their own `ok`, set in app/health.py, and
# those are never second-guessed here -- a panel that disagreed with the
# endpoint about what "healthy" means would be worse than no panel.
ROOT_DISK_LOW_PERCENT = 10.0
MEMORY_HIGH_PERCENT = 90.0


# ── Presentation ─────────────────────────────────────────────────────────


class Ink:
    """Colour, when the destination can show it.

    Disabled when stdout is not a terminal, when NO_COLOR is set (the
    informal standard), or when TERM says dumb -- so redirecting this into a
    file or a mail body produces text somebody can read, not escape codes.
    """

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def green(self, t):
        return self._wrap("32", t)

    def yellow(self, t):
        return self._wrap("33", t)

    def red(self, t):
        return self._wrap("31", t)

    def bold(self, t):
        return self._wrap("1", t)

    def dim(self, t):
        return self._wrap("2", t)


# A filled dot reads as a state at a glance in a way a word does not, but it
# carries no meaning without colour -- so the no-colour rendering spells the
# state out instead of printing three identical dots.
MARKS = {
    "ok": ("●", "[ ok ]", "green"),
    "warn": ("●", "[warn]", "yellow"),
    "fail": ("●", "[FAIL]", "red"),
}


class Panel:
    def __init__(self, ink: Ink):
        self.ink = ink
        self.lines: list[str] = []

    def blank(self):
        self.lines.append("")

    def title(self, left: str, right: str):
        pad = max(1, WIDTH - len(left) - len(right))
        self.lines.append(f"  {self.ink.bold(left)}{' ' * pad}{self.ink.dim(right)}")

    def section(self, name: str):
        self.blank()
        self.lines.append(f"  {self.ink.bold(name)}")

    def row(self, state: str | None, label: str, value: str, note: str = ""):
        """One fact. `state` None means informational -- no mark, no colour.

        The mark column is a fixed width whether or not it holds a mark, so
        an informational row lines up under the checked ones instead of
        shifting left and reading as a different kind of thing.
        """
        if state is None:
            mark = " " * (6 if not self.ink.enabled else 1)
        else:
            glyph, word, colour = MARKS[state]
            mark = getattr(self.ink, colour)(glyph if self.ink.enabled else word)

        text = f"    {mark}  {label:<17} {value}"
        if note:
            text += self.ink.dim(f"   {note}")
        self.lines.append(text)

    def rule(self):
        self.lines.append("  " + self.ink.dim("─" * WIDTH))

    def verdict(self, state: str, text: str):
        self.rule()
        colour = MARKS[state][2]
        self.lines.append("  " + getattr(self.ink, colour)(text))
        self.blank()

    def render(self) -> str:
        return "\n".join(self.lines)


# ── Formatting helpers ───────────────────────────────────────────────────


def duration(seconds: float) -> str:
    """Whole units, two at most. "2h 14m", not "2 hours, 14 minutes, 3 seconds"."""
    s = int(max(0, seconds))
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    if h < 24:
        return f"{h}h {m}m" if m else f"{h}h"
    d, h = divmod(h, 24)
    return f"{d}d {h}h" if h else f"{d}d"


def gb(value: float) -> str:
    return f"{value:.1f} GB"


# ── Gathering ────────────────────────────────────────────────────────────


def fetch_health(url: str, timeout: float = 5.0) -> tuple[int | None, dict, str]:
    """(http_status, payload, error). Never raises.

    A 503 is a real answer and its body is the interesting one -- app/health
    .py attaches the vitals to the unhealthy response deliberately, because
    they matter MORE when the database is down. So an HTTPError is read, not
    treated as a failure to reach the app.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), ""
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8")), ""
        except Exception:  # noqa: BLE001 -- a body we cannot parse is not a crash
            return exc.code, {}, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        return None, {}, str(getattr(exc, "reason", exc))
    except Exception as exc:  # noqa: BLE001
        return None, {}, f"{type(exc).__name__}: {exc}"


def unit_states(names: tuple[str, ...]) -> dict[str, dict]:
    """ActiveState/SubState per unit, plus how long it has held it.

    Uptime comes from the monotonic timestamp against /proc/uptime rather
    than from parsing systemd's human-readable one, which is locale- and
    timezone-dependent and would be the thing that breaks on somebody else's
    box.
    """
    try:
        boot_uptime = float(open("/proc/uptime").read().split()[0])
    except Exception:  # noqa: BLE001
        boot_uptime = None

    out: dict[str, dict] = {}
    for name in names:
        try:
            raw = subprocess.run(
                [
                    "systemctl",
                    "show",
                    name,
                    "--property=LoadState,ActiveState,SubState,ActiveEnterTimestampMonotonic",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout
            props = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        except Exception:  # noqa: BLE001
            out[name] = {"known": False}
            continue

        since = None
        try:
            entered = int(props.get("ActiveEnterTimestampMonotonic", "0")) / 1_000_000
            if entered > 0 and boot_uptime is not None:
                since = boot_uptime - entered
        except ValueError:
            pass

        out[name] = {
            "known": props.get("LoadState") == "loaded",
            "active": props.get("ActiveState", "unknown"),
            "sub": props.get("SubState", ""),
            "since": since,
        }
    return out


def host_stats() -> dict:
    """Root disk, memory and load -- the three the payload cannot see.

    Every read is guarded independently: this runs during incidents, and a
    /proc that will not answer should cost one row, not the panel.
    """
    stats: dict = {}

    try:
        usage = shutil.disk_usage("/")
        stats["root"] = {
            "free_gb": usage.free / 1024**3,
            "total_gb": usage.total / 1024**3,
            "free_percent": usage.free / usage.total * 100 if usage.total else 0.0,
        }
    except Exception:  # noqa: BLE001
        pass

    try:
        meminfo = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                meminfo[key] = float(rest.strip().split()[0]) * 1024
        total = meminfo.get("MemTotal", 0.0)
        # MemAvailable, not MemFree: free memory on a healthy Linux box is
        # near zero because the page cache uses the rest, and reporting that
        # as "98% used" is how a fine server gets diagnosed as a sick one.
        available = meminfo.get("MemAvailable", 0.0)
        if total:
            stats["memory"] = {
                "used_gb": (total - available) / 1024**3,
                "total_gb": total / 1024**3,
                "used_percent": (total - available) / total * 100,
            }
    except Exception:  # noqa: BLE001
        pass

    try:
        one, five, fifteen = open("/proc/loadavg").read().split()[:3]
        stats["load"] = (float(one), float(five), float(fifteen))
        stats["cpus"] = os.cpu_count() or 1
    except Exception:  # noqa: BLE001
        pass

    try:
        stats["uptime"] = float(open("/proc/uptime").read().split()[0])
    except Exception:  # noqa: BLE001
        pass

    return stats


# ── The panel ────────────────────────────────────────────────────────────


def _services(p: Panel, units: dict[str, dict]) -> bool:
    p.section("SERVICES")
    all_ok = True
    for name, u in units.items():
        if not u.get("known"):
            p.row("warn", name, "not installed on this host")
            continue
        active = u.get("active", "unknown")
        ok = active == "active"
        all_ok = all_ok and ok
        note = duration(u["since"]) if ok and u.get("since") else ""
        p.row(
            "ok" if ok else "fail",
            name,
            f"{active} ({u.get('sub')})" if u.get("sub") else active,
            f"up {note}" if note else "",
        )
    return all_ok


def _application(p: Panel, status: int | None, payload: dict, error: str) -> None:
    p.section("APPLICATION")
    if status is None:
        p.row("fail", "endpoint", "unreachable", error)
        return

    reachable = status == 200
    p.row(
        "ok" if reachable else "fail",
        "endpoint",
        f"HTTP {status}",
        payload.get("status", ""),
    )
    p.row(
        "ok" if payload.get("database") == "connected" else "fail",
        "database link",
        payload.get("database", "unknown"),
    )

    app = (payload.get("vitals") or {}).get("app") or {}
    if "error" in app:
        p.row("warn", "process", f"could not be read ({app['error']})")
        return
    if app:
        # debug=True in production is a real finding, not a curiosity: it
        # turns the interactive debugger on for anyone who can reach a
        # traceback.
        env = app.get("env", "unknown")
        p.row(
            "warn" if app.get("debug") else "ok",
            "environment",
            env + ("   DEBUG IS ON" if app.get("debug") else ""),
        )
        p.row(
            None,
            "uptime",
            duration(app.get("uptime_seconds", 0)),
            f"pid {app.get('pid', '?')}",
        )


def _database(p: Panel, vitals: dict) -> None:
    db = vitals.get("database") or {}
    p.section("DATABASE")
    if not db or "error" in db:
        p.row("fail", "vitals", f"could not be read ({db.get('error', 'absent')})")
        return

    p.row("ok", "server", db.get("version", "unknown"))
    p.row(None, "size", f"{db.get('size_mb', 0):,.1f} MB")

    conns = db.get("connections") or {}
    used, cap = conns.get("used", 0), conns.get("max", 0)
    pct = (used / cap * 100) if cap else 0
    p.row(
        "warn" if pct >= 80 else "ok",
        "connections",
        f"{used} / {cap}",
        f"{pct:.0f}% of the limit" if cap else "",
    )
    p.row(None, "migrations", f"{db.get('migrations_applied', 0)} applied")
    p.row(None, "query latency", f"{db.get('latency_ms', 0)} ms")

    dur = db.get("durability") or {}
    if dur:
        # Named individually when wrong. "durability: not ok" would send
        # somebody hunting for which of the three it was.
        settings = (
            f"fsync {dur.get('fsync')} · synchronous_commit "
            f"{dur.get('synchronous_commit')} · full_page_writes "
            f"{dur.get('full_page_writes')}"
        )
        p.row(
            "ok" if dur.get("ok") else "fail",
            "durability",
            "safe" if dur.get("ok") else "AT RISK",
        )
        p.row(None, "", p.ink.dim(settings))


def _redis(p: Panel, vitals: dict) -> None:
    redis = vitals.get("redis") or {}
    p.section("REDIS")
    if "error" in redis:
        p.row("fail", "rate-limit store", f"could not be read ({redis['error']})")
        return
    if not redis.get("configured"):
        p.row("warn", "rate-limit store", "not configured")
        return
    # Worth a FAIL rather than a WARN: create_app() raises when this is
    # unreachable under FLASK_ENV=production, so the next restart is a crash
    # loop, not a degraded start.
    reachable = redis.get("reachable")
    p.row(
        "ok" if reachable else "fail",
        "rate-limit store",
        "reachable" if reachable else "UNREACHABLE",
        "" if reachable else "the next restart will fail",
    )


def _backups(p: Panel, vitals: dict) -> None:
    b = vitals.get("backups") or {}
    p.section("BACKUPS")
    if not b or "error" in b:
        p.row("fail", "vitals", f"could not be read ({b.get('error', 'absent')})")
        return

    latest = b.get("latest")
    if not latest:
        p.row("fail", "latest", "no snapshot on this disk")
    else:
        age = b.get("latest_age_hours", 0) * 3600
        checksum = b.get("latest_has_checksum")
        p.row("ok" if b.get("ok") else "warn", "latest", latest)
        p.row(
            None,
            "taken",
            f"{duration(age)} ago",
            f"{b.get('latest_size_mb', 0):,.1f} MB",
        )
        # A snapshot with no sidecar cannot be verified after a copy, which
        # makes it a file rather than a backup.
        p.row(
            "ok" if checksum else "warn",
            "checksum",
            "present" if checksum else "MISSING — cannot be verified",
        )

    p.row(None, "snapshots held", str(b.get("count", 0)))

    pending = b.get("pending_send", 0)
    if pending:
        p.row(
            "warn",
            "pending send",
            f"{pending} waiting to be mailed",
            "expected right after an outage",
        )
    partials = b.get("abandoned_partials", 0)
    if partials:
        p.row(
            "warn",
            "abandoned",
            f"{partials} part-written dumps",
            "something is killing backups mid-run",
        )


def _disk(p: Panel, vitals: dict, host: dict) -> None:
    p.section("DISK & HOST")

    backups = (vitals.get("disk") or {}).get("backups") or {}
    if backups and "error" not in backups:
        p.row(
            "ok" if backups.get("ok") else "fail",
            "backups",
            f"{gb(backups.get('free_gb', 0))} free of {gb(backups.get('total_gb', 0))}",
            f"{backups.get('free_percent', 0):.0f}% free",
        )

    root = host.get("root")
    if root:
        p.row(
            "ok" if root["free_percent"] >= ROOT_DISK_LOW_PERCENT else "fail",
            "root filesystem",
            f"{gb(root['free_gb'])} free of {gb(root['total_gb'])}",
            f"{root['free_percent']:.0f}% free",
        )

    mem = host.get("memory")
    if mem:
        p.row(
            "ok" if mem["used_percent"] < MEMORY_HIGH_PERCENT else "warn",
            "memory",
            f"{gb(mem['used_gb'])} used of {gb(mem['total_gb'])}",
            f"{mem['used_percent']:.0f}%",
        )

    load = host.get("load")
    if load:
        cpus = host.get("cpus", 1)
        # Against core count, because "load 4.0" means nothing until you know
        # whether the box has two cores or sixteen.
        p.row(
            "ok" if load[0] < cpus else "warn",
            "load",
            f"{load[0]:.2f}  {load[1]:.2f}  {load[2]:.2f}",
            f"{cpus} cpu" + ("s" if cpus != 1 else ""),
        )

    if host.get("uptime"):
        p.row(None, "host uptime", duration(host["uptime"]))


def build(
    status: int | None,
    payload: dict,
    error: str,
    units: dict[str, dict],
    host: dict,
    ink: Ink,
) -> tuple[str, int]:
    """The panel, and the exit code that goes with it."""
    p = Panel(ink)
    vitals = payload.get("vitals") or {}

    p.blank()
    p.title(
        f"MTC ERP · {socket.gethostname()}",
        time.strftime("%a %d %b %H:%M:%S %Z"),
    )

    services_ok = _services(p, units)
    _application(p, status, payload, error)

    if vitals:
        _database(p, vitals)
        _redis(p, vitals)
        _backups(p, vitals)
    _disk(p, vitals, host)

    if status is None:
        p.verdict(
            "fail",
            "The application is not answering. Start with: journalctl -u mtc -n 50",
        )
        return p.render(), 2

    if not vitals:
        p.blank()
        p.row(
            None,
            "",
            ink.dim(
                "No vitals in the payload — this caller is outside HEALTH_VITALS_SCOPE."
            ),
        )

    # app/health.py already decided what is unhappy, and it is the only thing
    # that knows the thresholds. Repeating that judgement here is how a panel
    # and its endpoint start disagreeing.
    attention = vitals.get("attention") or []
    problems = list(attention)
    if not services_ok:
        problems.append("services")
    if status != 200:
        problems.append("http")

    if problems:
        p.verdict("warn", "Wants attention: " + ", ".join(sorted(set(problems))))
        return p.render(), 1

    p.verdict("ok", "All checks passed.")
    return p.render(), 0


# ── Entry point ──────────────────────────────────────────────────────────


def collect(url: str) -> tuple[int | None, dict, str, dict, dict]:
    status, payload, error = fetch_health(url)
    return status, payload, error, unit_states(UNITS), host_stats()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="mtc-health",
        description="MTC ERP server vitals, formatted.",
    )
    ap.add_argument(
        "--json", action="store_true", help="print the raw /health payload and exit"
    )
    ap.add_argument(
        "--watch",
        nargs="?",
        const=5,
        type=float,
        metavar="SECONDS",
        help="redraw every SECONDS (default 5); Ctrl-C to stop",
    )
    ap.add_argument("--no-color", action="store_true", help="plain text")
    ap.add_argument("--url", default=HEALTH_URL, help=f"default {HEALTH_URL}")
    args = ap.parse_args(argv)

    if args.json:
        _status, payload, error, _units, _host = collect(args.url)
        if error and not payload:
            print(json.dumps({"error": error}), file=sys.stderr)
            return 2
        print(json.dumps(payload, indent=2))
        return 0

    use_colour = (
        not args.no_color
        and sys.stdout.isatty()
        and os.getenv("NO_COLOR") is None
        and os.getenv("TERM") != "dumb"
    )
    ink = Ink(use_colour)

    if args.watch is None:
        panel, code = build(*collect(args.url), ink=ink)
        print(panel)
        return code

    try:
        while True:
            panel, code = build(*collect(args.url), ink=ink)
            # Home the cursor and clear forward, rather than clearing first:
            # wiping the screen and then drawing leaves a visible flash on a
            # slow redraw, and the draw here waits on an HTTP round trip.
            sys.stdout.write("\033[H\033[J" if use_colour else "\n")
            print(panel)
            print(f"  watching · every {args.watch:g}s · Ctrl-C to stop")
            time.sleep(args.watch)
    except KeyboardInterrupt:
        print()
        return 0


if __name__ == "__main__":
    sys.exit(main())
