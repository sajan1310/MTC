"""
Test coverage for ProductionService.

Tests production lot operations: create, get, list, update status.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from app.services.production_service import ProductionService


class TestProductionService:
    """Test suite for production service operations."""

    @patch("app.services.production_service.CostingService.calculate_process_total_cost")
    def test_create_production_lot_basic(self, mock_costing):
        """Test creating a production lot with auto-generated lot number."""
        mock_costing.return_value = {"totals": {"grand_total": 1000.00}}

        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "process_id": 5,
                "lot_number": "LOT-2025-0001",
                "user_id": 1,
                "quantity": 100,
                "worst_case_estimated_cost": 100000.00,
                "actual_cost": None,
                "status": "draft",
                "created_at": datetime(2025, 1, 1),
                "started_at": None,
                "completed_at": None,
            }

            result = ProductionService.create_production_lot(
                process_id=5, user_id=1, quantity=100
            )

            assert result["id"] == 1
            assert result["process_id"] == 5
            assert result["quantity"] == 100
            assert result["status"] == "draft"
            assert result["worst_case_estimated_cost"] == 100000.00
            assert "LOT-" in result["lot_number"]

    @patch("app.services.production_service.CostingService.calculate_process_total_cost")
    def test_create_production_lot_custom_lot_number(self, mock_costing):
        """Test creating production lot with custom lot number."""
        mock_costing.return_value = {"totals": {"grand_total": 500.00}}

        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 2,
                "process_id": 6,
                "lot_number": "CUSTOM-LOT-123",
                "user_id": 1,
                "quantity": 50,
                "worst_case_estimated_cost": 25000.00,
                "actual_cost": None,
                "status": "draft",
                "created_at": datetime(2025, 1, 1),
                "started_at": None,
                "completed_at": None,
            }

            result = ProductionService.create_production_lot(
                process_id=6, user_id=1, quantity=50, lot_number="CUSTOM-LOT-123"
            )

            assert result["lot_number"] == "CUSTOM-LOT-123"
            assert result["quantity"] == 50

    @patch("app.services.production_service.CostingService.calculate_process_total_cost")
    def test_create_production_lot_single_quantity(self, mock_costing):
        """Test creating production lot with quantity=1 (default)."""
        mock_costing.return_value = {"totals": {"grand_total": 1000.00}}

        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 3,
                "process_id": 7,
                "lot_number": "LOT-2025-0003",
                "user_id": 2,
                "quantity": 1,
                "worst_case_estimated_cost": 1000.00,
                "actual_cost": None,
                "status": "draft",
                "created_at": datetime(2025, 1, 1),
                "started_at": None,
                "completed_at": None,
            }

            result = ProductionService.create_production_lot(
                process_id=7, user_id=2, quantity=1
            )

            assert result["quantity"] == 1
            assert result["worst_case_estimated_cost"] == 1000.00

    def test_get_production_lot_found(self):
        """Test retrieving an existing production lot."""
        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.side_effect = [
                {
                    "id": 1,
                    "process_id": 5,
                    "lot_number": "LOT-2025-0001",
                    "user_id": 1,
                    "quantity": 100,
                    "worst_case_estimated_cost": 100000.00,
                    "status": "draft",
                    "created_at": "2025-01-01T00:00:00",
                    "process_name": "Assembly Process",
                    "process_description": "Standard assembly",
                    "created_by": "John Doe",
                },
                None,  # For selections query
            ]

            result = ProductionService.get_production_lot(lot_id=1)

            assert result is not None
            assert result["id"] == 1
            assert result["lot_number"] == "LOT-2025-0001"

    def test_get_production_lot_not_found(self):
        """Test retrieving non-existent production lot."""
        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = None

            result = ProductionService.get_production_lot(lot_id=999)

            assert result is None

    def test_get_production_lot_without_selections(self):
        """Test retrieving production lot without selections."""
        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 2,
                "process_id": 6,
                "lot_number": "LOT-2025-0002",
                "user_id": 1,
                "quantity": 50,
                "worst_case_estimated_cost": 25000.00,
                "status": "in_progress",
                "created_at": "2025-01-01T00:00:00",
                "process_name": "QA Process",
                "process_description": "Quality assurance",
                "created_by": "Jane Smith",
            }

            result = ProductionService.get_production_lot(
                lot_id=2, include_selections=False
            )

            assert result is not None
            assert result["id"] == 2
            assert result["status"] == "in_progress"

    @patch("app.services.production_service.CostingService.calculate_process_total_cost")
    def test_create_production_lot_cost_calculation(self, mock_costing):
        """Test that cost calculation is performed correctly."""
        mock_costing.return_value = {"totals": {"grand_total": 250.00}}

        with patch("app.services.production_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 4,
                "process_id": 8,
                "lot_number": "LOT-2025-0004",
                "user_id": 3,
                "quantity": 200,
                "worst_case_estimated_cost": 50000.00,
                "actual_cost": None,
                "status": "draft",
                "created_at": datetime(2025, 1, 1),
                "started_at": None,
                "completed_at": None,
            }

            result = ProductionService.create_production_lot(
                process_id=8, user_id=3, quantity=200
            )

            # Verify costing service was called with correct process_id
            mock_costing.assert_called_once_with(8)
            # Verify cost calculation: 250.00 * 200 = 50000.00
            assert result["worst_case_estimated_cost"] == 50000.00

    def test_production_service_stateless(self):
        """Verify service doesn't maintain state between calls."""
        with patch(
            "app.services.production_service.CostingService.calculate_process_total_cost"
        ) as mock_costing:
            mock_costing.return_value = {"totals": {"grand_total": 100.00}}

            with patch(
                "app.services.production_service.database.get_conn"
            ) as mock_conn:
                mock_cursor = MagicMock()
                mock_connection = MagicMock()
                mock_conn.return_value.__enter__.return_value = (
                    mock_connection,
                    mock_cursor,
                )

                mock_cursor.fetchone.side_effect = [
                    {
                        "id": 1,
                        "process_id": 5,
                        "lot_number": "LOT-1",
                        "user_id": 1,
                        "quantity": 10,
                        "worst_case_estimated_cost": 1000.00,
                        "actual_cost": None,
                        "status": "draft",
                        "created_at": datetime(2025, 1, 1),
                        "started_at": None,
                        "completed_at": None,
                    },
                    {
                        "id": 2,
                        "process_id": 6,
                        "lot_number": "LOT-2",
                        "user_id": 2,
                        "quantity": 20,
                        "worst_case_estimated_cost": 2000.00,
                        "actual_cost": None,
                        "status": "draft",
                        "created_at": datetime(2025, 1, 2),
                        "started_at": None,
                        "completed_at": None,
                    },
                ]

                lot1 = ProductionService.create_production_lot(
                    process_id=5, user_id=1, quantity=10, lot_number="LOT-1"
                )
                lot2 = ProductionService.create_production_lot(
                    process_id=6, user_id=2, quantity=20, lot_number="LOT-2"
                )

                assert lot1["id"] == 1
                assert lot2["id"] == 2
                assert lot1["lot_number"] != lot2["lot_number"]
                assert lot1["quantity"] != lot2["quantity"]
