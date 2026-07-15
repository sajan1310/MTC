"""Schema source-of-truth, transcribed from Apps_Script/config.js.

This is reference data only in Phase 0 (no `erp` schema tables exist yet
beyond the skeleton ones in migrations/erp/001_init_erp_schema.sql). Phase 1+
uses SHEETS / *_COL_NAMES / DATA_START_ROW below to derive Postgres table and
column names 1:1 from the Apps Script column maps, via to_snake_case(), so
that ported RPC payloads (which use the original camelCase field names) stay
byte-compatible with the frontend while the DB itself uses snake_case.

Do not hand-edit column maps without checking config.js in the read-only
Apps_Script reference first -- these must stay in lockstep with it.
"""

from __future__ import annotations

import re

# ─────────────────────────────────────────────────────────────────────────
# APPLICATION METADATA
# ─────────────────────────────────────────────────────────────────────────

APP_TITLE = "Maharaja Bikes ERP"
APP_VERSION = "1.0.0"

# Sheet keys -> sheet display names (APP_CONFIG.SHEETS)
SHEETS = {
    "PO": "PO Tracker",
    "BILL": "Bill Ledger",
    "RETURN": "Return Ledger",
    "ITEMS": "Items Master",
    "RATE_HISTORY": "Rate History",
    "VENDORS": "Vendors",
    "BOM": "BOM",
    "BOM_COSTS": "BOM Additional Costs",
    "PRODUCTION": "Production",
    "STOCK": "Stock",
    "CLIENTS": "Clients",
    "CLIENT_ORDERS": "Client Orders",
    "DISPATCH": "Dispatch",
    "PROCESS_MASTER": "Process Master",
    "PROCESS_COMPONENTS": "Process Components",
    "PROCESS_COLOR_LINKS": "Process Color Links",
    "WAREHOUSE_POOL": "Warehouse Pool",
    "WAREHOUSE_POOL_OPENING": "Warehouse Pool Opening",
    "UNITS": "Unit Master",
    "COLOR_MASTER": "Color Master",
    "MODEL_MASTER": "Model Master",
    "PROCESS_TYPE_MASTER": "Process Type Master",
    "CONTRACTORS": "Contractors",
    "CONTRACTOR_RATES": "Contractor Rates",
    "CONTRACTOR_PAYMENTS": "Contractor Payments",
    "LOGS": "Logs",
    "WASTAGE": "Wastage Log",
    "ISSUE": "Issued Stock Log",
}

# module_po.js#_attachPoStatus's 3 derived status strings.
PO_STATUS = {
    "ISSUED": "PO Issued",
    "PARTIAL": "Partially Received",
    "COMPLETED": "Completed",
}

# Allowed values for PROCESS_COMPONENTS_COL.SOURCE_TYPE.
COMPONENT_SOURCE_TYPES = {"ITEM": "ITEM", "POOL": "POOL"}

# Sentinel for PROCESS_COMPONENTS_COL.COLOR_GROUP: shared across every color.
COMPONENT_COLOR_GROUP_COMMON = "COMMON"

# Joins per-axis literal colors into one composite output color label.
COLOR_COMBO_DELIMITER = " / "

# Hardcoded virtual "process" category for logistics rate-card entries.
LOGISTICS_PROCESS_NAME = "Dispatch / Logistics"

DATE_FORMATS = {
    "DISPLAY": "DD/MM/YYYY",
    "ISO": "YYYY-MM-DD",
    "TIMESTAMP": "YYYY-MM-DD HH:mm:ss",
}

