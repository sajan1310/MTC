"""ERP service modules.

Importing this package registers every module's @rpc_method-decorated
functions into app.erp.registry.RPC_METHODS.
"""

from __future__ import annotations

from . import system_service  # noqa: F401
from . import units_service  # noqa: F401
from . import tags_service  # noqa: F401
from . import items_service  # noqa: F401
from . import stock_service  # noqa: F401
from . import vendors_service  # noqa: F401
from . import bill_service  # noqa: F401
from . import po_service  # noqa: F401
from . import return_service  # noqa: F401
from . import process_service  # noqa: F401

__all__ = [
    "system_service",
    "units_service",
    "tags_service",
    "items_service",
    "stock_service",
    "vendors_service",
    "bill_service",
    "po_service",
    "return_service",
    "process_service",
]
