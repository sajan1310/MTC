"""
Costing Service for Universal Process Framework.

This service handles all cost calculations including:
- Worst-case scenario costing (MAX supplier prices)
- Profitability calculations
- Cost breakdowns and analysis
- Supplier pricing management

CRITICAL ALGORITHM - Worst-Case Costing:
1. For single variants with multiple suppliers:
   worst_case_cost = MAX(all_supplier_prices) × quantity

2. For substitute groups (OR groups):
   For each alternative_variant in group:
       max_price = MAX(all_supplier_prices_for_alternative)
   worst_case_cost = MAX(all_alternatives_max_prices) × quantity

3. Total process cost:
   total = SUM(regular_variants + substitute_groups + labor + overhead)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

import database
import psycopg2.extras


class CostingService:
    """
    Service for cost calculations and profitability analysis.
    """

    @staticmethod
    def get_variant_worst_case_cost(variant_id: int) -> Optional[Dict[str, Any]]:
        """
        Get worst-case cost for a single variant (MAX supplier price).

        Args:
            variant_id: The variant to get pricing for

        Returns:
            Dict with:
            - worst_case_cost: Maximum price among all suppliers
            - supplier_id: Which supplier has the highest price
            - all_prices: List of all supplier prices for reference
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT
                    vsp.supplier_id,
                    vsp.cost_per_unit,
                    s.firm_name as supplier_name
                FROM variant_supplier_pricing vsp
                LEFT JOIN suppliers s ON s.supplier_id = vsp.supplier_id
                WHERE vsp.variant_id = %s
                  AND vsp.is_active = TRUE
                  AND (vsp.effective_to IS NULL OR vsp.effective_to > CURRENT_TIMESTAMP)
                ORDER BY vsp.cost_per_unit DESC
            """,
                (variant_id,),
            )

            prices = cur.fetchall()

            if not prices:
                return None

            worst_case = prices[0]  # Highest price (ordered DESC)

            return {
                "worst_case_cost": float(worst_case["cost_per_unit"]),
                "supplier_id": worst_case["supplier_id"],
                "supplier_name": worst_case["supplier_name"],
                "all_prices": [
                    {
                        "supplier_id": p["supplier_id"],
                        "supplier_name": p["supplier_name"],
                        "cost_per_unit": float(p["cost_per_unit"]),
                    }
                    for p in prices
                ],
                "price_range": {
                    "min": float(prices[-1]["cost_per_unit"]),
                    "max": float(prices[0]["cost_per_unit"]),
                    "count": len(prices),
                },
            }

    @staticmethod
    def get_substitute_group_worst_case_cost(
        substitute_group_id: int,
    ) -> Optional[Dict[str, Any]]:
        """
        Get worst-case cost for an OR/substitute group.

        Algorithm:
        1. For each alternative variant in the group, find its MAX supplier price
        2. Return the overall MAX across all alternatives

        Args:
            substitute_group_id: The substitute group ID

        Returns:
            Dict with:
            - worst_case_cost: Highest cost among all alternatives
            - worst_case_variant_id: Which alternative has the highest cost
            - worst_case_supplier_id: Which supplier for that variant
            - alternatives: List of all alternatives with their max costs
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get all variants in this substitute group
            cur.execute(
                """
                SELECT
                    vu.variant_id,
                    vu.quantity,
                    vu.alternative_order,
                    iv.name as variant_name
                FROM variant_usage vu
                JOIN item_variant iv ON iv.variant_id = vu.variant_id
                WHERE vu.substitute_group_id = %s
                  AND vu.is_alternative = TRUE
                ORDER BY vu.alternative_order
            """,
                (substitute_group_id,),
            )

            variants = cur.fetchall()

            if not variants:
                return None

            alternatives_analysis = []
            overall_worst_cost = 0
            overall_worst_variant_id = None
            overall_worst_supplier_id = None
            overall_worst_variant_name = None

            for variant in variants:
                variant_cost_info = CostingService.get_variant_worst_case_cost(
                    variant["variant_id"]
                )

                if variant_cost_info:
                    max_cost = variant_cost_info["worst_case_cost"]

                    if max_cost > overall_worst_cost:
                        overall_worst_cost = max_cost
                        overall_worst_variant_id = variant["variant_id"]
                        overall_worst_supplier_id = variant_cost_info["supplier_id"]
                        overall_worst_variant_name = variant["variant_name"]

                    alternatives_analysis.append(
                        {
                            "variant_id": variant["variant_id"],
                            "variant_name": variant["variant_name"],
                            "quantity": float(variant["quantity"]),
                            "worst_case_cost_per_unit": max_cost,
                            "worst_case_supplier_id": variant_cost_info["supplier_id"],
                            "worst_case_supplier_name": variant_cost_info[
                                "supplier_name"
                            ],
                            "price_range": variant_cost_info["price_range"],
                        }
                    )
                else:
                    # No pricing data for this variant
                    alternatives_analysis.append(
                        {
                            "variant_id": variant["variant_id"],
                            "variant_name": variant["variant_name"],
                            "quantity": float(variant["quantity"]),
                            "worst_case_cost_per_unit": 0,
                            "worst_case_supplier_id": None,
                            "worst_case_supplier_name": None,
                            "price_range": None,
                            "warning": "No supplier pricing available",
                        }
                    )

            return {
                "worst_case_cost": overall_worst_cost,
                "worst_case_variant_id": overall_worst_variant_id,
                "worst_case_variant_name": overall_worst_variant_name,
                "worst_case_supplier_id": overall_worst_supplier_id,
                "alternatives": alternatives_analysis,
                "alternatives_count": len(alternatives_analysis),
            }

    @staticmethod
    def calculate_subprocess_cost(process_subprocess_id: int) -> Dict[str, Any]:
        """
        Calculate total cost for a subprocess including:
        - Fixed variants (not in substitute groups)
        - Substitute groups (worst-case)
        - Cost items (labor, electricity, etc.)

        Args:
            process_subprocess_id: The process-subprocess association ID

        Returns:
            Dict with complete cost breakdown
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get all non-substitute variants
            cur.execute(
                """
                SELECT
                    vu.id,
                    vu.variant_id,
                    vu.quantity,
                    iv.name as variant_name
                FROM variant_usage vu
                JOIN item_variant iv ON iv.variant_id = vu.variant_id
                WHERE vu.process_subprocess_id = %s
                  AND (vu.substitute_group_id IS NULL OR vu.is_alternative = FALSE)
            """,
                (process_subprocess_id,),
            )

            fixed_variants = cur.fetchall()

            # Get all substitute groups
            cur.execute(
                """
                SELECT
                    sg.id,
                    sg.group_name,
                    sg.group_description
                FROM substitute_groups sg
                WHERE sg.process_subprocess_id = %s
            """,
                (process_subprocess_id,),
            )

            substitute_groups = cur.fetchall()

            # Get all cost items
            cur.execute(
                """
                SELECT
                    ci.id,
                    ci.cost_type,
                    ci.description,
                    ci.quantity,
                    ci.rate_per_unit
                FROM cost_items ci
                WHERE ci.process_subprocess_id = %s
            """,
                (process_subprocess_id,),
            )

            cost_items = cur.fetchall()

        # Calculate fixed variant costs
        fixed_variant_costs = []
        total_fixed_cost = 0

        for variant in fixed_variants:
            cost_info = CostingService.get_variant_worst_case_cost(
                variant["variant_id"]
            )
            if cost_info:
                worst_cost = cost_info["worst_case_cost"]
                total_cost = worst_cost * float(variant["quantity"])
                total_fixed_cost += total_cost

                fixed_variant_costs.append(
                    {
                        "variant_id": variant["variant_id"],
                        "variant_name": variant["variant_name"],
                        "quantity": float(variant["quantity"]),
                        "worst_case_cost_per_unit": worst_cost,
                        "total_cost": total_cost,
                        "supplier_id": cost_info["supplier_id"],
                        "supplier_name": cost_info["supplier_name"],
                    }
                )

        # Calculate substitute group costs
        substitute_group_costs = []
        total_substitute_cost = 0

        for group in substitute_groups:
            group_cost_info = CostingService.get_substitute_group_worst_case_cost(
                group["id"]
            )
            if group_cost_info and group_cost_info["worst_case_cost"] > 0:
                # Get quantity from the worst-case variant
                worst_variant_id = group_cost_info["worst_case_variant_id"]
                quantity = next(
                    (
                        alt["quantity"]
                        for alt in group_cost_info["alternatives"]
                        if alt["variant_id"] == worst_variant_id
                    ),
                    1,
                )

                total_cost = group_cost_info["worst_case_cost"] * quantity
                total_substitute_cost += total_cost

                substitute_group_costs.append(
                    {
                        "group_id": group["id"],
                        "group_name": group["group_name"],
                        "worst_case_cost_per_unit": group_cost_info["worst_case_cost"],
                        "worst_case_variant_id": group_cost_info[
                            "worst_case_variant_id"
                        ],
                        "worst_case_variant_name": group_cost_info[
                            "worst_case_variant_name"
                        ],
                        "quantity": quantity,
                        "total_cost": total_cost,
                        "alternatives": group_cost_info["alternatives"],
                    }
                )

        # Calculate cost items
        cost_item_details = []
        total_cost_items = 0

        for item in cost_items:
            item_total = float(item["quantity"]) * float(item["rate_per_unit"])
            total_cost_items += item_total

            cost_item_details.append(
                {
                    "id": item["id"],
                    "cost_type": item["cost_type"],
                    "description": item["description"],
                    "quantity": float(item["quantity"]),
                    "rate_per_unit": float(item["rate_per_unit"]),
                    "total_cost": item_total,
                }
            )

        # Grand total
        grand_total = total_fixed_cost + total_substitute_cost + total_cost_items

        return {
            "process_subprocess_id": process_subprocess_id,
            "fixed_variants": fixed_variant_costs,
            "substitute_groups": substitute_group_costs,
            "cost_items": cost_item_details,
            "totals": {
                "fixed_variants": total_fixed_cost,
                "substitute_groups": total_substitute_cost,
                "cost_items": total_cost_items,
                "grand_total": grand_total,
            },
        }

    @staticmethod
    def calculate_process_total_cost(process_id: int) -> Dict[str, Any]:
        """
        Calculate complete worst-case cost for entire process.

        Includes:
        - All subprocess costs
        - Additional process-level costs
        - Detailed breakdown by subprocess

        Args:
            process_id: The process ID

        Returns:
            Complete cost breakdown and total
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get all subprocesses in order
            cur.execute(
                """
                SELECT
                    ps.id,
                    ps.subprocess_id,
                    ps.sequence_order,
                    ps.custom_name,
                    s.name as subprocess_name
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.process_id = %s
                ORDER BY ps.sequence_order
            """,
                (process_id,),
            )

            subprocesses = cur.fetchall()

            # Get additional costs
            cur.execute(
                """
                SELECT
                    ac.id,
                    ac.cost_type,
                    ac.description,
                    ac.amount,
                    ac.is_fixed
                FROM additional_costs ac
                WHERE ac.process_id = %s
            """,
                (process_id,),
            )

            additional_costs = cur.fetchall()

        # Calculate each subprocess
        subprocess_breakdowns = []
        total_subprocess_cost = 0

        for subprocess in subprocesses:
            breakdown = CostingService.calculate_subprocess_cost(subprocess["id"])
            subprocess_cost = breakdown["totals"]["grand_total"]
            total_subprocess_cost += subprocess_cost

            subprocess_breakdowns.append(
                {
                    "process_subprocess_id": subprocess["id"],
                    "subprocess_id": subprocess["subprocess_id"],
                    "sequence_order": subprocess["sequence_order"],
                    "name": subprocess["custom_name"] or subprocess["subprocess_name"],
                    "cost_breakdown": breakdown,
                    "total_cost": subprocess_cost,
                }
            )

        # Calculate additional costs
        additional_cost_details = []
        total_additional_cost = 0

        for cost in additional_costs:
            amount = float(cost["amount"])
            total_additional_cost += amount

            additional_cost_details.append(
                {
                    "id": cost["id"],
                    "cost_type": cost["cost_type"],
                    "description": cost["description"],
                    "amount": amount,
                    "is_fixed": cost["is_fixed"],
                }
            )

        # Grand total
        grand_total = total_subprocess_cost + total_additional_cost

        return {
            "process_id": process_id,
            "subprocesses": subprocess_breakdowns,
            "additional_costs": additional_cost_details,
            "totals": {
                "subprocesses": total_subprocess_cost,
                "additional_costs": total_additional_cost,
                "grand_total": grand_total,
            },
            "calculated_at": datetime.now().isoformat(),
        }

    @staticmethod
    def update_profitability(
        process_id: int, estimated_sales_price: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Calculate and update profitability metrics for a process.

        Args:
            process_id: The process ID
            estimated_sales_price: Optional sales price to use

        Returns:
            Updated profitability metrics
        """
        # Get worst-case total cost
        cost_breakdown = CostingService.calculate_process_total_cost(process_id)
        total_cost = cost_breakdown["totals"]["grand_total"]

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get or create profitability record
            cur.execute(
                """
                SELECT * FROM profitability
                WHERE process_id = %s
            """,
                (process_id,),
            )

            existing = cur.fetchone()

            if existing:
                # Update existing
                sales_price = (
                    estimated_sales_price
                    if estimated_sales_price is not None
                    else existing.get("estimated_sales_price")
                )

                profit_amount = None
                profit_margin = None

                if sales_price is not None and sales_price > 0:
                    profit_amount = sales_price - total_cost
                    profit_margin = (profit_amount / sales_price) * 100

                cur.execute(
                    """
                    UPDATE profitability
                    SET total_worst_case_cost = %s,
                        estimated_sales_price = %s,
                        profit_margin = %s,
                        profit_amount = %s,
                        last_calculated = CURRENT_TIMESTAMP
                    WHERE process_id = %s
                    RETURNING *
                """,
                    (total_cost, sales_price, profit_margin, profit_amount, process_id),
                )
            else:
                # Create new
                sales_price = estimated_sales_price
                profit_amount = None
                profit_margin = None

                if sales_price is not None and sales_price > 0:
                    profit_amount = sales_price - total_cost
                    profit_margin = (profit_amount / sales_price) * 100

                cur.execute(
                    """
                    INSERT INTO profitability (
                        process_id,
                        total_worst_case_cost,
                        estimated_sales_price,
                        profit_margin,
                        profit_amount,
                        last_calculated
                    ) VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                    RETURNING *
                """,
                    (process_id, total_cost, sales_price, profit_margin, profit_amount),
                )

            profitability = cur.fetchone()
            conn.commit()

        return {
            "process_id": process_id,
            "total_worst_case_cost": float(profitability["total_worst_case_cost"])
            if profitability["total_worst_case_cost"]
            else 0,
            "estimated_sales_price": float(profitability["estimated_sales_price"])
            if profitability["estimated_sales_price"]
            else None,
            "profit_margin": float(profitability["profit_margin"])
            if profitability["profit_margin"]
            else None,
            "profit_amount": float(profitability["profit_amount"])
            if profitability["profit_amount"]
            else None,
            "last_calculated": profitability["last_calculated"].isoformat()
            if profitability["last_calculated"]
            else None,
            "is_profitable": (float(profitability["profit_amount"]) > 0)
            if profitability["profit_amount"]
            else False,
        }
