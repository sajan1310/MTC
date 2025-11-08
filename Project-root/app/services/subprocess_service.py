"""
Subprocess Service for Universal Process Framework.

Handles subprocess template management including:
- Subprocess CRUD operations
- Reusable template management
- Variant and cost item management within subprocesses
- Substitute group creation
- Caching for performance (Priority 3)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from functools import lru_cache
from flask import current_app, has_app_context
import logging

import database
import psycopg2.extras

from ..models.process import CostItem, Subprocess, SubstituteGroup, VariantUsage


class SubprocessService:
    """
    Service for subprocess management operations with caching.
    """

    # Cache version for invalidation
    _cache_version = 0

    @classmethod
    def invalidate_cache(cls):
        """Invalidate subprocess cache when data changes."""
        cls._cache_version += 1
        # Clear the LRU cache
        SubprocessService.get_all_subprocesses_cached.cache_clear()

    (current_app.logger if has_app_context() else logging.getLogger(__name__)).info(
        "Subprocess cache cleared"
    )

    @staticmethod
    @lru_cache(maxsize=1)
    def get_all_subprocesses_cached(cache_version: int) -> List[Dict[str, Any]]:
        """
        Get all subprocesses with caching (Priority 3).

        This method caches ALL subprocesses to avoid repeated database queries.
        The cache_version parameter allows cache invalidation when data changes.

        Args:
            cache_version: Current cache version (for invalidation)

        Returns:
            List of all subprocess templates
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT
                    s.*,
                    COUNT(ps.id) as usage_count
                FROM subprocesses s
                LEFT JOIN process_subprocesses ps ON ps.subprocess_id = s.id
                GROUP BY s.id
                ORDER BY s.name
            """
            )
            subprocesses = [dict(sp) for sp in cur.fetchall()]

        (current_app.logger if has_app_context() else logging.getLogger(__name__)).info(
            f"Loaded {len(subprocesses)} subprocesses into cache"
        )
        return subprocesses

    @staticmethod
    def create_subprocess(
        name: str,
        description: Optional[str] = None,
        category: Optional[str] = None,
        estimated_time_minutes: int = 0,
        labor_cost: float = 0.00,
    ) -> Dict[str, Any]:
        """
        Create a new subprocess template.

        Args:
            name: Subprocess name
            description: Optional description
            category: Subprocess category
            estimated_time_minutes: Estimated time in minutes
            labor_cost: Labor cost

        Returns:
            Created subprocess
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO subprocesses (name, description, category, estimated_time_minutes, labor_cost)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *
            """,
                (name, description, category, estimated_time_minutes, labor_cost),
            )

            subprocess_data = cur.fetchone()
            conn.commit()

        # Invalidate cache when new subprocess is created
        SubprocessService.invalidate_cache()

        subprocess = Subprocess(subprocess_data)
        return subprocess.to_dict()

    @staticmethod
    def get_subprocess(subprocess_id: int) -> Optional[Dict[str, Any]]:
        """
        Get subprocess with complete details.

        Args:
            subprocess_id: The subprocess ID

        Returns:
            Subprocess with variants, costs, etc.
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT * FROM subprocesses
                WHERE id = %s AND is_deleted = FALSE
            """,
                (subprocess_id,),
            )

            subprocess_data = cur.fetchone()

            if not subprocess_data:
                return None

            subprocess = Subprocess(subprocess_data)
            result = subprocess.to_dict()

            # Count usage in processes
            cur.execute(
                """
                SELECT COUNT(*) as usage_count
                FROM process_subprocesses
                WHERE subprocess_id = %s
            """,
                (subprocess_id,),
            )

            result["usage_count"] = cur.fetchone()["usage_count"]

        return result

    @staticmethod
    def list_subprocesses(
        subprocess_type: Optional[str] = None, page: int = 1, per_page: int = 50
    ) -> Dict[str, Any]:
        """
        List subprocesses with optional filtering (uses cache - Priority 3).

        Args:
            subprocess_type: Filter by subprocess type/category
            page: Page number
            per_page: Items per page (max 1000)

        Returns:
            Paginated subprocess list
        """
        # Enforce reasonable limits
        per_page = min(per_page, 1000)

        # Priority 3: Use cached data
        all_subprocesses = SubprocessService.get_all_subprocesses_cached(
            SubprocessService._cache_version
        )

        # Filter by type if specified
        if subprocess_type:
            filtered = [
                sp for sp in all_subprocesses if sp.get("category") == subprocess_type
            ]
        else:
            filtered = all_subprocesses

        # Calculate pagination
        total = len(filtered)
        offset = (page - 1) * per_page
        paginated = filtered[offset : offset + per_page]

        return {
            "subprocesses": paginated,
            "pagination": {
                "page": page,
                "per_page": per_page,
                "total": total,
                "pages": (total + per_page - 1) // per_page if total > 0 else 0,
            },
        }

    @staticmethod
    def update_subprocess(
        subprocess_id: int,
        name: Optional[str] = None,
        description: Optional[str] = None,
        category: Optional[str] = None,
        estimated_time_minutes: Optional[int] = None,
        labor_cost: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Update subprocess details.

        Args:
            subprocess_id: The subprocess ID
            name: Optional new name
            description: Optional new description
            category: Optional category
            estimated_time_minutes: Optional estimated time
            labor_cost: Optional labor cost

        Returns:
            Updated subprocess or None
        """
        updates = []
        params = []

        if name is not None:
            updates.append("name = %s")
            params.append(name)
        if description is not None:
            updates.append("description = %s")
            params.append(description)
        if category is not None:
            updates.append("category = %s")
            params.append(category)
        if estimated_time_minutes is not None:
            updates.append("estimated_time_minutes = %s")
            params.append(estimated_time_minutes)
        if labor_cost is not None:
            updates.append("labor_cost = %s")
            params.append(labor_cost)

        if not updates:
            return SubprocessService.get_subprocess(subprocess_id)

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(subprocess_id)

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"""
                UPDATE subprocesses
                SET {", ".join(updates)}
                WHERE id = %s
                RETURNING *
            """,
                params,
            )

            subprocess_data = cur.fetchone()
            conn.commit()

        if not subprocess_data:
            return None

        subprocess = Subprocess(subprocess_data)
        return subprocess.to_dict()

    @staticmethod
    def delete_subprocess(subprocess_id: int, hard_delete: bool = False) -> bool:
        """
        Delete a subprocess (soft delete by default).

        Args:
            subprocess_id: The subprocess ID
            hard_delete: If True, permanently delete

        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            if hard_delete:
                cur.execute(
                    """
                    DELETE FROM subprocesses
                    WHERE id = %s
                """,
                    (subprocess_id,),
                )
            else:
                cur.execute(
                    """
                    UPDATE subprocesses
                    SET is_deleted = TRUE,
                        deleted_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND is_deleted = FALSE
                """,
                    (subprocess_id,),
                )

            affected = cur.rowcount
            conn.commit()

        return affected > 0

    @staticmethod
    def duplicate_subprocess(
        subprocess_id: int, new_name: str, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Duplicate a subprocess template.

        Args:
            subprocess_id: The subprocess to duplicate
            new_name: Name for the duplicate
            user_id: User creating the duplicate

        Returns:
            New subprocess with copied structure
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get original subprocess
            cur.execute(
                """
                SELECT * FROM subprocesses
                WHERE id = %s
            """,
                (subprocess_id,),
            )

            original = cur.fetchone()

            if not original:
                return None

            # Create duplicate
            cur.execute(
                """
                INSERT INTO subprocesses (name, description, user_id, reusable, version)
                VALUES (%s, %s, %s, %s, 1)
                RETURNING *
            """,
                (new_name, original["description"], user_id, original["reusable"]),
            )

            new_subprocess = cur.fetchone()
            conn.commit()

        subprocess = Subprocess(new_subprocess)
        return subprocess.to_dict()

    @staticmethod
    def add_variant_to_subprocess(
        process_subprocess_id: int,
        variant_id: int,
        quantity: float,
        cost_per_unit: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Add a variant to a subprocess instance.

        Args:
            process_subprocess_id: The process-subprocess association
            variant_id: The variant to add
            quantity: Quantity required
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
    def add_cost_item(
        process_subprocess_id: int,
        cost_type: str,
        quantity: float,
        rate_per_unit: float,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Add a cost item (labor, electricity, etc.) to a subprocess.

        Args:
            process_subprocess_id: The process-subprocess association
            cost_type: Type of cost (labor, electricity, etc.)
            quantity: Quantity
            rate_per_unit: Rate per unit (amount)
            description: Optional description

        Returns:
            Created cost item
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO cost_items (
                    process_subprocess_id, cost_type, description,
                    quantity, amount
                ) VALUES (%s, %s, %s, %s, %s)
                RETURNING *
            """,
                (
                    process_subprocess_id,
                    cost_type,
                    description,
                    quantity,
                    rate_per_unit,
                ),
            )

            cost_data = cur.fetchone()
            conn.commit()

        cost_item = CostItem(cost_data)
        return cost_item.to_dict()

    @staticmethod
    def create_substitute_group(
        process_subprocess_id: int,
        group_name: str,
        variant_ids: List[int],
        group_description: Optional[str] = None,
        selection_method: str = "dropdown",
    ) -> Dict[str, Any]:
        """
        Create an OR/substitute group with multiple variant alternatives.

        This is a key feature - allows defining alternatives that can be
        chosen at production time.

        Args:
            process_subprocess_id: The subprocess instance
            group_name: Name for the OR group
            variant_ids: List of alternative variant IDs
            group_description: Optional description
            selection_method: UI selection method (dropdown, radio, list)

        Returns:
            Created substitute group with alternatives
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Create the group
            cur.execute(
                """
                INSERT INTO substitute_groups (
                    process_subprocess_id, group_name, group_description, selection_method
                ) VALUES (%s, %s, %s, %s)
                RETURNING *
            """,
                (
                    process_subprocess_id,
                    group_name,
                    group_description,
                    selection_method,
                ),
            )

            group_data = cur.fetchone()
            group_id = group_data["id"]

            # Add variants as alternatives
            for order, variant_id in enumerate(variant_ids, start=1):
                # Get default quantity (can be adjusted later)
                cur.execute(
                    """
                    INSERT INTO variant_usage (
                        process_subprocess_id, variant_id, substitute_group_id,
                        is_alternative, alternative_order, quantity
                    ) VALUES (%s, %s, %s, TRUE, %s, 1)
                """,
                    (process_subprocess_id, variant_id, group_id, order),
                )

            conn.commit()

        group = SubstituteGroup(group_data)
        result = group.to_dict()
        result["alternatives_count"] = len(variant_ids)

        return result