# Sheet key -> DATA_START_ROW (1-based first data row in the Apps Script
# sheet). Sheets without an explicit *_SETTINGS block in config.js
# (VENDORS, BOM_COSTS, COLOR_MASTER, MODEL_MASTER, PROCESS_TYPE_MASTER,
# LOGS) follow the standard 1-header-row convention used everywhere else.
DATA_START_ROW = {
    "PO": 3,
    "BILL": 2,
    "RETURN": 2,
    "WASTAGE": 2,
    "ISSUE": 2,
    "ITEMS": 2,
    "VENDORS": 2,
    "RATE_HISTORY": 2,
    "BOM": 2,
    "BOM_COSTS": 2,
    "PRODUCTION": 2,
    "UNITS": 2,
    "STOCK": 2,
    "CLIENTS": 2,
    "CLIENT_ORDERS": 2,
    "DISPATCH": 2,
    "PROCESS_MASTER": 2,
    "PROCESS_COMPONENTS": 2,
    "PROCESS_COLOR_LINKS": 2,
    "WAREHOUSE_POOL": 2,
    "WAREHOUSE_POOL_OPENING": 2,
    "COLOR_MASTER": 2,
    "MODEL_MASTER": 2,
    "PROCESS_TYPE_MASTER": 2,
    "CONTRACTORS": 2,
    "CONTRACTOR_RATES": 2,
    "CONTRACTOR_PAYMENTS": 2,
    "LOGS": 2,
}

# ─────────────────────────────────────────────────────────────────────────
# COLUMN MAPS (camelCase field name -> 1-based column index)
# Transcribed verbatim from config.js's *_COL_NAMES objects.
# ─────────────────────────────────────────────────────────────────────────

PO_COL_NAMES = {
    "poNumber": 1,
    "poDate": 2,
    "vendor": 3,
    "contact": 4,
    "itemName": 5,
    "narration": 6,
    "size": 7,
    "qty": 8,
    "unit": 9,
    "poDescription": 10,
    "poRemarks": 11,
    "price": 12,
    "total": 13,
    "totalQty": 14,
    "supplierRemarks": 15,
    "baseQty": 16,
    "baseRate": 17,
}

BILL_COL_NAMES = {
    "poNumber": 1,
    "billNumber": 2,
    "billDate": 3,
    "vendor": 4,
    "contact": 5,
    "itemName": 6,
    "size": 7,
    "narration": 8,
    "qty": 9,
    "unit": 10,
    "price": 11,
    "gst": 12,
    "total": 13,
    "remarks": 14,
    "baseQty": 15,
    "baseRate": 16,
    "affectsStock": 17,
}

RETURN_COL_NAMES = {
    "returnNumber": 1,
    "returnDate": 2,
    "vendor": 3,
    "contact": 4,
    "billNumber": 5,
    "itemName": 6,
    "size": 7,
    "narration": 8,
    "qty": 9,
    "unit": 10,
    "price": 11,
    "total": 12,
    "reason": 13,
    "remarks": 14,
    "baseQty": 15,
    "baseRate": 16,
}

WASTAGE_COL_NAMES = {
    "wastageId": 1,
    "date": 2,
    "vendor": 3,
    "itemName": 4,
    "size": 5,
    "qty": 6,
    "unit": 7,
    "reason": 8,
    "remarks": 9,
    "baseQty": 10,
}

ISSUE_COL_NAMES = {
    "issueId": 1,
    "date": 2,
    "issuedTo": 3,
    "reference": 4,
    "itemName": 5,
    "size": 6,
    "qty": 7,
    "unit": 8,
    "remarks": 9,
    "baseQty": 10,
    "rate": 11,
    "vendor": 12,
}

ITEMS_COL_NAMES = {
    "name": 1,
    "size": 2,
    "remarks": 3,
    "narration": 4,
    "specification": 5,
    "baseUnit": 6,
    "purchaseUnit": 7,
    "weightPerBaseUnit": 8,
    "vendors": 9,
}

VENDORS_COL_NAMES = {
    "vendor": 1,
    "contact": 2,
    "address": 3,
    "gstNumber": 4,
    "remarks": 5,
}

RATE_HISTORY_COL_NAMES = {
    "date": 1,
    "itemName": 2,
    "size": 3,
    "narration": 4,
    "vendorName": 5,
    "rate": 6,
    "poNumber": 7,
    "billNumber": 8,
}

BOM_COL_NAMES = {
    "productId": 1,
    "productName": 2,
    "itemName": 3,
    "size": 4,
    "narration": 5,
    "rate": 6,
    "vendor": 7,
    "qtyPerProduct": 8,
    "remarks": 9,
    "processGroup": 10,
    "color": 11,
    "sequence": 12,
}

