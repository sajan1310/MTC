"""
Production Lot Models for Universal Process Framework.

These models handle the execution phase of processes:
- ProductionLot: Represents a production run of a process
- ProductionLotSelection: Tracks which variant was selected from each OR group
- ProductionLotActualCosting: Records actual costs vs. worst-case estimates

Production lots are where the "OR/Substitute" feature comes into play:
During lot creation, the user selects ONE variant from each substitute group,
and the system tracks actual costs for variance analysis.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional


class ProductionLot:
    """
    Represents a production lot - an execution instance of a process.

    When a lot is created, the user must select variants from all OR groups.
    The lot tracks worst-case estimated costs vs. actual execution costs.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.process_id: int = data["process_id"]
        self.lot_number: str = data["lot_number"]
        self.created_by: Optional[int] = data.get("created_by")
        self.status: str = data.get("status", "Planning")
        self.quantity: int = data.get("quantity", 1)
        self.total_cost: Optional[float] = (
            float(data["total_cost"])
            if data.get("total_cost")
            else None
        )
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.started_at: Optional[datetime] = data.get("started_at")
        self.completed_at: Optional[datetime] = data.get("completed_at")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "process_id": self.process_id,
            "lot_number": self.lot_number,
            "created_by": self.created_by,
            "status": self.status,
            "quantity": self.quantity,
            "total_cost": self.total_cost,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat()
            if self.completed_at
            else None,
        }

    def is_editable(self) -> bool:
        """Check if lot can still be edited (only Planning lots)."""
        return self.status == "Planning"

    def is_executable(self) -> bool:
        """Check if lot is ready to execute."""
        return self.status == "Ready"

    def is_completed(self) -> bool:
        """Check if lot has been completed."""
        return self.status == "Completed"


