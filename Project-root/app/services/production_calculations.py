"""
Production Lot Calculations Service

Handles cost and quantity calculations for production lots, including:
- Summing subprocess material and labor costs
- Calculating total lot quantity
- Formatting currency for Indian Rupees (₹)
"""

from typing import Dict, Any, Optional, Tuple
import database
import psycopg2.extras
from flask import current_app


def calculate_lot_costs(lot_id: int) -> Dict[str, Any]:
    """
    Calculate total costs for a production lot by summing subprocess costs.
    
    Args:
        lot_id: The production lot ID
        
    Returns:
        Dictionary with:
        - total_material_cost: Sum of material costs from all subprocesses
        - total_labor_cost: Sum of labor costs from all subprocesses  
        - total_cost: Grand total (material + labor)
        - subprocess_count: Number of subprocesses included
        - currency: 'INR'
    """
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get all subprocesses for this lot
            cur.execute(
                """
                SELECT
                    COUNT(*) as subprocess_count,
                    COALESCE(SUM(CAST(material_cost AS NUMERIC)), 0) as material_cost_sum,
                    COALESCE(SUM(CAST(labor_cost AS NUMERIC)), 0) as labor_cost_sum
                FROM production_lot_subprocesses
                WHERE production_lot_id = %s
                """,
                (lot_id,),
            )
            
            result = cur.fetchone()
            if not result:
                return {
                    "total_material_cost": 0,
                    "total_labor_cost": 0,
                    "total_cost": 0,
                    "subprocess_count": 0,
                    "currency": "INR"
                }
            
            material_cost = float(result.get("material_cost_sum") or 0)
            labor_cost = float(result.get("labor_cost_sum") or 0)
            total_cost = material_cost + labor_cost
            subprocess_count = int(result.get("subprocess_count") or 0)
            
            return {
                "total_material_cost": round(material_cost, 2),
                "total_labor_cost": round(labor_cost, 2),
                "total_cost": round(total_cost, 2),
                "subprocess_count": subprocess_count,
                "currency": "INR"
            }
            
    except Exception as e:
        current_app.logger.error(f"Error calculating lot costs for lot {lot_id}: {e}")
        return {
            "total_material_cost": 0,
            "total_labor_cost": 0,
            "total_cost": 0,
            "subprocess_count": 0,
            "currency": "INR",
            "error": str(e)
        }


def calculate_lot_quantity(lot_id: int) -> Dict[str, Any]:
    """
    Calculate total quantity for a production lot from subprocess requirements.
    
    Args:
        lot_id: The production lot ID
        
    Returns:
        Dictionary with:
        - total_quantity: Total quantity from all subprocesses
        - quantity_unit: Unit of measurement
        - subprocess_count: Number of subprocesses included
    """
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Try to get quantity from production_lots table first
            cur.execute(
                """
                SELECT quantity, quantity_unit
                FROM production_lots
                WHERE id = %s
                """,
                (lot_id,),
            )
            
            lot_result = cur.fetchone()
            if not lot_result:
                return {
                    "total_quantity": 0,
                    "quantity_unit": "units",
                    "subprocess_count": 0
                }
            
            total_quantity = float(lot_result.get("quantity") or 0)
            quantity_unit = lot_result.get("quantity_unit") or "units"
            
            # Count subprocesses
            cur.execute(
                """
                SELECT COUNT(*) as subprocess_count
                FROM production_lot_subprocesses
                WHERE production_lot_id = %s
                """,
                (lot_id,),
            )
            
            count_result = cur.fetchone()
            subprocess_count = int(count_result.get("subprocess_count") or 0) if count_result else 0
            
            return {
                "total_quantity": round(total_quantity, 2),
                "quantity_unit": quantity_unit,
                "subprocess_count": subprocess_count
            }
            
    except Exception as e:
        current_app.logger.error(f"Error calculating lot quantity for lot {lot_id}: {e}")
        return {
            "total_quantity": 0,
            "quantity_unit": "units",
            "subprocess_count": 0,
            "error": str(e)
        }


def format_currency_inr(amount: float) -> str:
    """
    Format a numeric amount as Indian Rupees (₹).
    
    Args:
        amount: Numeric amount to format
        
    Returns:
        Formatted string like "₹1,234.56"
    """
    try:
        # Convert to float if needed
        if isinstance(amount, str):
            amount = float(amount)
        
        # Format with thousand separators and 2 decimal places
        if amount < 0:
            return f"-₹{abs(amount):,.2f}"
        else:
            return f"₹{amount:,.2f}"
    except (ValueError, TypeError):
        return "₹0.00"


def recalculate_lot_totals(lot_id: int) -> Dict[str, Any]:
    """
    Recalculate and update all totals for a production lot.
    
    Args:
        lot_id: The production lot ID
        
    Returns:
        Dictionary with all calculated totals
    """
    try:
        cost_data = calculate_lot_costs(lot_id)
        quantity_data = calculate_lot_quantity(lot_id)
        
        return {
            "lot_id": lot_id,
            "costs": cost_data,
            "quantity": quantity_data,
            "formatted_total_cost": format_currency_inr(cost_data.get("total_cost", 0)),
            "last_calculated": None,  # Could add timestamp if needed
            "status": "success"
        }
        
    except Exception as e:
        current_app.logger.error(f"Error recalculating totals for lot {lot_id}: {e}")
        return {
            "lot_id": lot_id,
            "status": "error",
            "error": str(e)
        }


def check_lot_has_subprocesses(lot_id: int) -> Tuple[bool, int]:
    """
    Check if a production lot has any subprocesses.
    
    Args:
        lot_id: The production lot ID
        
    Returns:
        Tuple of (has_subprocesses: bool, count: int)
    """
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT COUNT(*) as subprocess_count
                FROM production_lot_subprocesses
                WHERE production_lot_id = %s
                """,
                (lot_id,),
            )
            
            result = cur.fetchone()
            count = int(result.get("subprocess_count") or 0) if result else 0
            return count > 0, count
            
    except Exception as e:
        current_app.logger.error(f"Error checking subprocesses for lot {lot_id}: {e}")
        return False, 0


def validate_lot_ready_for_finalization(lot_id: int) -> Tuple[bool, str]:
    """
    Validate if a production lot is ready to be finalized.
    
    Args:
        lot_id: The production lot ID
        
    Returns:
        Tuple of (is_ready: bool, message: str)
    """
    # Check if lot has subprocesses
    has_subs, count = check_lot_has_subprocesses(lot_id)
    if not has_subs:
        return False, "Cannot finalize: Lot has no subprocesses. Add at least one subprocess before finalizing."
    
    # Check lot status
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT status FROM production_lots WHERE id = %s
                """,
                (lot_id,),
            )
            
            result = cur.fetchone()
            if not result:
                return False, "Production lot not found."
            
            status = result.get("status", "").lower()
            
            # Can only finalize Planning status lots
            if status != "planning":
                return False, f"Cannot finalize: Lot status is '{status}'. Only 'Planning' status lots can be finalized."
            
            return True, "Lot is ready to finalize"
            
    except Exception as e:
        current_app.logger.error(f"Error validating finalization readiness for lot {lot_id}: {e}")
        return False, f"Error validating lot: {str(e)}"
