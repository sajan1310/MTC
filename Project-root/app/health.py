"""Vitals for /health.

`/health` itself is public, unauthenticated and rate-limit exempt, because a
load balancer and an uptime monitor both have to reach it without
credentials. Its documented contract is three keys and it stays three keys
for anyone out on the network:

    {"status": ..., "database": ..., "timestamp": ...}

Everything in this module is the OTHER answer -- the one an operator wants
when they are sitting on the box asking "is all of this actually working?".
It is attached only for callers who have earned it (see should_expose), for
the same reason the existing code logs psycopg2 errors instead of returning
them: those errors quote the DSN, which carries the database host, user and
password.

Each section is independently guarded. A vital that cannot be read reports
its own error and the rest still answer -- the point of a status panel is to
work on the day something is broken, which is the day a half-broken one would
throw instead.
"""

from __future__ import annotations

import os
import shutil
import time

from flask import current_app, request

import database

_PROCESS_START = time.time()

# Beyond this, a snapshot is too old to be reassuring. The nightly job runs
# every 24h, so anything past 36 warrants a look rather than a shrug.
BACKUP_STALE_HOURS = float(os.getenv("HEALTH_BACKUP_STALE_HOURS", "36"))

# Below this, the disk is close enough to full to be the next outage. The
# backup directory filling is not hypothetical here: abandoned .partial dumps
# used to accumulate one per power cut, and a full disk stops PostgreSQL
# writing WAL.
DISK_LOW_PERCENT = float(os.getenv("HEALTH_DISK_LOW_PERCENT", "10"))


