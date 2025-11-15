"""
Process and Subprocess Models for Universal Process Framework.

These models represent the core process management entities:
- Process: Top-level production/service process
- Subprocess: Reusable subprocess templates
- ProcessSubprocess: Association between process and subprocess with ordering
- VariantUsage: Variants used in subprocess with quantities
- CostItem: Labor, electricity, and other costs
- AdditionalCost: Process-level overhead costs
- ProcessTiming: Duration tracking
- ConditionalFlag: Branching logic support
- SubstituteGroup: OR groups for variant alternatives
- Profitability: Cost and profit tracking

NOTE: This follows the existing pattern in the codebase where models
are simple data containers. Business logic resides in service classes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional


class Process:
    """
    Represents a manufacturing or service process.

    A process is composed of multiple subprocesses in sequence,
    each with its own variants, costs, and timing.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.name: str = data["name"]
        self.description: Optional[str] = data.get("description")
        self.process_class: str = data.get(
            "class", data.get("process_class", "assembly")
        )  # 'class' is Python keyword
        self.user_id: int = data.get("user_id", data.get("created_by"))
        self.status: str = data.get("status", "draft")
        self.version: int = data.get("version", 1)
        self.is_deleted: bool = data.get("is_deleted", False)
        self.deleted_at: Optional[datetime] = data.get("deleted_at")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""

        def _fmt(dt: Any) -> Optional[str]:
            if dt is None:
                return None
            # If already a string (e.g., from mocks), return as-is
            if isinstance(dt, str):
                return dt
            # datetime-like with isoformat
            iso = getattr(dt, "isoformat", None)
            return iso() if callable(iso) else str(dt)

        data = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "class": self.process_class,
            # Provide compatibility alias expected by some callers/tests
            "process_class": self.process_class,
            "user_id": self.user_id,
            "status": self.status,
            "version": self.version,
            "is_deleted": self.is_deleted,
            "deleted_at": _fmt(self.deleted_at),
            "created_at": _fmt(self.created_at),
            "updated_at": _fmt(self.updated_at),
        }
        return data

    def is_active(self) -> bool:
        """Check if process is active and not deleted."""
        return self.status == "active" and not self.is_deleted


