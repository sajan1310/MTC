"""mtc-health must watch the database, not the unit standing in front of it.

On Debian and Ubuntu `postgresql.service` is an umbrella: it runs /bin/true
and stays "active (exited)" for as long as the machine is up. The server is an
instance unit, `postgresql@17-main`. On 2026-09-30 the panel said

    postgresql        active (exited)   up 18h 18m
    endpoint          HTTP 503   unhealthy

two minutes after the cluster had been restarted under the application. The
first line was the explanation for the second, and it read as "nothing has
happened to the database since yesterday".

deploy/health.py runs from the system python3 with nothing but the standard
library, so these load it by path and stand in for systemctl.
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

HEALTH_PY = Path(__file__).resolve().parents[1] / "deploy" / "health.py"


@pytest.fixture(scope="module")
def health():
    spec = importlib.util.spec_from_file_location("mtc_health", HEALTH_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _systemctl_lists(monkeypatch, health, stdout):
    def _run(cmd, **_kwargs):
        assert cmd[:2] == ["systemctl", "list-units"]
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(health.subprocess, "run", _run)


def test_the_cluster_is_watched_not_the_umbrella(health, monkeypatch):
    _systemctl_lists(
        monkeypatch,
        health,
        "postgresql@17-main.service loaded active running PostgreSQL Cluster 17-main\n",
    )

    assert health.watched_units() == (
        "postgresql@17-main",
        "redis-server",
        "nginx",
        "mtc",
    )


def test_a_cluster_that_is_down_is_still_watched(health, monkeypatch):
    """The row this exists to draw. A list of running units would drop the
    database from the panel at exactly the moment it stopped."""
    _systemctl_lists(
        monkeypatch,
        health,
        "postgresql@17-main.service loaded failed failed PostgreSQL Cluster 17-main\n",
    )

    assert "postgresql@17-main" in health.watched_units()


def test_a_dropped_cluster_is_not_mistaken_for_one(health, monkeypatch):
    """systemd keeps listing a name that something still refers to. After a
    major-version upgrade that is the old cluster, and watching it would
    report the database missing on a host where it is running."""
    _systemctl_lists(
        monkeypatch,
        health,
        "postgresql@16-main.service not-found inactive dead postgresql@16-main.service\n"
        "postgresql@17-main.service loaded active running PostgreSQL Cluster 17-main\n",
    )

    assert health.postgres_clusters() == ("postgresql@17-main",)


def test_without_cluster_units_the_plain_name_stays(health, monkeypatch):
    """Another distribution, or a container: `postgresql` is the real unit."""
    _systemctl_lists(monkeypatch, health, "")

    assert health.watched_units() == health.UNITS


def test_a_host_without_systemctl_still_gets_its_panel(health, monkeypatch):
    def _missing(*_args, **_kwargs):
        raise FileNotFoundError("systemctl")

    monkeypatch.setattr(health.subprocess, "run", _missing)

    assert health.watched_units() == health.UNITS
