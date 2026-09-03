"""Operational metrics in Prometheus exposition format (OBS-002).

The audit found no metrics, no APM and no `pg_stat_statements`: the only way
to know the application was unwell was for someone to notice it was unwell.

What this deliberately does NOT expose, and why
-----------------------------------------------
Request counters and latency histograms.

Gunicorn runs 4 workers by default (`WEB_CONCURRENCY`), all behind one port.
A scrape reaches exactly one of them, chosen by the OS, so a per-worker
request counter reports a random ~quarter of the traffic and jumps
erratically between scrapes as different workers answer. A dashboard built on
that is not approximately right; it is confidently wrong, which is worse than
having no dashboard -- and is precisely the class of defect this whole audit
has been about.

Doing it properly needs `prometheus_client`'s multiprocess mode: a new runtime
dependency, a shared writable directory, `PROMETHEUS_MULTIPROC_DIR`, and a
gunicorn `child_exit` hook to reap dead workers' files. That is a deployment
decision, not a code one. Until it is made, request rates are already
available -- accurately -- from the reverse proxy's access log, which sees
every request exactly once.

What it exposes instead is everything that is CORRECT no matter which worker
answers:

  * database-wide gauges, read live from Postgres. Identical from any worker
    by construction, and they cover this application's actual failure modes:
    connection exhaustion, a mutation backlog, migration drift, and the
    over-allocated warehouse rows DATA-002 is about.

  * per-process gauges, labelled with the worker pid so they are never
    silently summed as though they were global.

Access
------
Not public. The body names internal tables and counts, and an unauthenticated
endpoint that reveals whether the mutation backlog is growing is a reconnaissance
gift. Requires either an admin session or a bearer token (`METRICS_TOKEN`),
the latter so a scraper needs no login.
"""

from __future__ import annotations

import os
import time

from flask import Blueprint, Response, current_app, request
from flask_login import current_user

import database

metrics_bp = Blueprint("metrics", __name__)

_PROCESS_START = time.time()


def _authorised() -> bool:
    """An admin session, or the scrape token."""
    token = current_app.config.get("METRICS_TOKEN") or os.getenv("METRICS_TOKEN")
    if token:
        header = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if header.startswith(prefix):
            import hmac

            # compare_digest: a plain == leaks the token's length and its
            # matching prefix through timing, and this endpoint is reachable
            # by anyone who can route to the app.
            if hmac.compare_digest(header[len(prefix) :], token):
                return True

    try:
        if current_user.is_authenticated and getattr(current_user, "role", None) in (
            "admin",
            "super_admin",
        ):
            return True
    except Exception:  # noqa: BLE001 -- no login context is simply "not authorised"
        pass
    return False


def _line(name: str, value, labels: dict | None = None) -> str:
    if labels:
        rendered = ",".join(
            # A label value with a quote or backslash breaks the exposition
            # format; none of the values here can contain one, but escaping
            # is cheaper than relying on that staying true.
            f'{k}="{str(v).replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"'
            for k, v in labels.items()
        )
        return f"{name}{{{rendered}}} {value}"
    return f"{name} {value}"


