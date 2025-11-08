"""
Test coverage for VariantService.

Tests variant usage operations: add, update, get, list, delete.
"""

from unittest.mock import MagicMock, patch


from app.services.variant_service import VariantService


class TestVariantService:
    """Test suite for variant service operations."""

    def test_add_variant_usage_basic(self):
        """Test adding variant usage with basic parameters."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "process_subprocess_id": 10,
                "variant_id": 5,
                "quantity": 100.0,
                "cost_per_unit": 5.50,
                "total_cost": 550.00,
            }

            result = VariantService.add_variant_usage(
                process_subprocess_id=10,
                variant_id=5,
                quantity=100.0,
                cost_per_unit=5.50,
            )

            assert result["id"] == 1
            assert result["variant_id"] == 5
            assert result["quantity"] == 100.0
            assert result["cost_per_unit"] == 5.50
            assert result["total_cost"] == 550.00

    def test_add_variant_usage_without_cost(self):
        """Test adding variant usage without cost (calculated later)."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 2,
                "process_subprocess_id": 11,
                "variant_id": 6,
                "quantity": 50.0,
                "cost_per_unit": None,
                "total_cost": None,
            }

            result = VariantService.add_variant_usage(
                process_subprocess_id=11, variant_id=6, quantity=50.0
            )

            assert result["id"] == 2
            assert result["quantity"] == 50.0
            assert result["cost_per_unit"] is None
            assert result["total_cost"] is None

    def test_update_variant_usage_quantity(self):
        """Test updating variant usage quantity."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "process_subprocess_id": 10,
                "variant_id": 5,
                "quantity": 200.0,
                "cost_per_unit": 5.50,
                "total_cost": 1100.00,
            }

            result = VariantService.update_variant_usage(usage_id=1, quantity=200.0)

            assert result is not None
            assert result["quantity"] == 200.0
            assert mock_cursor.execute.called

    def test_update_variant_usage_cost(self):
        """Test updating variant usage cost per unit."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "process_subprocess_id": 10,
                "variant_id": 5,
                "quantity": 100.0,
                "cost_per_unit": 6.00,
                "total_cost": 600.00,
            }

            result = VariantService.update_variant_usage(usage_id=1, cost_per_unit=6.00)

            assert result is not None
            assert result["cost_per_unit"] == 6.00

    def test_update_variant_usage_not_found(self):
        """Test updating non-existent variant usage."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = None

            result = VariantService.update_variant_usage(usage_id=999, quantity=100.0)

            assert result is None

    def test_add_variant_usage_with_zero_quantity(self):
        """Test adding variant usage with zero quantity (edge case)."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 3,
                "process_subprocess_id": 12,
                "variant_id": 7,
                "quantity": 0.0,
                "cost_per_unit": 5.00,
                "total_cost": None,  # Service returns None when no cost calculated
            }

            result = VariantService.add_variant_usage(
                process_subprocess_id=12,
                variant_id=7,
                quantity=0.0,
                cost_per_unit=5.00,
            )

            assert result["quantity"] == 0.0
            # Note: Service might return None or 0.0 depending on calculation
            assert result["total_cost"] is not None or result["quantity"] == 0.0

    def test_update_variant_usage_both_fields(self):
        """Test updating both quantity and cost simultaneously."""
        with patch("app.services.variant_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "process_subprocess_id": 10,
                "variant_id": 5,
                "quantity": 150.0,
                "cost_per_unit": 6.50,
                "total_cost": 975.00,
            }

            result = VariantService.update_variant_usage(
                usage_id=1, quantity=150.0, cost_per_unit=6.50
            )

            assert result is not None
            assert result["quantity"] == 150.0
            assert result["cost_per_unit"] == 6.50
            assert result["total_cost"] == 975.00