def _client_ip() -> str:
    """The real caller, whether or not ProxyFix happens to be configured.

    nginx sets X-Forwarded-For with $proxy_add_x_forwarded_for, which APPENDS
    the connecting address -- so the last entry is the client nginx actually
    talked to, and is the only one a caller cannot forge by sending their own
    header. Falling back to remote_addr covers a direct hit on gunicorn.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.remote_addr or ""


# Spelled out rather than deferred to ipaddress.is_private, which is NOT
# stable across the interpreters this runs on: Python 3.12 widened it to the
# IANA special-purpose registry, so the RFC 5737 documentation ranges
# (192.0.2/24, 198.51.100/24, 203.0.113/24) count as private on 3.13 and do
# not on 3.10. CI tests 3.10-3.12 and production runs 3.12, so leaving this
# to the standard library would mean the same request being answered
# differently depending on which Python happened to be installed.
_PRIVATE_NETWORKS = (
    "127.0.0.0/8",  # loopback
    "10.0.0.0/8",  # RFC1918
    "172.16.0.0/12",  # RFC1918
    "192.168.0.0/16",  # RFC1918
    "169.254.0.0/16",  # link-local
    "100.64.0.0/10",  # CGNAT -- this is where Tailscale lives
    "::1/128",
    "fc00::/7",  # unique local
    "fe80::/10",  # link-local
)


def _is_private(ip: str) -> bool:
    """Loopback, RFC1918, link-local, or the Tailscale range.

    100.64.0.0/10 is the point of this list, not an afterthought: remote
    access to this server is a tailnet, so excluding CGNAT space would make
    the vitals unreadable from anywhere except a shell on the box.
    """
    import ipaddress

    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for network in _PRIVATE_NETWORKS:
        net = ipaddress.ip_network(network)
        if addr.version == net.version and addr in net:
            return True
    return False


def should_expose() -> bool:
    """Whether this caller may see the vitals.

    /health is public, unauthenticated and rate-limit exempt, because a load
    balancer and an uptime monitor both have to reach it without credentials.
    Its three documented keys therefore stay available to everyone, and this
    decides only whether the richer payload rides along.

    HEALTH_VITALS_SCOPE picks the rule:

      local    loopback only -- a shell on the machine
      private  loopback, RFC1918 and the Tailscale 100.64/10 range (DEFAULT).
               This site reaches the server over a tailnet and over the LAN,
               and the operator wants the vitals from both.
      all      anyone who can route to the app

    An admin session or the METRICS_TOKEN bearer always qualifies, whatever
    the scope -- the same rule app/metrics.py already applies to the same
    class of information.

    Note what "private" is really buying: not much against someone already on
    the factory LAN, but it does mean a box that ends up with a public address
    does not start narrating its disk usage to the internet. Nothing here is a
    credential either way -- the DSN never appears, by construction and by
    test.
    """
    try:
        from app.metrics import _authorised

        if _authorised():
            return True
    except Exception:  # noqa: BLE001 -- fall through to the address check
        pass

    scope = (
        (
            current_app.config.get("HEALTH_VITALS_SCOPE")
            or os.getenv("HEALTH_VITALS_SCOPE")
            or "private"
        )
        .strip()
        .lower()
    )

    if scope == "all":
        return True
    ip = _client_ip()
    if scope == "local":
        return ip in ("127.0.0.1", "::1", "localhost")
    return _is_private(ip)


def _disk(path: str) -> dict:
    usage = shutil.disk_usage(path)
    free_pct = round(usage.free / usage.total * 100, 1) if usage.total else 0.0
    return {
        "path": path,
        "free_gb": round(usage.free / 1024**3, 2),
        "total_gb": round(usage.total / 1024**3, 2),
        "free_percent": free_pct,
        "ok": free_pct >= DISK_LOW_PERCENT,
    }


def _app_section() -> dict:
    return {
        "env": current_app.config.get("ENV_NAME") or os.getenv("FLASK_ENV", "unknown"),
        "uptime_seconds": int(time.time() - _PROCESS_START),
        "pid": os.getpid(),
        "debug": bool(current_app.debug),
    }


def _database_section() -> dict:
    started = time.perf_counter()
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT version()")
        version = (cur.fetchone()[0] or "").split(" on ")[0]
        cur.execute("SELECT pg_database_size(current_database())")
        size_bytes = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM pg_stat_activity")
        used = int(cur.fetchone()[0])
        cur.execute("SHOW max_connections")
        max_conn = int(cur.fetchone()[0])
        # The three settings that decide whether a power cut costs data. They
        # are on by default and provision.sh does not touch them -- but a
        # well-meaning edit to make the box "faster" is exactly how they get
        # turned off, and nothing else would notice until the day it matters.
        cur.execute("SHOW fsync")
        fsync = cur.fetchone()[0]
        cur.execute("SHOW synchronous_commit")
        sync_commit = cur.fetchone()[0]
        cur.execute("SHOW full_page_writes")
        full_page = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM erp.migrations_applied")
        migrations = int(cur.fetchone()[0])

    durable = (
        fsync == "on" and sync_commit in ("on", "remote_apply") and full_page == "on"
    )
    return {
        "version": version,
        "size_mb": round(size_bytes / 1024**2, 1),
        "connections": {"used": used, "max": max_conn},
        "migrations_applied": migrations,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "durability": {
            "fsync": fsync,
            "synchronous_commit": sync_commit,
            "full_page_writes": full_page,
            "ok": durable,
        },
    }


def _redis_section() -> dict:
    """Not decorative: create_app() RAISES when this is unreachable under
    FLASK_ENV=production, so a Redis that dies makes the next restart a crash
    loop rather than a degraded start."""
    url = current_app.config.get("RATELIMIT_STORAGE_URL") or ""
    if not url.startswith(("redis://", "rediss://")):
        return {"configured": False}
    from redis import Redis

    client = Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
    try:
        client.ping()
        return {"configured": True, "reachable": True}
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def _backups_section() -> dict:
    from app.erp.services import backup_service

    backup_dir = backup_service.get_backup_dir()
    names = [
        n
        for n in os.listdir(backup_dir)
        if n.startswith("mtc_") and n.endswith(".dump")
    ]
    pending = [n for n in os.listdir(backup_dir) if n.endswith(".pending-send")]
    partials = [n for n in os.listdir(backup_dir) if n.endswith(".dump.partial")]

    section: dict = {
        "count": len(names),
        # Snapshots taken during an outage that have not been mailed yet.
        # Non-zero after a power cut is expected; non-zero for days is not.
        "pending_send": len(pending),
        # Orphans from a run killed mid-dump. These are reaped automatically;
        # a growing number means something is killing backups repeatedly.
        "abandoned_partials": len(partials),
    }
    if not names:
        section["latest"] = None
        section["ok"] = False
        return section

    latest = max(names)
    latest_path = os.path.join(backup_dir, latest)
    age_hours = (time.time() - os.path.getmtime(latest_path)) / 3600
    section["latest"] = latest
    section["latest_age_hours"] = round(age_hours, 1)
    section["latest_size_mb"] = round(os.path.getsize(latest_path) / 1024**2, 2)
    # A snapshot with no sidecar cannot be verified after a copy, which makes
    # it a file rather than a backup.
    section["latest_has_checksum"] = os.path.isfile(latest_path + ".sha256")
    section["ok"] = age_hours <= BACKUP_STALE_HOURS and section["latest_has_checksum"]
    return section


_SECTIONS = {
    "app": _app_section,
    "database": _database_section,
    "redis": _redis_section,
    "backups": _backups_section,
}


def collect() -> dict:
    """Every vital, with per-section failure isolation.

    Returns a dict that always has the same shape. A section that raises is
    replaced by {"error": ...} rather than taking the whole response with it.
    """
    vitals: dict = {}
    for name, collector in _SECTIONS.items():
        try:
            vitals[name] = collector()
        except Exception as exc:  # noqa: BLE001 -- see the module docstring
            # The TYPE only, never the message. psycopg2 spells its failures
            # "connection to server at 'db.internal' failed: password
            # authentication failed for user 'mtc_prod'" -- host, user and
            # password in one string. This payload is gated, and "gated" is
            # still not a reason to put a password in a JSON response; the
            # detail goes to the log, where the rest of this app already
            # sends it. tests/test_smoke.py asserts exactly this.
            current_app.logger.warning(
                "Health vital %r failed: %s: %s", name, type(exc).__name__, exc
            )
            vitals[name] = {"error": type(exc).__name__}

    try:
        from app.erp.services import backup_service

        vitals["disk"] = {
            "backups": _disk(backup_service.get_backup_dir()),
        }
    except Exception as exc:  # noqa: BLE001 -- same reasoning as above
        current_app.logger.warning(
            "Health vital 'disk' failed: %s: %s", type(exc).__name__, exc
        )
        vitals["disk"] = {"error": type(exc).__name__}

    # One line an operator can read without parsing the rest: anything that
    # knows how to say whether it is happy, and is not.
    unhappy = []
    for name, section in vitals.items():
        if not isinstance(section, dict):
            continue
        if "error" in section:
            unhappy.append(name)
        elif section.get("ok") is False:
            unhappy.append(name)
        elif (
            isinstance(section.get("durability"), dict)
            and not section["durability"]["ok"]
        ):
            unhappy.append("database.durability")
        elif isinstance(section.get("backups"), dict) and not section["backups"].get(
            "ok", True
        ):
            unhappy.append("disk.backups")
    vitals["attention"] = unhappy or None
    return vitals
