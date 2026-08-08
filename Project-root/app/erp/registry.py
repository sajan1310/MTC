"""RPC method registry -- the allowlist for POST /api/erp/rpc/<method>.

Ports the ~117-method surface of Apps Script's google.script.run bridge.
Each ERP service function registers itself under its original Apps Script
method name via @rpc_method(...), so the frontend port (Script_ApiCore.html's
_apiCall) can call methods by name exactly as it does today.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class RpcSpec:
    name: str
    func: Callable[..., Any]
    mutation: bool = False
    offline: bool = False
    bom_gated: bool = False
    # Authorization mechanism (plumbing only -- see rpc.py's enforcement).
    # None means "no restriction beyond @login_required". A method can opt
    # in by passing roles={"manager", "admin"} to @rpc_method; the
    # dispatcher then requires current_user.has_role() to match one of them
    # (User.has_role(), app/models/user.py, already treats "admin" and
    # "super_admin" as a superuser wildcard for any role check). Used today
    # by users_service.py/roles_service.py's admin-only methods and
    # backup_service.py/items_service.py's two admin-only mutations.
    roles: frozenset[str] | None = None
    # The service module this method lives in (e.g. "bill_service"),
    # derived automatically below -- not passed by callers. Lets rpc.py's
    # dispatcher map a method to the sidebar tab it belongs to (see
    # roles_service.py's TAB_BY_SERVICE_MODULE) for a custom role's
    # per-tab permission check, without every one of the ~135 @rpc_method
    # call sites needing its own explicit tab= kwarg.
    module: str = ""


RPC_METHODS: dict[str, RpcSpec] = {}


def rpc_method(
    name: str,
    *,
    mutation: bool = False,
    offline: bool = False,
    bom_gated: bool = False,
    roles: frozenset[str] | set[str] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register `func` under `name` in RPC_METHODS.

    Raises on duplicate registration -- two services accidentally claiming
    the same Apps Script method name is a bug, not something to silently
    overwrite.
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        if name in RPC_METHODS:
            raise ValueError(f"RPC method '{name}' is already registered")
        RPC_METHODS[name] = RpcSpec(
            name=name,
            func=func,
            mutation=mutation,
            offline=offline,
            bom_gated=bom_gated,
            roles=frozenset(roles) if roles is not None else None,
            module=func.__module__.rsplit(".", 1)[-1],
        )
        return func

    return decorator
