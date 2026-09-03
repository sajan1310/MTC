"""The container does not run as root (DEPLOY-001).

The image ran everything as uid 0: the migrations, gunicorn, and therefore
every request handler. A file-write bug, a dependency with a deserialisation
flaw or a template injection would all have executed as root inside the
container -- and with the default Docker configuration, uid 0 in the
container is uid 0 on the host for anything bind-mounted.

The systemd unit has always run as the `mtc` user. This is the Docker path
catching up, and these tests keep it caught up: a `USER` directive is one
line, and one line is easy to lose in a rebase.

Parsing the Dockerfile as text rather than building it: a build needs a
daemon and several minutes, neither of which belongs in a unit test, and the
properties worth pinning here are all lexical.
"""

from __future__ import annotations

import pathlib
import re

import pytest
import yaml

PROJECT_ROOT = pathlib.Path(__file__).parent.parent
DOCKERFILE = PROJECT_ROOT / "Dockerfile"
COMPOSE = PROJECT_ROOT / "docker-compose.yml"


@pytest.fixture(scope="module")
def dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _instructions(text):
    """(instruction, argument) pairs, with line continuations joined."""
    joined = re.sub(r"\\\s*\n\s*", " ", text)
    for line in joined.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        yield parts[0].upper(), (parts[1] if len(parts) > 1 else "")


# ── The user ─────────────────────────────────────────────────────────────


def test_the_image_declares_a_non_root_user(dockerfile):
    users = [arg.strip() for name, arg in _instructions(dockerfile) if name == "USER"]
    assert users, "no USER directive: the container runs as root"
    assert users[-1] not in ("root", "0"), users


def test_the_user_exists_before_it_is_switched_to(dockerfile):
    """USER against an account no one created fails at run time, not build
    time -- so the image builds green and then will not start."""
    text = dockerfile
    assert "useradd" in text, "USER is set but no account is created"
    assert text.index("useradd") < text.rindex("\nUSER "), (
        "USER appears before the account is created"
    )


def test_the_application_directory_is_owned_by_that_user(dockerfile):
    """Otherwise the process cannot write anything under /app -- uploads,
    caches, the SQLite-ish scratch files some libraries make -- and the
    failures surface as unrelated permission errors at run time."""
    assert re.search(r"chown\s+-R\s+mtc:mtc\s+/app", dockerfile), dockerfile


def test_the_uid_is_pinned(dockerfile):
    """An unpinned --system uid shifts with the base image's counter, so a
    bind-mounted volume's ownership silently changes between rebuilds."""
    assert re.search(r"--uid\s+10001", dockerfile)
    assert re.search(r"--gid\s+10001", dockerfile)


def test_the_account_cannot_log_in(dockerfile):
    assert "--shell /usr/sbin/nologin" in dockerfile


# ── What a non-root user then needs ──────────────────────────────────────


def test_the_backup_directory_is_writable_by_that_user(dockerfile):
    """get_backup_dir()'s "four directories up" computation resolves to
    `/backups` in this image -- the filesystem root. That was writable only
    because the container ran as root; uid 10001 cannot create it, and
    triggerBackup would fail with a PermissionError.

    So the image both creates the directory and points BACKUP_DIR at it.
    Dropping either half re-breaks backups in Docker, and only in Docker,
    which is the kind of thing nobody notices until they need a restore."""
    env = " ".join(arg for name, arg in _instructions(dockerfile) if name == "ENV")
    assert "BACKUP_DIR=/app/backups" in env, "BACKUP_DIR is not set"
    assert re.search(r"mkdir\s+-p\s+/app/backups", dockerfile), (
        "BACKUP_DIR is set but the directory is never created"
    )


def test_a_home_is_provided(dockerfile):
    """WeasyPrint writes a font cache and gunicorn wants a temp directory;
    both default to $HOME, which a --no-create-home account does not have."""
    env = " ".join(arg for name, arg in _instructions(dockerfile) if name == "ENV")
    assert "HOME=" in env


def test_get_backup_dir_honours_the_configured_path(tmp_path, app):
    """The other half of the same fix, in the code rather than the image."""
    from app.erp.services.backup_service import get_backup_dir

    target = tmp_path / "snapshots"
    app.config["BACKUP_DIR"] = str(target)
    with app.app_context():
        assert get_backup_dir() == str(target)
    assert target.is_dir(), "the directory should be created if absent"


def test_get_backup_dir_falls_back_when_nothing_is_configured(app, monkeypatch):
    """The systemd deployment sets nothing and must keep its existing path."""
    from app.erp.services.backup_service import get_backup_dir

    monkeypatch.delenv("BACKUP_DIR", raising=False)
    app.config["BACKUP_DIR"] = None
    with app.app_context():
        resolved = get_backup_dir()
    assert resolved.replace("\\", "/").endswith("/backups")


# ── Backups survive the container ────────────────────────────────────────


def test_backups_are_on_a_volume():
    """Without this they live in the container's writable layer and are
    destroyed by the next `docker compose up --build` -- precisely the moment
    you would want one."""
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    mounts = compose["services"]["app"].get("volumes") or []
    assert any(str(m).endswith(":/app/backups") for m in mounts), mounts

    named = str(next(m for m in mounts if str(m).endswith(":/app/backups"))).split(":")[
        0
    ]
    assert named in (compose.get("volumes") or {}), (
        f"{named} is mounted but not declared under top-level volumes"
    )
