"""Rates, costs and money are for Admin and Super Admin (the owner's rule),
and for a custom role an Admin has granted "Prices & amounts"
(roles_service.PRICES_GRANT): Viewer or Commenter sees them, Editor can also
save the entries that carry them.

Every other role keeps working with items, quantities and lots; the amounts
just never leave the server for them. app/erp/rpc.py applies this to every
reply, in one place rather than a field list per service, so a new list that
names its money the way the others do is covered without anyone remembering.
Hiding the figures in the browser alone would leave them one request away.

Values are blanked, not removed. Both shells do arithmetic on these fields, and
a missing key throws where a zero renders; formatCurrency then shows a dash, so
a blanked amount never reads as "Rs 0".

A save is the other half. A form opened by someone who can't see the prices
holds zeros, and saving it would write those zeros over the real figures, so
any save that takes a price from the form needs price_access() == "edit"
(FINANCIAL_SAVES), on top of Editor on its page. A
production lot is not on that list: saveProduction reads its rates from the
stored lot and the rate card, never from the form.
"""

from __future__ import annotations

import numbers
import re
from functools import lru_cache

from .roles_service import PRICES_GRANT, get_role_permissions

FINANCE_ROLES = frozenset({"admin", "super_admin"})
# Roles that are never a custom role, so there is no grant to look up.
_NOT_CUSTOM = frozenset({"user", "admin", "super_admin", "pending_approval"})

# Read per word, so `ratePerBaseUnit` and `gstRatePct` match and `generatedAt`
# does not. Quantities are named Qty throughout, which is what keeps them out.
_WORD_RE = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])")
_MONEY_WORDS = frozenset(
    {
        "amount",
        "amounts",
        "cost",
        "costs",
        "paid",
        "payable",
        "payables",
        "price",
        "prices",
        "rate",
        "rates",
        "subtotal",
    }
)
# Money whose name doesn't say so. oldValue/newValue are absent on purpose:
# those are stock counts.
_MONEY_KEYS = frozenset(
    {
        "balanceDue",
        "billsLastMonthValue",
        "billsThisMonthValue",
        "grandTotal",
        "lineTotal",
        "openPoValue",
        "returnsLastMonthValue",
        "returnsThisMonthValue",
        "totalValue",
    }
)
# Generic names that are money in one reply and a count in others.
_KEYS_BY_METHOD = {
    "getContractorAccountLedger": frozenset({"balance"}),
    "getIssueData": frozenset({"value"}),
    "getPOData": frozenset({"total"}),
}

FINANCIAL_SAVES = frozenset(
    {
        "saveBill",
        "saveBOM",
        "saveClientOrder",
        "saveContractorRate",
        "deleteContractorRate",
        "deleteContractorRatesBulk",
        "saveContractorServiceCharge",
        "deleteContractorServiceCharge",
        "deleteContractorServiceChargesBulk",
        "recordContractorPayment",
        "deleteContractorPayment",
        "deleteContractorPaymentsBulk",
        "saveDispatch",
        "saveDispatchPlanLine",
        "saveIssueStock",
        "saveItem",
        "mergeItemEdit",
        "savePO",
        "saveReturn",
    }
)


def price_access(role) -> str:
    """ "edit", "view" or "none" for `role`.

    The built-in roles are fixed: Admin and Super Admin see and enter prices,
    User never does. A custom role gets what its Prices & amounts grant says,
    and a role deleted under a live session gets nothing.
    """
    if role in FINANCE_ROLES:
        return "edit"
    if not role or role in _NOT_CUSTOM:
        return "none"
    level = (get_role_permissions(role) or {}).get(PRICES_GRANT)
    if level == "editor":
        return "edit"
    if level in ("viewer", "commenter"):
        return "view"
    return "none"


def sees_financials(role) -> bool:
    return price_access(role) != "none"


def may_save_prices(role) -> bool:
    return price_access(role) == "edit"


@lru_cache(maxsize=4096)
def is_money_key(key: str) -> bool:
    if key in _MONEY_KEYS:
        return True
    return any(word.lower() in _MONEY_WORDS for word in _WORD_RE.findall(key))


def _is_number_text(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def _blank(value):
    """Same type, no money. A label such as extraChargeType or a GSTIN has a
    money word in its name but says no amount, so it stays."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, numbers.Number):
        return 0
    if isinstance(value, str):
        return "0" if _is_number_text(value) else value
    if isinstance(value, list):
        return []
    if isinstance(value, dict):
        return {}
    return value


def _strip(value, extra_keys):
    if isinstance(value, dict):
        return {
            key: _blank(item)
            if isinstance(key, str) and (key in extra_keys or is_money_key(key))
            else _strip(item, extra_keys)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_strip(item, extra_keys) for item in value]
    return value


def strip_financials(data, method: str | None = None):
    """`data` with every amount blanked. Builds a copy: the caller's envelope
    may be the one stored for a replayed mutation."""
    return _strip(data, _KEYS_BY_METHOD.get(method, frozenset()))
