"""
Variant Service for Universal Process Framework.

Handles variant usage, supplier pricing, and variant search functionality.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import database
import psycopg2.extras

from ..models.process import VariantSupplierPricing, VariantUsage


class VariantService:
    """
    Service for variant management in processes.
    """

    @staticmethod
    def add_variant_usage(
        process_subprocess_id: int,
        variant_id: int,
        quantity: float,
        cost_per_unit: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Add a variant to a subprocess.

        Args:
            process_subprocess_id: The subprocess instance
            variant_id: The variant to add
            quantity: Required quantity
            cost_per_unit: Optional cost override

        Returns:
            Created variant usage
        """
        total_cost = (cost_per_unit * quantity) if cost_per_unit else None

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO variant_usage (
                    process_subprocess_id, variant_id, quantity,
                    cost_per_unit, total_cost
                ) VALUES (%s, %s, %s, %s, %s)
                RETURNING *
            """,
                (
                    process_subprocess_id,
                    variant_id,
                    quantity,
                    cost_per_unit,
                    total_cost,
                ),
            )

            usage_data = cur.fetchone()
            conn.commit()

        usage = VariantUsage(usage_data)
        return usage.to_dict()

    @staticmethod
    def update_variant_usage(
        usage_id: int,
        quantity: Optional[float] = None,
        cost_per_unit: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Update variant usage details.

        Args:
            usage_id: The variant usage ID
            quantity: Optional new quantity
            cost_per_unit: Optional new cost

        Returns:
            Updated variant usage
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get current values
            cur.execute(
                """
                SELECT * FROM variant_usage WHERE id = %s
            """,
                (usage_id,),
            )

            current = cur.fetchone()

            if not current:
                return None

            new_quantity = (
                quantity if quantity is not None else float(current["quantity"])
            )
            new_cost = (
                cost_per_unit
                if cost_per_unit is not None
                else (
                    float(current["cost_per_unit"])
                    if current["cost_per_unit"]
                    else None
                )
            )
            new_total = (new_quantity * new_cost) if new_cost else None

            cur.execute(
                """
                UPDATE variant_usage
                SET quantity = %s,
                    cost_per_unit = %s,
                    total_cost = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING *
            """,
                (new_quantity, new_cost, new_total, usage_id),
            )

            usage_data = cur.fetchone()
            conn.commit()

        usage = VariantUsage(usage_data)
        return usage.to_dict()

    @staticmethod
    def remove_variant_usage(usage_id: int) -> bool:
        """
        Remove a variant from a subprocess.

        Args:
            usage_id: The variant usage ID

        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            cur.execute(
                """
                DELETE FROM variant_usage
                WHERE id = %s
            """,
                (usage_id,),
            )

            affected = cur.rowcount
            conn.commit()

        return affected > 0

    @staticmethod
    def add_supplier_pricing(
        variant_id: int,
        supplier_id: int,
        cost_per_unit: float,
        minimum_order_qty: int = 1,
        currency: str = "INR",
        effective_from: Optional[str] = None,
        effective_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Add supplier pricing for a variant.

        Args:
            variant_id: The variant
            supplier_id: The supplier
            cost_per_unit: Cost per unit
            minimum_order_qty: Minimum order quantity
            currency: Currency code
            effective_from: Optional start date
            effective_to: Optional end date

        Returns:
            Created pricing record
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO variant_supplier_pricing (
                    variant_id, supplier_id, cost_per_unit, currency,
                    minimum_order_qty, effective_from, effective_to, is_active
                ) VALUES (%s, %s, %s, %s, %s,
                         COALESCE(%s::timestamp, CURRENT_TIMESTAMP),
                         %s::timestamp, TRUE)
                RETURNING *
            """,
                (
                    variant_id,
                    supplier_id,
                    cost_per_unit,
                    currency,
                    minimum_order_qty,
                    effective_from,
                    effective_to,
                ),
            )

            pricing_data = cur.fetchone()
            conn.commit()

        pricing = VariantSupplierPricing(pricing_data)
        return pricing.to_dict()

    @staticmethod
    def get_variant_suppliers(variant_id: int) -> List[Dict[str, Any]]:
        """
        Get all active supplier pricing for a variant.

        Args:
            variant_id: The variant

        Returns:
            List of supplier pricing records
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT
                    vsp.*,
                    s.firm_name as supplier_name
                FROM variant_supplier_pricing vsp
                JOIN suppliers s ON s.supplier_id = vsp.supplier_id
                WHERE vsp.variant_id = %s
                  AND vsp.is_active = TRUE
                  AND (vsp.effective_to IS NULL OR vsp.effective_to > CURRENT_TIMESTAMP)
                ORDER BY vsp.cost_per_unit
            """,
                (variant_id,),
            )

            suppliers = cur.fetchall()

        return [dict(s) for s in suppliers]

    @staticmethod
    def update_supplier_pricing(
        pricing_id: int,
        cost_per_unit: Optional[float] = None,
        minimum_order_qty: Optional[int] = None,
        is_active: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Update supplier pricing.

        Args:
            pricing_id: The pricing record ID
            cost_per_unit: Optional new cost
            minimum_order_qty: Optional new MOQ
            is_active: Optional active flag

        Returns:
            Updated pricing record
        """
        updates = []
        params = []

        if cost_per_unit is not None:
            updates.append("cost_per_unit = %s")
            params.append(cost_per_unit)
        if minimum_order_qty is not None:
            updates.append("minimum_order_qty = %s")
            params.append(minimum_order_qty)
        if is_active is not None:
            updates.append("is_active = %s")
            params.append(is_active)

        if not updates:
            return None

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(pricing_id)

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"""
                UPDATE variant_supplier_pricing
                SET {", ".join(updates)}
                WHERE id = %s
                RETURNING *
            """,
                params,
            )

            pricing_data = cur.fetchone()
            conn.commit()

        if not pricing_data:
            return None

        pricing = VariantSupplierPricing(pricing_data)
        return pricing.to_dict()

    @staticmethod
    def remove_supplier_pricing(pricing_id: int) -> bool:
        """
        Remove supplier pricing (soft delete - mark as inactive).

        Args:
            pricing_id: The pricing record ID

        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            cur.execute(
                """
                UPDATE variant_supplier_pricing
                SET is_active = FALSE,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
            """,
                (pricing_id,),
            )

            affected = cur.rowcount
            conn.commit()

        return affected > 0

    @staticmethod
    def search_variants(
        query: str, filters: Optional[Dict[str, Any]] = None, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Search variants for autocomplete and selection.

        Supports filtering by:
        - Category
        - Stock availability
        - Cost range
        - Labels/tags

        Args:
            query: Search query
            filters: Optional filter dict
            limit: Maximum results

        Returns:
            List of matching variants with pricing and stock info
        """
        filters = filters or {}
        search_pattern = f"%{query}%"

        conditions = ["iv.name ILIKE %s"]
        params = [search_pattern]

        # Category filter
        if filters.get("category_id"):
            conditions.append("im.category_id = %s")
            params.append(filters["category_id"])

        # Stock availability filter
        if filters.get("in_stock_only"):
            conditions.append("iv.opening_stock > 0")

        # Cost range filter
        if filters.get("min_cost"):
            conditions.append("""
                EXISTS (
                    SELECT 1 FROM variant_supplier_pricing vsp
                    WHERE vsp.variant_id = iv.variant_id
                      AND vsp.cost_per_unit >= %s
                      AND vsp.is_active = TRUE
                )
            """)
            params.append(filters["min_cost"])

        if filters.get("max_cost"):
            conditions.append("""
                EXISTS (
                    SELECT 1 FROM variant_supplier_pricing vsp
                    WHERE vsp.variant_id = iv.variant_id
                      AND vsp.cost_per_unit <= %s
                      AND vsp.is_active = TRUE
                )
            """)
            params.append(filters["max_cost"])

        where_clause = " AND ".join(conditions)

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"""
                SELECT DISTINCT
                    iv.variant_id,
                    im.name as variant_name,
                    iv.opening_stock,
                    iv.threshold,
                    im.name as item_name,
                    COALESCE(
                        (SELECT MIN(vsp.cost_per_unit)
                         FROM variant_supplier_pricing vsp
                         WHERE vsp.variant_id = iv.variant_id
                           AND vsp.is_active = TRUE
                        ), 0
                    ) as min_cost,
                    COALESCE(
                        (SELECT MAX(vsp.cost_per_unit)
                         FROM variant_supplier_pricing vsp
                         WHERE vsp.variant_id = iv.variant_id
                           AND vsp.is_active = TRUE
                        ), 0
                    ) as max_cost,
                    COALESCE(
                        (SELECT COUNT(*)
                         FROM variant_supplier_pricing vsp
                         WHERE vsp.variant_id = iv.variant_id
                           AND vsp.is_active = TRUE
                        ), 0
                    ) as supplier_count
                FROM item_variant iv
                JOIN item_master im ON im.item_id = iv.item_id
                WHERE {where_clause}
                ORDER BY im.name
                LIMIT %s
            """,
                params + [limit],
            )

            variants = cur.fetchall()

        return [
            {
                **dict(v),
                "is_low_stock": float(v["opening_stock"] or 0)
                <= float(v["threshold"] or 0),
                "stock_status": "in_stock"
                if float(v["opening_stock"] or 0) > 0
                else "out_of_stock",
            }
            for v in variants
        ]

    @staticmethod
    def check_variant_availability(
        variant_id: int, required_quantity: float
    ) -> Dict[str, Any]:
        """
        Check if sufficient stock is available for a variant.

        Args:
            variant_id: The variant to check
            required_quantity: Required quantity

        Returns:
            Availability status with stock details
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT
                    iv.variant_id,
                    im.name as variant_name,
                    iv.opening_stock,
                    iv.threshold
                FROM item_variant iv
                JOIN item_master im ON im.item_id = iv.item_id
                WHERE iv.variant_id = %s
            """,
                (variant_id,),
            )

            variant = cur.fetchone()

        if not variant:
            return {"available": False, "reason": "Variant not found"}

        current_stock = float(variant["opening_stock"] or 0)
        is_available = current_stock >= required_quantity

        return {
            "available": is_available,
            "variant_id": variant_id,
            "variant_name": variant["variant_name"],
            "current_stock": current_stock,
            "required_quantity": required_quantity,
            "shortfall": max(0, required_quantity - current_stock),
            "is_low_stock": current_stock <= float(variant["threshold"] or 0),
            "threshold": float(variant["threshold"] or 0),
        }