BOM_COSTS_COL_NAMES = {
    "productId": 1,
    "description": 2,
    "rate": 3,
    "processName": 4,
    "contractorName": 5,
}

PRODUCTION_COL_NAMES = {
    "date": 1,
    "productId": 2,
    "productName": 3,
    "qty": 4,
    "assignedBy": 5,
    "assignedTo": 6,
    "status": 7,
    "remarks": 8,
    "customComponents": 9,
    "sheetRemarks": 10,
    "processId": 11,
    "lotNumber": 12,
    "consumedFromProcessQty": 13,
    "contractorRate": 14,
    "contractorPayable": 15,
    "outputItemName": 16,
    "componentsConsumed": 17,
    "color": 18,
    "colorBreakdown": 19,
    "orderNumber": 20,
}

PROCESS_COL_NAMES = {
    "processId": 1,
    "processName": 2,
    "sequence": 3,
    "lotPrefix": 4,
    "isFinalStage": 5,
    "active": 6,
    "remarks": 7,
    "outputItemName": 8,
    "processType": 9,
    "primaryColorAxis": 10,
}

PROCESS_COMPONENTS_COL_NAMES = {
    "processId": 1,
    "itemName": 2,
    "size": 3,
    "narration": 4,
    "qtyPerUnit": 5,
    "remarks": 6,
    "sourceType": 7,
    "colorGroup": 8,
    "colorAxis": 9,
    "unit": 10,
}

PROCESS_COLOR_LINKS_COL_NAMES = {
    "processAId": 1,
    "colorA": 2,
    "processBId": 3,
    "colorB": 4,
}

WAREHOUSE_POOL_COL_NAMES = {
    "outputItemName": 1,
    "processId": 2,
    "productTag": 3,
    "producedQty": 4,
    "consumedQty": 5,
    "availableQty": 6,
    "color": 7,
}

WAREHOUSE_POOL_OPENING_COL_NAMES = {
    "outputItemName": 1,
    "processId": 2,
    "productTag": 3,
    "color": 4,
    "qty": 5,
    "date": 6,
    "remarks": 7,
}

CONTRACTORS_COL_NAMES = {
    "contractorName": 1,
    "contact": 2,
    "address": 3,
    "gstPan": 4,
    "remarks": 5,
}

CONTRACTOR_RATES_COL_NAMES = {
    "contractorName": 1,
    "processName": 2,
    "ratePerUnit": 3,
    "remarks": 4,
}

CONTRACTOR_PAYMENTS_COL_NAMES = {
    "date": 1,
    "contractorName": 2,
    "amount": 3,
    "modeReference": 4,
    "remarks": 5,
}

UNITS_COL_NAMES = {
    "unitName": 1,
    "family": 2,
    "factorToBase": 3,
    "remarks": 4,
}

# Shared layout for the simple "name list" masters (Color Master, Model
# Master, Process Type Master): a unique Name + optional Remarks.
TAG_COL_NAMES = {
    "name": 1,
    "remarks": 2,
}

STOCK_COL_NAMES = {
    "itemName": 1,
    "size": 2,
    "initialStock": 3,
    "currentStock": 4,
    "threshold": 5,
    "deadStock": 6,
}

CLIENTS_COL_NAMES = {
    "clientName": 1,
    "contact": 2,
    "address": 3,
    "gstNumber": 4,
    "remarks": 5,
}

CLIENT_ORDERS_COL_NAMES = {
    "orderNumber": 1,
    "orderDate": 2,
    "clientName": 3,
    "productId": 4,
    "productName": 5,
    "qty": 6,
    "status": 7,
    "orderRemarks": 8,
    "lineRemarks": 9,
    "productionPushed": 10,
}

DISPATCH_COL_NAMES = {
    "dispatchNumber": 1,
    "dispatchDate": 2,
    "orderNumber": 3,
    "clientName": 4,
    "productId": 5,
    "productName": 6,
    "qty": 7,
    "transport": 8,
    "remarks": 9,
    "invoiceNumber": 10,
    "privateMark": 11,
    "grNumber": 12,
    "logisticsContractor": 13,
    "logisticsRate": 14,
    "logisticsCost": 15,
}

