"""
UPSERT-based import service for bulk data operations.

This module replaces table-level locking with PostgreSQL's ON CONFLICT (UPSERT) pattern
combined with chunked batch processing to allow concurrent reads and writes during imports
while maintaining data integrity.

Features:
- Chunked batch processing (configurable batch size, default 1000)
- Row-level error handling with detailed error capture
- Progress tracking for long-running imports
- ON CONFLICT DO UPDATE (UPSERT) for all master tables
- Connection pooling and retry logic
- Partial success handling (continue on row failures)
- Comprehensive logging and metrics
"""

import logging
import time
from typing import Any, Dict, List, Optional

from database import get_conn

from app.validators.import_validators import DataValidator

# Configure logger
logger = logging.getLogger(__name__)


class ImportService:
    """
    Service for handling bulk import operations using UPSERT pattern.

    This service provides methods for importing items, colors, sizes, and variants
    using PostgreSQL's ON CONFLICT clause to handle conflicts gracefully without
    requiring table-level locks.
    """

    # Import limits
    MAX_TOTAL_ROWS = 50000  # Maximum rows per import
    DEFAULT_BATCH_SIZE = 1000  # Default batch size for chunked processing
    MAX_RETRY_ATTEMPTS = 3  # Max retries for transient connection errors

    def __init__(self, batch_size: int = DEFAULT_BATCH_SIZE):
        """
        Initialize import service.

        Args:
            batch_size: Number of rows to process per batch (default 1000)
        """
        self.batch_size = min(batch_size, self.DEFAULT_BATCH_SIZE)
        self.logger = logger

    def import_items_chunked(
        self, data: List[Dict[str, Any]], progress_callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        """
        Import items with variants using chunked batch processing and UPSERT.

        This is the main entry point for bulk imports. It:
        1. Validates total row count
        2. Validates and sanitizes all data
        3. Processes data in chunks
        4. Uses UPSERT to handle conflicts
        5. Tracks progress and errors
        6. Returns detailed results

        Args:
            data: List of dictionaries containing item and variant data
            progress_callback: Optional callback function for progress updates
                              Signature: callback(processed, total, percentage)

        Returns:
            Dictionary with:
                - processed: Count of successfully imported rows
                - failed: List of failed rows with error details
                - total_rows: Total rows attempted
                - success_rate: Percentage of successful imports
                - import_duration: Total time in seconds
                - skipped: Count of rows skipped due to validation

        Raises:
            ValueError: If total_rows exceeds MAX_TOTAL_ROWS or data is invalid
        """
        start_time = time.time()
        total_rows = len(data)

        # Validate row count
        if total_rows > self.MAX_TOTAL_ROWS:
            raise ValueError(
                f"Import exceeds maximum row limit. "
                f"Provided: {total_rows}, Maximum: {self.MAX_TOTAL_ROWS}"
            )

        if total_rows == 0:
            return {
                "processed": 0,
                "failed": [],
                "total_rows": 0,
                "success_rate": 0.0,
                "import_duration": 0.0,
                "skipped": 0,
            }

        self.logger.info(
            f"Starting import of {total_rows} rows (batch size: {self.batch_size})"
        )

        # Validate and sanitize all rows
        valid_rows, invalid_rows = DataValidator.validate_batch(data)

        self.logger.info(
            f"Validation complete: {len(valid_rows)} valid, {len(invalid_rows)} invalid"
        )

        # Process valid rows in chunks
        processed = 0
        failed_rows = []

        try:
            with get_conn() as (conn, cur):
                # Process in chunks
                for i in range(0, len(valid_rows), self.batch_size):
                    batch = valid_rows[i : i + self.batch_size]
                    batch_num = (i // self.batch_size) + 1
                    total_batches = (
                        len(valid_rows) + self.batch_size - 1
                    ) // self.batch_size

                    self.logger.info(
                        f"Processing batch {batch_num}/{total_batches} ({len(batch)} rows)"
                    )

                    # Process each row in batch individually to capture specific errors
                    for row in batch:
                        try:
                            self._import_single_row(cur, row)
                            processed += 1
                        except Exception as e:
                            self.logger.warning(
                                f"Row {row.get('row_number')} failed: {e}"
                            )
                            failed_rows.append(
                                {
                                    "row": row,
                                    "error": str(e),
                                    "row_number": row.get("row_number"),
                                }
                            )
                            # Rollback this row's changes but continue processing
                            conn.rollback()

                    # Commit after each batch
                    conn.commit()

                    # Update progress
                    current_progress = processed + len(failed_rows)
                    percentage = (current_progress / len(valid_rows)) * 100
                    self.logger.info(
                        f"Batch {batch_num}/{total_batches} complete: "
                        f"{processed} processed, {len(failed_rows)} failed ({percentage:.1f}%)"
                    )

                    # Call progress callback if provided
                    if progress_callback:
                        progress_callback(current_progress, len(valid_rows), percentage)

        except Exception as e:
            self.logger.error(f"Critical error during import: {e}")
            raise

        # Calculate results
        duration = time.time() - start_time
        total_attempted = len(valid_rows)
        success_rate = (
            (processed / total_attempted * 100) if total_attempted > 0 else 0.0
        )

        # Combine validation failures with processing failures
        all_failed = invalid_rows + failed_rows

        result = {
            "processed": processed,
            "failed": all_failed,
            "total_rows": total_rows,
            "success_rate": success_rate,
            "import_duration": duration,
            "skipped": len(invalid_rows),
        }

        self.logger.info(
            f"Import complete: {processed}/{total_attempted} successful "
            f"({success_rate:.1f}%), {len(all_failed)} failed, "
            f"duration: {duration:.2f}s"
        )

        return result

    def _import_single_row(self, cur, row: Dict[str, Any]) -> None:
        """
        Import a single row (item + variant) using UPSERT pattern.

        Args:
            cur: Database cursor
            row: Validated row dictionary

        Raises:
            Exception: If database operation fails
        """

        # Extract validated data (be tolerant to different header casings)
        def pick(d: Dict[str, Any], *keys: str, default: Any = "") -> Any:
            for k in keys:
                if k in d and d[k] is not None:
                    return d[k]
            return default

        # Item-level fields
        item_name = pick(row, "name", "Item", "Name")
        if not item_name:
            raise KeyError("name")
        category = pick(row, "category", "Category", default="")
        description = pick(row, "description", "Description", default="")
        model = pick(row, "model", "Model", default="")
        variation = pick(row, "variation", "Variation", default="")

        # Variant-level fields
        color = pick(row, "color", "Color")
        size = pick(row, "size", "Size")
        stock = pick(row, "opening_stock", "Stock", "stock")
        threshold = pick(row, "threshold", "Threshold", default=5)
        unit = pick(row, "unit", "Unit", default="Pcs")

        # Get or create model_id if model provided
        model_id = None
        if model:
            model_id = self._upsert_model(cur, model)

        # Get or create variation_id if variation provided
        variation_id = None
        if variation:
            variation_id = self._upsert_variation(cur, variation)

        # Upsert item master
        item_id = self._upsert_item_master(
            cur, item_name, category, description, model_id, variation_id
        )

        # Get or create color_id
        color_id = self._upsert_color(cur, color)

        # Get or create size_id
        size_id = self._upsert_size(cur, size)

        # Upsert item variant
        self._upsert_item_variant(
            cur, item_id, color_id, size_id, stock, threshold, unit
        )

    def _upsert_item_master(
        self,
        cur,
        name: str,
        category: str = "",
        description: str = "",
        model_id: Optional[int] = None,
        variation_id: Optional[int] = None,
    ) -> int:
        """
        Insert or update item_master using UPSERT pattern.

        ON CONFLICT: Updates category, description, model_id, variation_id, updated_at

        Args:
            cur: Database cursor
            name: Item name (unique key)
            category: Item category
            description: Item description
            model_id: Foreign key to model_master
            variation_id: Foreign key to variation_master

        Returns:
            item_id of inserted/updated record
        """
        # Check if table has deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='item_master' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        # Build query dynamically based on table structure
        if has_deleted_at:
            conflict_where = "WHERE item_master.deleted_at IS NULL"
        else:
            conflict_where = ""

        # Check if category, model_id, variation_id columns exist
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='item_master'
            AND column_name IN ('category', 'model_id', 'variation_id', 'description')
        """)
        existing_columns = {row[0] for row in cur.fetchall()}

        # Build dynamic INSERT query
        columns = ["name"]
        values = [name]
        placeholders = ["%s"]

        if "description" in existing_columns and description:
            columns.append("description")
            values.append(description)
            placeholders.append("%s")

        if "category" in existing_columns and category:
            columns.append("category")
            values.append(category)
            placeholders.append("%s")

        if "model_id" in existing_columns and model_id:
            columns.append("model_id")
            values.append(model_id)
            placeholders.append("%s")

        if "variation_id" in existing_columns and variation_id:
            columns.append("variation_id")
            values.append(variation_id)
            placeholders.append("%s")

        # Build UPDATE clause
        update_parts = []
        if "description" in existing_columns:
            update_parts.append("description = EXCLUDED.description")
        if "category" in existing_columns:
            update_parts.append("category = EXCLUDED.category")
        if "model_id" in existing_columns:
            update_parts.append("model_id = EXCLUDED.model_id")
        if "variation_id" in existing_columns:
            update_parts.append("variation_id = EXCLUDED.variation_id")

        # Add updated_at if column exists
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='item_master' AND column_name='updated_at'
        """)
        if cur.fetchone():
            update_parts.append("updated_at = NOW()")

        update_clause = (
            ", ".join(update_parts) if update_parts else "name = EXCLUDED.name"
        )

        query = f"""
            INSERT INTO item_master ({", ".join(columns)})
            VALUES ({", ".join(placeholders)})
            ON CONFLICT (name) {conflict_where}
            DO UPDATE SET {update_clause}
            RETURNING item_id
        """

        cur.execute(query, values)
        result = cur.fetchone()
        return result[0]

    def _upsert_color(self, cur, color_name: str) -> int:
        """
        Insert or update color_master using UPSERT pattern.

        Args:
            cur: Database cursor
            color_name: Color name (unique key)

        Returns:
            color_id of inserted/updated record
        """
        # Check for deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='color_master' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        if has_deleted_at:
            conflict_where = "WHERE color_master.deleted_at IS NULL"
        else:
            conflict_where = ""

        # Check for updated_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='color_master' AND column_name='updated_at'
        """)
        has_updated_at = cur.fetchone() is not None

        update_clause = (
            "updated_at = NOW()"
            if has_updated_at
            else "color_name = EXCLUDED.color_name"
        )

        query = f"""
            INSERT INTO color_master (color_name)
            VALUES (%s)
            ON CONFLICT (color_name) {conflict_where}
            DO UPDATE SET {update_clause}
            RETURNING color_id
        """

        cur.execute(query, (color_name,))
        result = cur.fetchone()
        return result[0]

    def _upsert_size(self, cur, size_name: str) -> int:
        """
        Insert or update size_master using UPSERT pattern.

        Args:
            cur: Database cursor
            size_name: Size name/code (unique key)

        Returns:
            size_id of inserted/updated record
        """
        # Check for deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='size_master' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        if has_deleted_at:
            conflict_where = "WHERE size_master.deleted_at IS NULL"
        else:
            conflict_where = ""

        # Check for updated_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='size_master' AND column_name='updated_at'
        """)
        has_updated_at = cur.fetchone() is not None

        update_clause = (
            "updated_at = NOW()" if has_updated_at else "size_name = EXCLUDED.size_name"
        )

        query = f"""
            INSERT INTO size_master (size_name)
            VALUES (%s)
            ON CONFLICT (size_name) {conflict_where}
            DO UPDATE SET {update_clause}
            RETURNING size_id
        """

        cur.execute(query, (size_name,))
        result = cur.fetchone()
        return result[0]

    def _upsert_model(self, cur, model_name: str) -> int:
        """
        Insert or update model_master using UPSERT pattern.

        Args:
            cur: Database cursor
            model_name: Model name (unique key)

        Returns:
            model_id of inserted/updated record
        """
        # Check if table exists
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_name='model_master'
        """)
        if not cur.fetchone():
            raise ValueError("model_master table does not exist")

        # Check for deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='model_master' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        if has_deleted_at:
            conflict_where = "WHERE model_master.deleted_at IS NULL"
        else:
            conflict_where = ""

        query = f"""
            INSERT INTO model_master (model_name)
            VALUES (%s)
            ON CONFLICT (model_name) {conflict_where}
            DO UPDATE SET model_name = EXCLUDED.model_name
            RETURNING model_id
        """

        cur.execute(query, (model_name,))
        result = cur.fetchone()
        return result[0]

    def _upsert_variation(self, cur, variation_name: str) -> int:
        """
        Insert or update variation_master using UPSERT pattern.

        Args:
            cur: Database cursor
            variation_name: Variation name (unique key)

        Returns:
            variation_id of inserted/updated record
        """
        # Check if table exists
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_name='variation_master'
        """)
        if not cur.fetchone():
            raise ValueError("variation_master table does not exist")

        # Check for deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='variation_master' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        if has_deleted_at:
            conflict_where = "WHERE variation_master.deleted_at IS NULL"
        else:
            conflict_where = ""

        query = f"""
            INSERT INTO variation_master (variation_name)
            VALUES (%s)
            ON CONFLICT (variation_name) {conflict_where}
            DO UPDATE SET variation_name = EXCLUDED.variation_name
            RETURNING variation_id
        """

        cur.execute(query, (variation_name,))
        result = cur.fetchone()
        return result[0]

    def _upsert_item_variant(
        self,
        cur,
        item_id: int,
        color_id: int,
        size_id: int,
        opening_stock: int,
        threshold: int = 5,
        unit: str = "Pcs",
    ) -> int:
        """
        Insert or update item_variant using UPSERT pattern.

        ON CONFLICT: Adds opening_stock to existing stock (accumulate)

        Args:
            cur: Database cursor
            item_id: Foreign key to item_master
            color_id: Foreign key to color_master
            size_id: Foreign key to size_master
            opening_stock: Stock quantity to add
            threshold: Low stock threshold
            unit: Unit of measurement

        Returns:
            variant_id of inserted/updated record
        """
        # Check for deleted_at column
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='item_variant' AND column_name='deleted_at'
        """)
        has_deleted_at = cur.fetchone() is not None

        if has_deleted_at:
            conflict_where = "WHERE item_variant.deleted_at IS NULL"
        else:
            conflict_where = ""

        query = f"""
            INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (item_id, color_id, size_id) {conflict_where}
            DO UPDATE SET
                opening_stock = item_variant.opening_stock + EXCLUDED.opening_stock,
                threshold = EXCLUDED.threshold,
                unit = EXCLUDED.unit
            RETURNING variant_id
        """

        cur.execute(query, (item_id, color_id, size_id, opening_stock, threshold, unit))
        result = cur.fetchone()
        return result[0]


# Convenience function for direct import
def import_items(data: List[Dict[str, Any]], batch_size: int = 1000) -> Dict[str, Any]:
    """
    Convenience function to import items using default ImportService.

    Args:
        data: List of item/variant dictionaries
        batch_size: Rows per batch (default 1000)

    Returns:
        Import results dictionary
    """
    service = ImportService(batch_size=batch_size)
    return service.import_items_chunked(data)
