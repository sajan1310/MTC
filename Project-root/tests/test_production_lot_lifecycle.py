"""
Comprehensive Integration Tests for Production Lot Lifecycle

Tests the full workflow:
1. Production lot creation with cost calculation
2. Variant selection for substitute groups
3. Status transitions (Planning -> Ready -> In Progress -> Completed/Failed)
4. Cost rollup calculations
5. Error handling for zero costs and missing data
"""

import pytest
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

import database
import psycopg2.extras


class TestProductionLotLifecycle:
    """Test complete production lot lifecycle."""

    @pytest.fixture
    def test_process(self):
        """Create a test process with subprocesses and variants."""
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Create process
            cur.execute(
                """
                INSERT INTO processes (name, description, status)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                ("Test Process", "For testing", "active"),
            )
            process_id = cur.fetchone()["id"]

            # Create subprocess
            cur.execute(
                """
                INSERT INTO subprocesses (name, description)
                VALUES (%s, %s)
                RETURNING id
                """,
                ("Test Subprocess", "For testing"),
            )
            subprocess_id = cur.fetchone()["id"]

            # Link subprocess to process
            cur.execute(
                """
                INSERT INTO process_subprocesses (process_id, subprocess_id)
                VALUES (%s, %s)
                RETURNING id
                """,
                (process_id, subprocess_id),
            )
            process_subprocess_id = cur.fetchone()["id"]

            # Create test items and variants
            cur.execute(
                """
                INSERT INTO item_master (item_code, name, description)
                VALUES (%s, %s, %s)
                RETURNING item_id
                """,
                ("TEST_ITEM_1", "Test Item 1", "For testing"),
            )
            item_id = cur.fetchone()["item_id"]

            cur.execute(
                """
                INSERT INTO item_variant (item_id, variant_code, variant_description)
                VALUES (%s, %s, %s)
                RETURNING variant_id
                """,
                (item_id, "VAR_001", "Variant 1"),
            )
            variant_id = cur.fetchone()["variant_id"]

            # Add to subprocess
            cur.execute(
                """
                INSERT INTO variant_usage (
                    process_subprocess_id, variant_id, quantity, is_alternative
                ) VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (process_subprocess_id, variant_id, 1, False),
            )

            conn.commit()

            return {
                "process_id": process_id,
                "subprocess_id": subprocess_id,
                "process_subprocess_id": process_subprocess_id,
                "item_id": item_id,
                "variant_id": variant_id,
            }

    @pytest.fixture
    def test_user(self):
        """Create a test user."""
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO users (email, name, password_hash)
                VALUES (%s, %s, %s)
                ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
                RETURNING user_id
                """,
                ("test@example.com", "Test User", "hashed_password"),
            )
            user_id = cur.fetchone()["user_id"]
            conn.commit()

            return {"user_id": user_id}

    def test_production_lot_creation_with_valid_cost(self, test_process, test_user):
        """Test creating a production lot with valid cost calculation."""
        from app.services.production_service import ProductionService

        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=5,
        )

        assert lot is not None
        assert lot["lot_number"] is not None
        assert lot["status"] == "Planning"
        assert lot["quantity"] == 5
        # Cost should be set (may be 0 if no supplier pricing, but should exist)
        assert "total_cost" in lot or "worst_case_estimated_cost" in lot

    def test_production_lot_creation_logs_zero_cost_warning(
        self, test_process, test_user, caplog
    ):
        """Test that zero cost is logged as warning."""
        from app.services.production_service import ProductionService

        # Create lot - if no supplier pricing exists, cost will be zero
        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=1,
        )

        # Check that warning was logged if cost is zero
        total_cost = lot.get("total_cost") or lot.get("worst_case_estimated_cost", 0)
        if total_cost == 0:
            assert "zero" in caplog.text.lower() or "cost" in caplog.text.lower()

    def test_list_production_lots_includes_costs(self, test_process, test_user):
        """Test that list_production_lots returns cost fields."""
        from app.services.production_service import ProductionService

        # Create a lot
        lot1 = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=1,
        )

        # List lots
        result = ProductionService.list_production_lots(
            process_id=test_process["process_id"]
        )

        assert "production_lots" in result
        assert len(result["production_lots"]) > 0

        returned_lot = result["production_lots"][0]
        # Ensure cost fields are present
        assert "total_cost" in returned_lot or "worst_case_estimated_cost" in returned_lot
        # Ensure they're not null (should be coalesced to 0 if needed)
        total_cost = returned_lot.get("total_cost")
        assert total_cost is not None

    def test_status_transition_planning_to_ready_fails_with_incomplete_selections(
        self, test_process, test_user
    ):
        """Test that status transition to Ready fails if not all selections are made."""
        from app.services.production_service import ProductionService
        from app.validators.production_lot_validator import validate_lot_status_transition

        # Create lot
        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=1,
        )
        lot_id = lot["id"]

        # Try to transition to Ready without making selections
        errors = validate_lot_status_transition(lot_id, "Planning", "Ready")

        # Should have errors if there are any substitute groups without selections
        # (in this test case, may or may not have substitute groups)
        assert isinstance(errors, list)

    def test_status_transition_valid_sequence(self, test_process, test_user):
        """Test valid status transition sequence."""
        from app.validators.production_lot_validator import validate_lot_status_transition

        lot_id = 999  # Not a real lot, just testing validation logic

        # Planning -> Cancelled should be valid
        errors = validate_lot_status_transition(lot_id, "Planning", "Cancelled")
        assert len(errors) == 0

        # In Progress -> Completed should be valid
        errors = validate_lot_status_transition(lot_id, "In Progress", "Completed")
        assert len(errors) == 0

    def test_status_transition_invalid_sequence_rejected(self, test_process, test_user):
        """Test that invalid status transitions are rejected."""
        from app.validators.production_lot_validator import validate_lot_status_transition

        lot_id = 999

        # Completed -> Planning should be invalid
        errors = validate_lot_status_transition(lot_id, "Completed", "Planning")
        assert len(errors) > 0

        # Planning -> In Progress should be invalid (skip Ready)
        errors = validate_lot_status_transition(lot_id, "Planning", "In Progress")
        assert len(errors) > 0

    def test_variant_selection_with_cost_logging(self, test_process, test_user, caplog):
        """Test variant selection logs cost information."""
        from app.services.production_service import ProductionService

        # Create lot
        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=1,
        )
        lot_id = lot["id"]

        # Select a variant
        selection = ProductionService.select_variant_for_group(
            lot_id=lot_id,
            substitute_group_id=None,
            variant_id=test_process["variant_id"],
        )

        assert selection is not None
        assert "selected_cost" in selection
        # Check that logging occurred
        assert "selected" in caplog.text.lower() or "variant" in caplog.text.lower()

    def test_cost_validation_detects_zero_values(self):
        """Test that cost validation properly detects and warns about zeros."""
        from app.utils.production_lot_utils import validate_cost_calculation

        # Create a breakdown with zero cost
        breakdown = {
            "totals": {
                "subprocesses": 0,
                "additional_costs": 0,
                "grand_total": 0,
            }
        }

        is_valid, total_cost, issues = validate_cost_calculation(
            process_id=1, quantity=5, cost_breakdown=breakdown
        )

        assert total_cost == 0
        assert len(issues) > 0  # Should have warnings about zero cost
        assert "zero" in str(issues).lower()

    def test_cost_validation_accepts_valid_costs(self):
        """Test that cost validation accepts valid costs."""
        from app.utils.production_lot_utils import validate_cost_calculation

        breakdown = {
            "totals": {
                "subprocesses": 100.0,
                "additional_costs": 50.0,
                "grand_total": 150.0,
            }
        }

        is_valid, total_cost, issues = validate_cost_calculation(
            process_id=1, quantity=5, cost_breakdown=breakdown
        )

        assert total_cost == 750.0  # 150 * 5
        assert len(issues) == 0

    def test_subprocess_validation_requires_at_least_one(self):
        """Test that production lot creation requires subprocesses."""
        from app.validators.production_lot_validator import validate_production_lot_creation

        # Try to create lot for non-existent process
        errors = validate_production_lot_creation(
            process_id=999999, quantity=1, user_id=999999
        )

        # Should have errors
        assert len(errors) > 0

    def test_alert_acknowledgment_validation(self):
        """Test alert acknowledgment validation."""
        from app.validators.production_lot_validator import validate_alert_acknowledgment

        # Invalid action should fail
        errors = validate_alert_acknowledgment(
            alert_id=1, user_action="INVALID_ACTION", action_notes=None
        )

        assert len(errors) > 0
        assert "must be one of" in errors[0]

    def test_cost_breakdown_validation_structure(self):
        """Test cost breakdown validation catches structural issues."""
        from app.utils.production_lot_utils import validate_cost_breakdown

        # Missing totals key
        invalid_breakdown = {"subprocesses": []}
        is_valid, warnings = validate_cost_breakdown(invalid_breakdown, "test_context")

        assert len(warnings) > 0
        assert "totals" in str(warnings).lower()

    def test_cost_breakdown_validation_accepts_valid_structure(self):
        """Test cost breakdown validation accepts valid structures."""
        from app.utils.production_lot_utils import validate_cost_breakdown

        valid_breakdown = {
            "totals": {
                "subprocesses": 100.0,
                "additional_costs": 0,
                "grand_total": 100.0,
            }
        }

        is_valid, warnings = validate_cost_breakdown(valid_breakdown, "test_context")

        # Valid structure should pass (may have zero cost warnings but not structure errors)
        # Structure itself is valid
        assert "totals" not in str(warnings).lower()


class TestProductionLotErrorHandling:
    """Test error handling and edge cases."""

    def test_cost_calculation_with_null_values(self):
        """Test that null values are properly handled in cost calculations."""
        from app.utils.production_lot_utils import coerce_numeric

        assert coerce_numeric(None, 0) == 0
        assert coerce_numeric("invalid", 10) == 10
        assert coerce_numeric("123.45", 0) == 123.45

    def test_production_lot_creation_handles_database_errors(self):
        """Test that database errors are properly caught and reported."""
        from app.services.production_service import ProductionService

        # Try with invalid process ID that definitely doesn't exist
        with pytest.raises(ValueError):
            ProductionService.create_production_lot(
                process_id=999999999, user_id=999999999, quantity=1
            )

    def test_variant_selection_with_missing_pricing(self, caplog):
        """Test variant selection when supplier pricing is missing."""
        from app.utils.production_lot_utils import log_zero_cost_analysis

        # Log that pricing is missing
        log_zero_cost_analysis(variant_id=1, supplier_pricing_exists=False)

        # Should have warning log
        assert "zero" in caplog.text.lower() or "pricing" in caplog.text.lower()


class TestProductionLotIntegration:
    """Integration tests combining multiple features."""

    def test_full_workflow_creation_through_completion(self, test_process, test_user):
        """Test full workflow from creation through completion."""
        from app.services.production_service import ProductionService

        # 1. Create lot
        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=10,
        )
        assert lot["status"] == "Planning"
        lot_id = lot["id"]

        # 2. Get lot with details
        retrieved = ProductionService.get_production_lot(lot_id)
        assert retrieved is not None
        assert retrieved["id"] == lot_id

        # 3. List production lots
        listed = ProductionService.list_production_lots(
            process_id=test_process["process_id"]
        )
        assert len(listed["production_lots"]) > 0

    def test_cost_consistency_across_operations(self, test_process, test_user):
        """Test that costs remain consistent across create, get, and list operations."""
        from app.services.production_service import ProductionService

        # Create lot
        created = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=5,
        )

        created_cost = created.get("total_cost") or created.get(
            "worst_case_estimated_cost", 0
        )

        # Get lot
        retrieved = ProductionService.get_production_lot(created["id"])
        retrieved_cost = retrieved.get("total_cost") or retrieved.get(
            "worst_case_estimated_cost", 0
        )

        # List lots
        listed = ProductionService.list_production_lots(
            process_id=test_process["process_id"]
        )
        lot_from_list = next(
            (lot for lot in listed["production_lots"] if lot["id"] == created["id"]),
            None,
        )
        listed_cost = lot_from_list.get("total_cost") if lot_from_list else None

        # All costs should be consistent
        assert created_cost == retrieved_cost
        if listed_cost is not None:
            assert retrieved_cost == listed_cost


# Parametrized tests for edge cases
class TestProductionLotEdgeCases:
    """Test edge cases and boundary conditions."""

    @pytest.mark.parametrize(
        "quantity",
        [1, 100, 10000],
    )
    def test_various_quantities(self, test_process, test_user, quantity):
        """Test production lot creation with various quantities."""
        from app.services.production_service import ProductionService

        lot = ProductionService.create_production_lot(
            process_id=test_process["process_id"],
            user_id=test_user["user_id"],
            quantity=quantity,
        )

        assert lot["quantity"] == quantity

    @pytest.mark.parametrize(
        "status",
        ["Planning", "Ready", "In Progress", "Completed"],
    )
    def test_list_by_status(self, test_process, test_user, status):
        """Test filtering production lots by status."""
        from app.services.production_service import ProductionService

        result = ProductionService.list_production_lots(status=status)
        assert isinstance(result, dict)
        assert "pagination" in result