LOGS_COL_NAMES = {
    "timestamp": 1,
    "user": 2,
    "action": 3,
    "sheet": 4,
    "recordId": 5,
    "details": 6,
    "status": 7,
}

# Sheet key -> its *_COL_NAMES map, for programmatic lookup (mirrors
# config.js's getColumnIndex switch statement).
COLUMN_MAPS = {
    "PO": PO_COL_NAMES,
    "BILL": BILL_COL_NAMES,
    "RETURN": RETURN_COL_NAMES,
    "WASTAGE": WASTAGE_COL_NAMES,
    "ISSUE": ISSUE_COL_NAMES,
    "ITEMS": ITEMS_COL_NAMES,
    "VENDORS": VENDORS_COL_NAMES,
    "RATE_HISTORY": RATE_HISTORY_COL_NAMES,
    "BOM": BOM_COL_NAMES,
    "BOM_COSTS": BOM_COSTS_COL_NAMES,
    "PRODUCTION": PRODUCTION_COL_NAMES,
    "PROCESS_MASTER": PROCESS_COL_NAMES,
    "PROCESS_COMPONENTS": PROCESS_COMPONENTS_COL_NAMES,
    "PROCESS_COLOR_LINKS": PROCESS_COLOR_LINKS_COL_NAMES,
    "WAREHOUSE_POOL": WAREHOUSE_POOL_COL_NAMES,
    "WAREHOUSE_POOL_OPENING": WAREHOUSE_POOL_OPENING_COL_NAMES,
    "UNITS": UNITS_COL_NAMES,
    "COLOR_MASTER": TAG_COL_NAMES,
    "MODEL_MASTER": TAG_COL_NAMES,
    "PROCESS_TYPE_MASTER": TAG_COL_NAMES,
    "STOCK": STOCK_COL_NAMES,
    "CLIENTS": CLIENTS_COL_NAMES,
    "CLIENT_ORDERS": CLIENT_ORDERS_COL_NAMES,
    "DISPATCH": DISPATCH_COL_NAMES,
    "CONTRACTORS": CONTRACTORS_COL_NAMES,
    "CONTRACTOR_RATES": CONTRACTOR_RATES_COL_NAMES,
    "CONTRACTOR_PAYMENTS": CONTRACTOR_PAYMENTS_COL_NAMES,
    "LOGS": LOGS_COL_NAMES,
}

# Sheet key -> real erp.* table name. Extended incrementally as each phase
# adds tables -- not guessed ahead of the services that actually need them.
TABLE_NAMES = {
    "UNITS": "erp.units",
    "COLOR_MASTER": "erp.color_master",
    "MODEL_MASTER": "erp.model_master",
    "PROCESS_TYPE_MASTER": "erp.process_type_master",
    "ITEMS": "erp.items",
    "STOCK": "erp.stock",
    "VENDORS": "erp.vendors",
    # Denormalized sheets split into header+lines tables -- distinct keys
    # since header-level and line-level columns live on different tables
    # (e.g. PO_COL.VENDOR is header-level, PO_COL.UNIT is line-level).
    "PO_HEADERS": "erp.po_headers",
    "PO_LINES": "erp.po_lines",
    "BILL_HEADERS": "erp.bill_headers",
    "BILL_LINES": "erp.bill_lines",
}

_CAMEL_BOUNDARY_RE = re.compile(r"(?<!^)(?=[A-Z])")


def to_snake_case(camel: str) -> str:
    """camelCase -> snake_case, e.g. 'poNumber' -> 'po_number'."""
    return _CAMEL_BOUNDARY_RE.sub("_", camel).lower()


def snake_case_columns(sheet_key: str) -> list[str]:
    """Ordered (by column index) snake_case column names for a sheet key."""
    col_map = COLUMN_MAPS[sheet_key]
    ordered = sorted(col_map.items(), key=lambda item: item[1])
    return [to_snake_case(field) for field, _index in ordered]
