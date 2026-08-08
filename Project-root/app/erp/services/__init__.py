"""ERP service modules.

Importing this package registers every module's @rpc_method-decorated
functions into app.erp.registry.RPC_METHODS.
"""

from __future__ import annotations

from . import system_service  # noqa: F401
from . import company_settings_service  # noqa: F401
from . import units_service  # noqa: F401
from . import tags_service  # noqa: F401
from . import items_service  # noqa: F401
from . import stock_service  # noqa: F401
from . import vendors_service  # noqa: F401
from . import bill_service  # noqa: F401
from . import po_service  # noqa: F401
from . import return_service  # noqa: F401
from . import process_service  # noqa: F401
from . import wastage_service  # noqa: F401
from . import issue_service  # noqa: F401
from . import bom_service  # noqa: F401
from . import contractors_service  # noqa: F401
from . import warehouse_service  # noqa: F401
from . import production_service  # noqa: F401
from . import dispatch_service  # noqa: F401
from . import clients_service  # noqa: F401
from . import dashboard_service  # noqa: F401
from . import backup_service  # noqa: F401
from . import users_service  # noqa: F401
from . import profile_service  # noqa: F401
from . import roles_service  # noqa: F401
from . import remarks_service  # noqa: F401

__all__ = [
    "system_service",
    "company_settings_service",
    "units_service",
    "tags_service",
    "items_service",
    "stock_service",
    "vendors_service",
    "bill_service",
    "po_service",
    "return_service",
    "process_service",
    "wastage_service",
    "issue_service",
    "bom_service",
    "contractors_service",
    "warehouse_service",
    "production_service",
    "dispatch_service",
    "clients_service",
    "dashboard_service",
    "backup_service",
    "users_service",
    "profile_service",
    "roles_service",
    "remarks_service",
]

