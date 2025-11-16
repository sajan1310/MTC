import os
import sys

from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from flask import Flask, redirect, render_template, session, url_for
from flask_login import (
    LoginManager,
    UserMixin,
    """
    DEPRECATED RUNNER

    This top-level `app.py` file was a legacy convenience runner kept for
    backwards compatibility. The project now centralizes the runnable package
    and runner in `Project-root/run.py`. To avoid accidental usage please run:

        python Project-root/run.py

    Or from repository root (recommended):

        python .\Project-root\run.py

    This file is intentionally left as a deprecation shim. Do not rely on it
    — the canonical runner is `Project-root/run.py`.
    """
"""
DEPRECATED RUNNER

This top-level `app.py` file was a legacy convenience runner kept for
backwards compatibility. The project now centralizes the runnable package
and runner in `Project-root/run.py`. To avoid accidental usage please run:

    python Project-root/run.py

Or from repository root (recommended):

    python .\Project-root\run.py

This file is intentionally left as a deprecation shim. Do not rely on it
— the canonical runner is `Project-root/run.py`.
"""

import sys

sys.exit("Legacy top-level runner disabled. Use Project-root/run.py instead.")

