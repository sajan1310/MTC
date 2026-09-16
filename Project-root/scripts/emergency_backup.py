#!/usr/bin/env python3
"""Take a snapshot right now and get a copy off the machine.

Invoked by deploy/ups-notify.sh the moment the UPS reports mains failure,
and runnable by hand:

    python scripts/emergency_backup.py            # dump, verify, mail it
    python scripts/emergency_backup.py --dry-run  # prove the wiring, send nothing
    python scripts/emergency_backup.py --latest   # mail the newest existing dump

Deliberately NOT triggered at low battery
-----------------------------------------
The obvious design -- "when the battery is nearly gone, save everything" --
is backwards. At LOWBATT there are minutes of power left and the only
correct action is to shut down cleanly; starting a dump and an internet
upload then DELAYS that shutdown and can cause the hard crash the UPS was
bought to prevent. Worse, by then the site's router is often already dark,
so the send blocks until its timeout while the battery drains.

So this runs at ONBATT instead: the instant mains fails, when the battery is
still full and the network is most likely still up. deploy/ups-notify.sh
kills any run still in flight when LOWBATT arrives.

Exit codes, which the handler distinguishes
-------------------------------------------
    0  snapshot written, verified, and sent
    1  snapshot written and verified, but sending failed
    2  no snapshot -- the only genuinely bad outcome
    3  nothing configured to send to

1 is not a failure worth panicking about. The local snapshot is the thing
that mattered; deploy/offsite-pull.sh will collect it later.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

logger = logging.getLogger("emergency_backup")


def _load_dotenv_if_present() -> None:
    """Match how config.py resolves settings.

    The handler runs from systemd or upsmon, which give a process almost no
    environment at all, so the .env the rest of the application relies on has
    to be loaded explicitly here or MAIL_SERVER and the database settings are
    simply absent.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    for candidate in (
        os.path.join(_PROJECT_ROOT, ".env"),
        "/etc/mtc/mtc.env",
    ):
        if os.path.isfile(candidate):
            load_dotenv(candidate, override=False)


def _backup_dir() -> str:
    """Where snapshots live, resolved exactly as the nightly job resolves it.

    backup_service owns this (BACKUP_DIR, else four levels up from the
    service module, which lands beside the checkout rather than inside it).
    Imported rather than reimplemented: two copies of that computation would
    drift, and a copy that drifts writes the emergency snapshot somewhere
    offsite-pull.sh is not looking. Importing the module does not boot the
    app -- get_backup_dir() catches the missing app context itself.
    """
    from app.erp.services import backup_service

    return backup_service.get_backup_dir()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build everything and send nothing. Use for the UPS rehearsal.",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Mail the newest existing snapshot instead of taking a new one.",
    )
    parser.add_argument("--to", default=None, help="Override the recipient.")
    parser.add_argument(
        "--no-send",
        action="store_true",
        help=(
            "Take the snapshot and do not attempt to mail it. For the mains-"
            "failure path, where the modem is already dead: trying would burn "
            "the SMTP timeout against a battery for a message that cannot "
            "leave the building."
        ),
    )
    parser.add_argument(
        "--reason",
        default="manual",
        help="What triggered this (ONBATT, manual, ...). Appears in the subject.",
    )
    parser.add_argument(
        "--budget",
        type=int,
        default=int(os.getenv("EMERGENCY_BACKUP_BUDGET", "180")),
        help="Seconds this whole run may take before it stops trying (default 180).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [emergency-backup] %(message)s",
        datefmt="%H:%M:%S",
    )
    _load_dotenv_if_present()

    started = time.monotonic()
    deadline = started + args.budget

    from app.erp.services import backup_mail, db_backup

    backup_dir = _backup_dir()

    # ── 1. Get a snapshot ────────────────────────────────────────────────
    if args.latest:
        existing = sorted(
            f
            for f in os.listdir(backup_dir)
            if f.startswith("mtc_") and f.endswith(".dump")
        )
        if not existing:
            logger.error("No existing snapshot to send and --latest was given.")
            return 2
        snapshot_path = os.path.join(backup_dir, existing[-1])
        size = os.path.getsize(snapshot_path)
        logger.info("Using existing snapshot %s (%s bytes)", existing[-1], f"{size:,}")
    else:
        logger.info("Taking an emergency snapshot (reason=%s)", args.reason)
        try:
            snapshot = db_backup.create_snapshot(backup_dir)
        except Exception as exc:  # noqa: BLE001
            logger.error("Snapshot FAILED: %s", exc)
            return 2
        snapshot_path = snapshot.path
        logger.info(
            "Snapshot verified: %s (%s bytes, %d tables) in %.1fs",
            os.path.basename(snapshot_path),
            f"{snapshot.size_bytes:,}",
            snapshot.table_count,
            time.monotonic() - started,
        )

    # ── 2. Get it off the machine ────────────────────────────────────────
    if args.no_send:
        # Leave a marker so a later run -- at the next boot, when the network
        # is back by definition -- can tell that this snapshot was taken
        # during an outage and still owes its off-site copy.
        try:
            with open(snapshot_path + ".pending-send", "w", encoding="utf-8") as fh:
                fh.write(f"{args.reason}\n")
        except OSError as exc:
            logger.warning("Could not mark %s as pending send: %s", snapshot_path, exc)
        logger.info(
            "Snapshot written; not sending (--no-send). Marked pending so it "
            "can be mailed once the network is back."
        )
        return 0

    if not backup_mail.is_configured(args.to):
        logger.warning(
            "Snapshot is written but nothing is configured to send it to "
            "(set MAIL_SERVER and EMERGENCY_BACKUP_TO). It stays local."
        )
        return 3

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        logger.error(
            "Budget of %ds spent before sending. The snapshot is written and "
            "verified locally.",
            args.budget,
        )
        return 1

    host_note = f"{args.reason} trigger"
    try:
        result = backup_mail.email_snapshot(
            snapshot_path,
            to=args.to,
            subject=(
                f"[MTC] Emergency snapshot "
                f"{os.path.basename(snapshot_path)} ({host_note})"
            ),
            dry_run=args.dry_run,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("%s", exc)
        logger.error(
            "The snapshot itself is written and verified at %s -- "
            "offsite-pull.sh will collect it.",
            snapshot_path,
        )
        return 1

    logger.info(
        "%s %s (%s bytes) to %s in %.1fs total",
        "Would send" if args.dry_run else "Sent",
        result.attachment,
        f"{result.size_bytes:,}",
        result.to,
        time.monotonic() - started,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