class Subprocess:
    """
    Represents a reusable subprocess template.

    Subprocesses can be shared across multiple processes.
    They encapsulate a set of operations with variants and costs.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.name: str = data["name"]
        self.description: Optional[str] = data.get("description")
        self.reusable: bool = data.get("reusable", False)
        self.version: int = data.get("version", 1)
        self.user_id: Optional[int] = data.get(
            "user_id"
        )  # Optional - subprocesses are shared
        self.is_deleted: bool = data.get("is_deleted", False)
        self.deleted_at: Optional[datetime] = data.get("deleted_at")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "reusable": self.reusable,
            "version": self.version,
            "user_id": self.user_id,
            "is_deleted": self.is_deleted,
            "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class ProcessSubprocess:
    """
    Association between a Process and a Subprocess.

    Maintains sequence order and allows custom naming per process.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_id: int = data["process_id"]
        self.subprocess_id: int = data["subprocess_id"]
        self.custom_name: Optional[str] = data.get("custom_name")
        self.sequence_order: int = data["sequence_order"]
        self.notes: Optional[str] = data.get("notes")
        self.created_at: datetime = data.get("created_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_id": self.process_id,
            "subprocess_id": self.subprocess_id,
            "custom_name": self.custom_name,
            "sequence_order": self.sequence_order,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class VariantUsage:
    """
    Represents a variant (item) used in a subprocess.

    Tracks quantity, cost, and alternative/substitute group membership.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_subprocess_id: int = data["process_subprocess_id"]
        self.variant_id: int = data["variant_id"]
        self.quantity: float = float(data["quantity"])
        self.cost_per_unit: Optional[float] = (
            float(data["cost_per_unit"])
            if data.get("cost_per_unit") is not None
            else None
        )
        self.total_cost: Optional[float] = (
            float(data["total_cost"]) if data.get("total_cost") else None
        )
        self.substitute_group_id: Optional[int] = data.get("substitute_group_id")
        self.is_alternative: bool = data.get("is_alternative", False)
        self.alternative_order: Optional[int] = data.get("alternative_order")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_subprocess_id": self.process_subprocess_id,
            "variant_id": self.variant_id,
            "quantity": self.quantity,
            "cost_per_unit": self.cost_per_unit,
            "total_cost": self.total_cost,
            "substitute_group_id": self.substitute_group_id,
            "is_alternative": self.is_alternative,
            "alternative_order": self.alternative_order,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class CostItem:
    """
    Represents non-material costs in a subprocess.

    Examples: labor, electricity, maintenance, services, etc.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_subprocess_id: int = data["process_subprocess_id"]
        self.cost_type: str = data["cost_type"]
        self.description: Optional[str] = data.get("description")
        self.amount: float = float(data.get("amount", 0))
        self.unit: Optional[str] = data.get("unit")
        self.quantity: Optional[float] = (
            float(data["quantity"]) if data.get("quantity") else None
        )
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    @property
    def total_cost(self) -> float:
        """Calculate total cost as amount * quantity (or just amount if no quantity)."""
        if self.quantity:
            return self.amount * self.quantity
        return self.amount

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_subprocess_id": self.process_subprocess_id,
            "cost_type": self.cost_type,
            "description": self.description,
            "amount": self.amount,
            "unit": self.unit,
            "quantity": self.quantity,
            "total_cost": self.total_cost,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class AdditionalCost:
    """
    Process-level additional costs not tied to specific subprocesses.

    Examples: overhead, facility costs, administrative costs.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_id: int = data["process_id"]
        self.cost_type: str = data["cost_type"]
        self.description: Optional[str] = data.get("description")
        self.amount: float = float(data["amount"])
        self.is_fixed: bool = data.get("is_fixed", True)
        self.created_at: datetime = data.get("created_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_id": self.process_id,
            "cost_type": self.cost_type,
            "description": self.description,
            "amount": self.amount,
            "is_fixed": self.is_fixed,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class ProcessTiming:
    """
    Tracks estimated and actual duration for subprocess execution.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_subprocess_id: int = data["process_subprocess_id"]
        self.estimated_duration: Optional[float] = (
            float(data["estimated_duration"])
            if data.get("estimated_duration")
            else None
        )
        self.actual_duration: Optional[float] = (
            float(data["actual_duration"]) if data.get("actual_duration") else None
        )
        self.duration_unit: str = data.get("duration_unit", "minutes")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_subprocess_id": self.process_subprocess_id,
            "estimated_duration": self.estimated_duration,
            "actual_duration": self.actual_duration,
            "duration_unit": self.duration_unit,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class ConditionalFlag:
    """
    Enables branching logic and conditional steps in processes.

    Supports quality checks, rework paths, and alternative workflows.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_subprocess_id: int = data["process_subprocess_id"]
        self.condition_type: str = data["condition_type"]
        self.description: Optional[str] = data.get("description")
        self.is_enabled: bool = data.get("is_enabled", False)
        self.condition_value: Optional[str] = data.get("condition_value")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_subprocess_id": self.process_subprocess_id,
            "condition_type": self.condition_type,
            "description": self.description,
            "is_enabled": self.is_enabled,
            "condition_value": self.condition_value,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class SubstituteGroup:
    """
    Represents an OR group - a set of alternative/substitute variants.

    Only ONE variant from each group is selected during production lot creation.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_subprocess_id: int = data["process_subprocess_id"]
        self.group_name: str = data["group_name"]
        self.group_description: Optional[str] = data.get("group_description")
        self.selection_method: str = data.get("selection_method", "dropdown")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_subprocess_id": self.process_subprocess_id,
            "group_name": self.group_name,
            "group_description": self.group_description,
            "selection_method": self.selection_method,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Profitability:
    """
    Tracks profitability metrics for a process.

    Automatically calculated based on worst-case costing and sales price.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_id: int = data["process_id"]
        self.total_worst_case_cost: Optional[float] = (
            float(data["total_worst_case_cost"])
            if data.get("total_worst_case_cost")
            else None
        )
        self.estimated_sales_price: Optional[float] = (
            float(data["estimated_sales_price"])
            if data.get("estimated_sales_price")
            else None
        )
        self.profit_margin: Optional[float] = (
            float(data["profit_margin"]) if data.get("profit_margin") else None
        )
        self.profit_amount: Optional[float] = (
            float(data["profit_amount"]) if data.get("profit_amount") else None
        )
        self.last_calculated: Optional[datetime] = data.get("last_calculated")
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_id": self.process_id,
            "total_worst_case_cost": self.total_worst_case_cost,
            "estimated_sales_price": self.estimated_sales_price,
            "profit_margin": self.profit_margin,
            "profit_amount": self.profit_amount,
            "last_calculated": (
                self.last_calculated.isoformat() if self.last_calculated else None
            ),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class VariantSupplierPricing:
    """
    Multi-supplier pricing for variants.

    Supports time-based pricing with effective dates and currency.
    Essential for worst-case costing calculations.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.variant_id: int = data["variant_id"]
        self.supplier_id: Optional[int] = data.get("supplier_id")
        self.cost_per_unit: float = float(data["cost_per_unit"])
        self.currency: str = data.get("currency", "INR")
        self.minimum_order_qty: int = data.get("minimum_order_qty", 1)
        self.effective_from: datetime = data.get("effective_from", datetime.now())
        self.effective_to: Optional[datetime] = data.get("effective_to")
        self.is_active: bool = data.get("is_active", True)
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "variant_id": self.variant_id,
            "supplier_id": self.supplier_id,
            "cost_per_unit": self.cost_per_unit,
            "currency": self.currency,
            "minimum_order_qty": self.minimum_order_qty,
            "effective_from": (
                self.effective_from.isoformat() if self.effective_from else None
            ),
            "effective_to": (
                self.effective_to.isoformat() if self.effective_to else None
            ),
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def is_currently_active(self) -> bool:
        """Check if pricing is currently active and within effective dates."""
        if not self.is_active:
            return False
        now = datetime.now()
        if self.effective_from and self.effective_from > now:
            return False
        if self.effective_to and self.effective_to < now:
            return False
        return True


class ProcessWorstCaseCosting:
    """
    Stores calculated worst-case costs for process components.

    Tracks which supplier and variant combinations result in highest costs.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_id: int = data["process_id"]
        self.process_subprocess_id: Optional[int] = data.get("process_subprocess_id")
        self.variant_id: Optional[int] = data.get("variant_id")
        self.supplier_id: Optional[int] = data.get("supplier_id")
        self.worst_case_cost: float = float(data["worst_case_cost"])
        self.quantity: float = float(data["quantity"])
        self.total_worst_case_cost: Optional[float] = (
            float(data["total_worst_case_cost"])
            if data.get("total_worst_case_cost")
            else None
        )
        self.is_substitute_group: bool = data.get("is_substitute_group", False)
        self.selected_alternative_variant_id: Optional[int] = data.get(
            "selected_alternative_variant_id"
        )
        self.cost_calculation_method: str = data.get(
            "cost_calculation_method", "worst_case"
        )
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_id": self.process_id,
            "process_subprocess_id": self.process_subprocess_id,
            "variant_id": self.variant_id,
            "supplier_id": self.supplier_id,
            "worst_case_cost": self.worst_case_cost,
            "quantity": self.quantity,
            "total_worst_case_cost": self.total_worst_case_cost,
            "is_substitute_group": self.is_substitute_group,
            "selected_alternative_variant_id": self.selected_alternative_variant_id,
            "cost_calculation_method": self.cost_calculation_method,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