def _database_gauges() -> list[str]:
    """Gauges that read the same from any worker."""
    out: list[str] = []
    try:
        with database.get_conn() as (_conn, cur):
            # Server-side connection count: the number that actually matters
            # when the pool starts raising PoolError. Counted per state so a
            # pile of idle-in-transaction sessions -- the shape a leaked
            # transaction takes -- is visible rather than averaged away.
            cur.execute(
                "SELECT state, count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() GROUP BY state"
            )
            out.append("# HELP mtc_db_connections Server-side connections by state.")
            out.append("# TYPE mtc_db_connections gauge")
            for state, count in cur.fetchall():
                out.append(
                    _line("mtc_db_connections", count, {"state": state or "unknown"})
                )

            cur.execute("SHOW max_connections")
            out.append("# HELP mtc_db_max_connections Postgres max_connections.")
            out.append("# TYPE mtc_db_max_connections gauge")
            out.append(_line("mtc_db_max_connections", int(cur.fetchone()[0])))

            # An in_progress row older than a few minutes means a request died
            # holding a claim. One is noise; a rising count is a symptom.
            cur.execute(
                "SELECT count(*) FROM erp.rpc_mutations WHERE status = 'in_progress'"
            )
            out.append("# HELP mtc_mutations_in_progress Unfinished mutation claims.")
            out.append("# TYPE mtc_mutations_in_progress gauge")
            out.append(_line("mtc_mutations_in_progress", cur.fetchone()[0]))

            cur.execute("SELECT count(*) FROM erp.rpc_mutations")
            out.append("# HELP mtc_mutations_total Rows in the idempotency table.")
            out.append("# TYPE mtc_mutations_total gauge")
            out.append(_line("mtc_mutations_total", cur.fetchone()[0]))

            cur.execute("SELECT count(*) FROM erp.migrations_applied")
            out.append("# HELP mtc_migrations_applied Migrations recorded as applied.")
            out.append("# TYPE mtc_migrations_applied gauge")
            out.append(_line("mtc_migrations_applied", cur.fetchone()[0]))

            # DATA-002's invariant, as a number you can alert on. The advisory
            # locks stop new violations; this says whether the existing ones
            # are being worked down or added to.
            cur.execute(
                "SELECT count(*), COALESCE(sum(available_qty), 0) "
                "FROM erp.warehouse_pool WHERE available_qty < 0"
            )
            rows, shortfall = cur.fetchone()
            out.append(
                "# HELP mtc_warehouse_pool_negative_rows Pool rows consumed beyond production."
            )
            out.append("# TYPE mtc_warehouse_pool_negative_rows gauge")
            out.append(_line("mtc_warehouse_pool_negative_rows", rows))
            out.append(
                "# HELP mtc_warehouse_pool_shortfall_units Total units over-allocated."
            )
            out.append("# TYPE mtc_warehouse_pool_shortfall_units gauge")
            out.append(
                _line("mtc_warehouse_pool_shortfall_units", abs(float(shortfall)))
            )

            cur.execute(
                "SELECT count(*) FROM users WHERE deleted_at IS NULL "
                "AND role IN ('admin', 'super_admin')"
            )
            out.append(
                "# HELP mtc_admin_accounts Active admin and super_admin accounts."
            )
            out.append("# TYPE mtc_admin_accounts gauge")
            out.append(_line("mtc_admin_accounts", cur.fetchone()[0]))

            out.append(
                "# HELP mtc_database_up Whether the database answered this scrape."
            )
            out.append("# TYPE mtc_database_up gauge")
            out.append(_line("mtc_database_up", 1))
    except Exception as exc:  # noqa: BLE001
        # A scrape must never 500: the endpoint's own failure is itself a
        # signal, and it is reported as one.
        current_app.logger.error("Metrics: database gauges failed: %s", exc)
        out.append("# HELP mtc_database_up Whether the database answered this scrape.")
        out.append("# TYPE mtc_database_up gauge")
        out.append(_line("mtc_database_up", 0))
    return out


def _process_gauges() -> list[str]:
    """Per-worker values, labelled so they are never mistaken for global."""
    worker = str(os.getpid())
    out = [
        "# HELP mtc_worker_uptime_seconds Seconds since this worker started.",
        "# TYPE mtc_worker_uptime_seconds gauge",
        _line(
            "mtc_worker_uptime_seconds",
            round(time.time() - _PROCESS_START, 1),
            {"worker": worker},
        ),
        "# HELP mtc_worker_pool_initialised Whether this worker holds a connection pool.",
        "# TYPE mtc_worker_pool_initialised gauge",
        _line(
            "mtc_worker_pool_initialised",
            1 if database.db_pool else 0,
            {"worker": worker},
        ),
    ]

    pool = database.db_pool
    if pool is not None:
        # psycopg2's pool exposes these as private attributes and has no
        # public accessor. Read defensively: a version bump that renames them
        # should cost these two gauges, not the whole scrape.
        used = getattr(pool, "_used", None)
        free = getattr(pool, "_pool", None)
        if used is not None:
            out += [
                "# HELP mtc_worker_pool_in_use Connections this worker has checked out.",
                "# TYPE mtc_worker_pool_in_use gauge",
                _line("mtc_worker_pool_in_use", len(used), {"worker": worker}),
            ]
        if free is not None:
            out += [
                "# HELP mtc_worker_pool_idle Connections this worker holds idle.",
                "# TYPE mtc_worker_pool_idle gauge",
                _line("mtc_worker_pool_idle", len(free), {"worker": worker}),
            ]
    return out


@metrics_bp.route("/metrics")
def metrics():
    if not _authorised():
        # 404, not 401: an unauthenticated prober learns nothing about
        # whether the endpoint exists.
        return Response("Not Found\n", status=404, mimetype="text/plain")

    body = "\n".join(_database_gauges() + _process_gauges()) + "\n"
    return Response(body, mimetype="text/plain; version=0.0.4; charset=utf-8")