class ProductionLotSelection:
    """
    Records which variant was selected from an OR/substitute group for a lot.

    For each substitute group in the process, the user must select ONE variant.
    This selection is recorded here along with the selected supplier and cost.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.production_lot_id: int = data["production_lot_id"]
        self.substitute_group_id: int = data["substitute_group_id"]
        self.selected_variant_id: int = data["selected_variant_id"]
        self.selected_supplier_id: Optional[int] = data.get("selected_supplier_id")
        self.selected_cost: Optional[float] = (
            float(data["selected_cost"]) if data.get("selected_cost") else None
        )
        self.selected_quantity: Optional[float] = (
            float(data["selected_quantity"]) if data.get("selected_quantity") else None
        )
        self.created_at: datetime = data.get("created_at", datetime.now())
        self.updated_at: datetime = data.get("updated_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "production_lot_id": self.production_lot_id,
            "substitute_group_id": self.substitute_group_id,
            "selected_variant_id": self.selected_variant_id,
            "selected_supplier_id": self.selected_supplier_id,
            "selected_cost": self.selected_cost,
            "selected_quantity": self.selected_quantity,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def calculate_total_cost(self) -> Optional[float]:
        """Calculate total cost for this selection."""
        if self.selected_cost is not None and self.selected_quantity is not None:
            return self.selected_cost * self.selected_quantity
        return None


class ProductionLotActualCosting:
    """
    Tracks actual costs paid vs. worst-case estimates for variance analysis.

    This is populated during or after lot execution to record what was
    actually spent versus what was estimated in worst-case scenario.
    """

    def __init__(self, data: Dict[str, Any]):
        self.id: int = data["id"]
        self.production_lot_id: int = data["production_lot_id"]
        self.variant_id: int = data["variant_id"]
        self.supplier_id: Optional[int] = data.get("supplier_id")
        self.worst_case_estimated: Optional[float] = (
            float(data["worst_case_estimated"])
            if data.get("worst_case_estimated")
            else None
        )
        self.actual_cost_paid: Optional[float] = (
            float(data["actual_cost_paid"]) if data.get("actual_cost_paid") else None
        )
        self.variance: Optional[float] = (
            float(data["variance"]) if data.get("variance") else None
        )
        self.variance_percentage: Optional[float] = (
            float(data["variance_percentage"])
            if data.get("variance_percentage")
            else None
        )
        self.notes: Optional[str] = data.get("notes")
        self.created_at: datetime = data.get("created_at", datetime.now())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "production_lot_id": self.production_lot_id,
            "variant_id": self.variant_id,
            "supplier_id": self.supplier_id,
            "worst_case_estimated": self.worst_case_estimated,
            "actual_cost_paid": self.actual_cost_paid,
            "variance": self.variance,
            "variance_percentage": self.variance_percentage,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

    def calculate_variance(self) -> None:
        """
        Calculate variance between actual and estimated costs.
        Updates variance and variance_percentage attributes.
        """
        if self.worst_case_estimated is not None and self.actual_cost_paid is not None:
            self.variance = self.actual_cost_paid - self.worst_case_estimated
            if self.worst_case_estimated > 0:
                self.variance_percentage = (
                    self.variance / self.worst_case_estimated
                ) * 100
            else:
                self.variance_percentage = 0

    def is_under_budget(self) -> bool:
        """Check if actual cost was under worst-case estimate."""
        if self.variance is None:
            return False
        return self.variance < 0

    def is_over_budget(self) -> bool:
        """Check if actual cost exceeded worst-case estimate."""
        if self.variance is None:
            return False
        return self.variance > 0


# Helper functions for production lot operations


def generate_lot_number(prefix: str = "LOT") -> str:
    """
    Generate a unique lot number with timestamp.

    Format: PREFIX-YYYYMMDD-HHMMSS
    Example: LOT-20251104-143022
    """
    now = datetime.now()
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    return f"{prefix}-{timestamp}"


def validate_lot_selections(
    substitute_groups: List[Dict[str, Any]], selections: List[Dict[str, Any]]
) -> tuple[bool, Optional[str]]:
    """
    Validate that all required substitute groups have selections.

    Args:
        substitute_groups: List of substitute group dicts
        selections: List of selection dicts with 'substitute_group_id'

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not substitute_groups:
        return True, None

    group_ids = {g["id"] for g in substitute_groups}
    selection_group_ids = {s["substitute_group_id"] for s in selections}

    missing = group_ids - selection_group_ids
    if missing:
        return False, f"Missing selections for substitute groups: {missing}"

    extra = selection_group_ids - group_ids
    if extra:
        return False, f"Invalid substitute group IDs in selections: {extra}"

    return True, None


def calculate_lot_total_cost(
    fixed_variant_costs: List[float],
    selected_variant_costs: List[float],
    cost_items: List[float],
    additional_costs: List[float],
    lot_quantity: int = 1,
) -> Dict[str, float]:
    """
    Calculate total cost breakdown for a production lot.

    Args:
        fixed_variant_costs: Costs for non-substitutable variants
        selected_variant_costs: Costs for selected variants from OR groups
        cost_items: Labor, electricity, etc.
        additional_costs: Process-level overhead costs
        lot_quantity: Number of units in the lot

    Returns:
        Dict with cost breakdown:
        - material_cost: Total material cost
        - labor_cost: Total non-material cost
        - overhead_cost: Additional costs
        - total_cost: Grand total
        - per_unit_cost: Cost per unit
    """
    material_cost = sum(fixed_variant_costs) + sum(selected_variant_costs)
    labor_cost = sum(cost_items)
    overhead_cost = sum(additional_costs)
    total_cost = (material_cost + labor_cost + overhead_cost) * lot_quantity
    per_unit_cost = total_cost / lot_quantity if lot_quantity > 0 else 0

    return {
        "material_cost": material_cost,
        "labor_cost": labor_cost,
        "overhead_cost": overhead_cost,
        "total_cost": total_cost,
        "per_unit_cost": per_unit_cost,
        "lot_quantity": lot_quantity,
    }
