"""ERP blueprint package.

Ports the "Maharaja Bikes ERP" Google Apps Script app onto the MTC Flask
backend. Two blueprints:

- ``erp_bp``: HTML pages (``/erp``, ``/erp/mobile``).
- ``erp_rpc_bp``: the RPC bridge (``/api/erp/rpc/<method>``), a stand-in for
  Apps Script's ``google.script.run`` used by the ported frontend JS.
"""

from __future__ import annotations

from flask import Blueprint

erp_bp = Blueprint("erp", __name__)
erp_rpc_bp = Blueprint("erp_rpc", __name__)

from . import services  # noqa: E402,F401  (populates registry.RPC_METHODS)
from . import pages  # noqa: E402,F401  (registers routes on erp_bp)
from . import rpc  # noqa: E402,F401  (registers routes on erp_rpc_bp)

__all__ = ["erp_bp", "erp_rpc_bp"]
