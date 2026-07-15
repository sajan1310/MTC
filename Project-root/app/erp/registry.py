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


RPC_METHODS: dict[str, RpcSpec] = {}


def rpc_method(
    name: str,
    *,
    mutation: bool = False,
    offline: bool = False,
    bom_gated: bool = False,
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
            name=name, func=func, mutation=mutation, offline=offline, bom_gated=bom_gated
        )
        return func

    return decorator
