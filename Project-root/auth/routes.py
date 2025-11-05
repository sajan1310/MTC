"""Compat shim: expose old import path auth.routes by re-exporting new module.

This allows tests and any legacy imports like:
    from auth.routes import get_google_provider_cfg
to continue working by forwarding to app.auth.routes.
"""

# Re-export everything from the new blueprint module
from app.auth.routes import *  # noqa: F401,F403

# Provide a name that may be expected in legacy code
try:
    pass  # type: ignore
except Exception:  # pragma: no cover - defensive fallback
    pass
