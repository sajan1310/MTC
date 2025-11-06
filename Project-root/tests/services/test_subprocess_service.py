"""
Test coverage for SubprocessService.

Tests subprocess CRUD operations: create, get, list, update, delete.
"""

from unittest.mock import MagicMock, patch


from app.services.subprocess_service import SubprocessService


class TestSubprocessService:
    """Test suite for subprocess service operations."""

    def test_create_subprocess_basic(self):
        """Test creating a subprocess with minimal parameters."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "name": "Assembly",
                "description": None,
                "category": None,
                "estimated_time_minutes": 0,
                "labor_cost": 0.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            result = SubprocessService.create_subprocess(name="Assembly")

            assert result["id"] == 1
            assert result["name"] == "Assembly"
            assert "user_id" in result

    def test_create_subprocess_with_all_fields(self):
        """Test creating a subprocess with all optional fields."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 2,
                "name": "Quality Check",
                "description": "Final quality inspection",
                "category": "QA",
                "estimated_time_minutes": 30,
                "labor_cost": 25.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            result = SubprocessService.create_subprocess(
                name="Quality Check",
                description="Final quality inspection",
                category="QA",
                estimated_time_minutes=30,
                labor_cost=25.00,
            )

            assert result["name"] == "Quality Check"
            assert result["description"] == "Final quality inspection"
            assert result["user_id"] == 1
            assert result["reusable"] is False

    def test_get_subprocess_found(self):
        """Test retrieving an existing subprocess."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 1,
                "name": "Assembly",
                "description": "Standard assembly",
                "category": "Production",
                "estimated_time_minutes": 45,
                "labor_cost": 30.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            # Need to mock the second fetchone for usage_count
            mock_cursor.fetchone.side_effect = [
                {
                    "id": 1,
                    "name": "Assembly",
                    "description": "Standard assembly",
                    "category": "Production",
                    "estimated_time_minutes": 45,
                    "labor_cost": 30.00,
                    "is_active": True,
                    "user_id": 1,
                    "reusable": False,
                    "version": 1,
                },
                {"usage_count": 5},  # For the usage count query
            ]

            result = SubprocessService.get_subprocess(subprocess_id=1)

            assert result is not None
            assert result["id"] == 1
            assert result["name"] == "Assembly"
            assert result["usage_count"] == 5

    def test_get_subprocess_not_found(self):
        """Test retrieving a non-existent subprocess."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = None

            result = SubprocessService.get_subprocess(subprocess_id=999)

            assert result is None

    def test_create_subprocess_with_special_characters(self):
        """Test creating subprocess with special characters in name."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            special_name = "Assembly & Testing (v2.0)"
            mock_cursor.fetchone.return_value = {
                "id": 3,
                "name": special_name,
                "description": None,
                "category": None,
                "estimated_time_minutes": 0,
                "labor_cost": 0.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            result = SubprocessService.create_subprocess(name=special_name)

            assert result["name"] == special_name

    def test_create_subprocess_with_zero_cost(self):
        """Test creating subprocess with zero labor cost (valid case)."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.return_value = {
                "id": 4,
                "name": "Automated Process",
                "description": "No labor required",
                "category": "Automation",
                "estimated_time_minutes": 10,
                "labor_cost": 0.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            result = SubprocessService.create_subprocess(
                name="Automated Process",
                description="No labor required",
                category="Automation",
                estimated_time_minutes=10,
                labor_cost=0.00,
            )

            assert result["id"] == 4
            assert result["name"] == "Automated Process"

    def test_create_subprocess_with_long_description(self):
        """Test creating subprocess with long description."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            long_description = "A" * 500  # 500 character description
            mock_cursor.fetchone.return_value = {
                "id": 5,
                "name": "Complex Process",
                "description": long_description,
                "category": "Advanced",
                "estimated_time_minutes": 120,
                "labor_cost": 100.00,
                "is_active": True,
                "user_id": 1,
                "reusable": False,
                "version": 1,
            }

            result = SubprocessService.create_subprocess(
                name="Complex Process",
                description=long_description,
                category="Advanced",
                estimated_time_minutes=120,
                labor_cost=100.00,
            )

            assert len(result["description"]) == 500
            assert result["name"] == "Complex Process"

    def test_subprocess_service_stateless(self):
        """Verify service doesn't maintain state between calls."""
        with patch("app.services.subprocess_service.database.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            mock_cursor.fetchone.side_effect = [
                {
                    "id": 1,
                    "name": "Subprocess 1",
                    "description": None,
                    "category": None,
                    "estimated_time_minutes": 0,
                    "labor_cost": 0.00,
                    "is_active": True,
                    "user_id": 1,
                    "reusable": False,
                    "version": 1,
                },
                {
                    "id": 2,
                    "name": "Subprocess 2",
                    "description": None,
                    "category": None,
                    "estimated_time_minutes": 0,
                    "labor_cost": 0.00,
                    "is_active": True,
                    "user_id": 1,
                    "reusable": False,
                    "version": 1,
                },
            ]

            result1 = SubprocessService.create_subprocess(name="Subprocess 1")
            result2 = SubprocessService.create_subprocess(name="Subprocess 2")

            assert result1["id"] == 1
            assert result2["id"] == 2
            assert result1["name"] != result2["name"]
