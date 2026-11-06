"""Keeps an idle worker's memory in use, so the day's first loads are not the
ones that wait for it to come back.

Measured on the production server (2026-11-04 and 2026-11-06): the Windows
host does not keep memory the VM has left alone resident. After a night with
no use, the morning's first loads took 20-117 s -- getProductionData 60-80 s,
getMobileDashboard 117 s, a sign-in 28 s -- while the guest's two CPUs sat
~90% idle, with no swapping and no disk reads: the requests were waiting for
the host to bring their memory back. Gaps of up to ~4 hours left the next
loads at normal speed (0.3-4 s); only the 9-14 hour overnight gaps stalled.

Something running is not enough; it has to be the memory the morning uses.
The hourly ledger audit ran all through that night, but it reads bills, POs
and returns, in whichever worker takes its lock. Production, items and stock,
the paths that stalled, had gone untouched for 14 hours in every worker.

So a worker that has served nothing for IDLE_SECONDS runs the reads a
morning starts with -- production, items, process master, the dashboard
(which also reads stock) -- then a full garbage collection, and again every
IDLE_SECONDS while it stays idle. That touches the memory those requests
will touch, in the worker that will serve them, and the database pages
under them. A worker in use is warm already and is left alone. Each pass
costs a few seconds of CPU, all of it while nobody is using that worker.

This is a workaround, not the cure. The cure is on the host -- keep all of
the VM's memory resident (VMware Workstation: Preferences > Memory, "Fit all
virtual machine memory into reserved host RAM"; MemTrimRate = "0" in the
.vmx), or give the host more RAM. KEEP_WARM_IDLE_SECONDS=0 turns this off.
"""

from __future__ import annotations

import gc
import os
import threading
import time

# Idle this long, a worker warms itself; idle on, it warms again this often.
# An hour is well inside the ~4 hours that were measured to stay warm.
IDLE_SECONDS = int(os.environ.get("KEEP_WARM_IDLE_SECONDS", "3600"))
_CHECK_SECONDS = 300

# Requests that touch almost nothing, and so say nothing about whether the
# worker's working set is still in use: a monitoring probe hitting /health
# every minute must not keep a worker "busy" forever while it goes cold.
_NOT_USE = ("/health", "/metrics", "/static/")

_last_use = time.monotonic()


def note_request() -> None:
    """before_request: this worker has just been used."""
    from flask import request

    global _last_use
    if not request.path.startswith(_NOT_USE):
        _last_use = time.monotonic()


def warm(app) -> float:
    """One pass of the reads a working morning begins with. Returns seconds."""
    from .services import dashboard_service
    from .services import items_service
    from .services import process_service
    from .services import production_service

    started = time.monotonic()
    with app.app_context():
        production_service.get_production_data()
        items_service.get_items_data()
        process_service.get_process_data()
        dashboard_service.get_dashboard_data()
    gc.collect()
    return time.monotonic() - started


def _due(now: float, warmed_at: float) -> bool:
    return now - _last_use >= IDLE_SECONDS and now - warmed_at >= IDLE_SECONDS


def _loop(app, stop: threading.Event) -> None:
    warmed_at = time.monotonic()
    while not stop.wait(_CHECK_SECONDS):
        if not _due(time.monotonic(), warmed_at):
            continue
        try:
            took = warm(app)
            app.logger.info("[keep_warm] idle worker warmed in %.1f s", took)
        except Exception:  # noqa: BLE001 -- must never kill the thread
            app.logger.warning("[keep_warm] warming failed", exc_info=True)
        warmed_at = time.monotonic()


def start(app) -> None:
    """Start the thread for this worker, from create_app()."""
    if IDLE_SECONDS <= 0 or app.config.get("TESTING"):
        return
    # The outer Werkzeug reloader process serves nothing.
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    app.before_request(note_request)
    threading.Thread(
        target=_loop,
        args=(app, threading.Event()),
        daemon=True,
        name="keep-warm",
    ).start()
