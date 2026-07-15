"""ERP service modules.

Importing this package registers every module's @rpc_method-decorated
functions into app.erp.registry.RPC_METHODS.
"""

from __future__ import annotations

from . import system_service  # noqa: F401
from . import units_service  # noqa: F401
from . import tags_service  # noqa: F401
from . import items_service  # noqa: F401

__all__ = ["system_service", "units_service", "tags_service", "items_service"]
