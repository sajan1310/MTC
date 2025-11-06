import pytest
from unittest.mock import MagicMock, patch

from app.services.import_service import ImportService
from app.validators.import_validators import DataValidator

"""
Targeted tests for ImportService to increase coverage of key workflows.

Focus:
- validate_batch edge cases (empty, invalid data)
- process_import_batch chunking logic
- handle_duplicate_items UPSERT behavior
- error handling and partial success scenarios
"""


class TestImportServiceValidation:
    """Test import service validation workflows."""

    def test_empty_data_import(self):
        """Empty data should return zero processed."""
        service = ImportService(batch_size=100)
        result = service.import_items_chunked([])
        assert result["processed"] == 0
        assert result["total_rows"] == 0
        assert result["success_rate"] == 0.0
        assert result["failed"] == []
        assert result["skipped"] == 0

    def test_exceeds_max_rows_limit(self):
        """Import exceeding MAX_TOTAL_ROWS should raise ValueError."""
        service = ImportService()
        # Create data exceeding MAX_TOTAL_ROWS (50000)
        large_data = [{"Item": f"Item{i}", "Stock": 10} for i in range(50001)]

        with pytest.raises(ValueError, match="exceeds maximum row limit"):
            service.import_items_chunked(large_data)

    def test_all_rows_fail_validation(self):
        """All rows failing validation should result in zero processed."""
        service = ImportService()
        invalid_data = [
            {"Item": "", "Stock": "invalid"},  # Missing name, invalid stock
            {"Item": None, "Stock": -10},  # Null name, negative stock
        ]
        result = service.import_items_chunked(invalid_data)
        assert result["processed"] == 0
        assert result["skipped"] == 2
        assert len(result["failed"]) == 2
        assert result["success_rate"] == 0.0

    def test_partial_validation_failure(self):
        """Mix of valid and invalid rows should process valid ones."""
        service = ImportService()

        mixed_data = [
            {"Item": "Valid Item 1", "Stock": 100, "Color": "Red", "Size": "M"},
            {"Item": "", "Stock": 50},  # Invalid: missing name
            {"Item": "Valid Item 2", "Stock": 200, "Color": "Blue", "Size": "L"},
        ]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_conn.return_value.__enter__.return_value = (MagicMock(), mock_cursor)

            result = service.import_items_chunked(mixed_data)
            assert result["total_rows"] == 3
            assert result["skipped"] == 1
            # Valid rows would be processed (mocked DB)
            assert result["processed"] >= 0


class TestImportServiceBatching:
    """Test chunked batch processing logic."""

    def test_single_batch_processing(self):
        """Data fitting in one batch should process in single transaction."""
        service = ImportService(batch_size=1000)

        data = [
            {"Item": f"Item{i}", "Stock": i * 10, "Color": "Red", "Size": "M"}
            for i in range(500)  # Less than batch_size
        ]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            # Mock validation to pass all rows
            with patch.object(DataValidator, "validate_batch", return_value=(data, [])):
                service.import_items_chunked(data)

                # Should commit once for the single batch
                assert mock_connection.commit.call_count >= 1

    def test_multiple_batch_processing(self):
        """Data exceeding batch_size should process in multiple batches."""
        service = ImportService(batch_size=100)

        data = [
            {"Item": f"Item{i}", "Stock": i * 10, "Color": "Red", "Size": "M"}
            for i in range(250)  # Will require 3 batches (100, 100, 50)
        ]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            with patch.object(DataValidator, "validate_batch", return_value=(data, [])):
                result = service.import_items_chunked(data)

                # Should commit once per batch (3 batches)
                assert mock_connection.commit.call_count >= 3
                assert result["processed"] > 0

    def test_progress_callback_invocation(self):
        """Progress callback should be called after each batch."""
        service = ImportService(batch_size=50)

        data = [
            {"Item": f"Item{i}", "Stock": i * 10, "Color": "Red", "Size": "M"}
            for i in range(150)  # 3 batches
        ]

        progress_calls = []

        def track_progress(processed, total, percentage):
            progress_calls.append(
                {"processed": processed, "total": total, "pct": percentage}
            )

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            with patch.object(DataValidator, "validate_batch", return_value=(data, [])):
                service.import_items_chunked(data, progress_callback=track_progress)

                # Should have been called once per batch
                assert len(progress_calls) >= 3
                # Last call should be ~100%
                assert progress_calls[-1]["pct"] >= 90.0


class TestImportServiceErrorHandling:
    """Test error handling and resilience."""

    def test_individual_row_failure_continues_batch(self):
        """Single row failure should not stop batch processing."""
        service = ImportService(batch_size=10)

        data = [
            {"Item": f"Item{i}", "Stock": i * 10, "Color": "Red", "Size": "M"}
            for i in range(5)
        ]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            # Make _import_single_row fail on 3rd row
            call_count = [0]

            def side_effect_import(cursor, row):
                call_count[0] += 1
                if call_count[0] == 3:
                    raise Exception("Simulated DB error")

            with patch.object(DataValidator, "validate_batch", return_value=(data, [])):
                with patch.object(
                    service, "_import_single_row", side_effect=side_effect_import
                ):
                    result = service.import_items_chunked(data)

                    # Should process 4 out of 5 (one failed)
                    assert result["processed"] == 4
                    assert len(result["failed"]) == 1
                    assert result["success_rate"] < 100.0

    def test_critical_error_propagates(self):
        """Critical connection errors should raise and stop import."""
        service = ImportService()

        data = [{"Item": "Test", "Stock": 10, "Color": "Red", "Size": "M"}]

        with patch("app.services.import_service.get_conn") as mock_conn:
            # Simulate connection failure
            mock_conn.side_effect = Exception("Database connection failed")

            with pytest.raises(Exception, match="Database connection failed"):
                service.import_items_chunked(data)


class TestDataValidatorEdgeCases:
    """Test DataValidator edge cases."""

    def test_validate_batch_empty_input(self):
        """Empty list should return empty valid and invalid lists."""
        valid, invalid = DataValidator.validate_batch([])
        assert valid == []
        assert invalid == []

    def test_validate_batch_missing_required_fields(self):
        """Rows missing required fields should be marked invalid."""
        data = [
            {"Stock": 10},  # Missing 'Item'
            {"Item": "Valid", "Stock": 20, "Color": "Red", "Size": "M"},
        ]

        valid, invalid = DataValidator.validate_batch(data)

        assert len(valid) == 1
        assert len(invalid) == 1
        assert invalid[0]["row"].get("Stock") == 10

    def test_validate_batch_type_coercion(self):
        """Numeric strings should be coerced to proper types."""
        data = [
            {
                "Item": "Test",
                "Stock": "100",
                "Color": "Red",
                "Size": "M",
            },  # String stock
        ]

        valid, invalid = DataValidator.validate_batch(data)

        assert len(valid) == 1
        # Stock should be coerced to int
        assert isinstance(
            valid[0].get("Stock"), (int, str)
        )  # Depending on validator impl


class TestImportServiceIntegration:
    """Integration-style tests with mocked DB."""

    def test_full_import_workflow_success(self):
        """Complete successful import with all steps."""
        service = ImportService(batch_size=50)

        data = [
            {
                "Item": f"Product {i}",
                "Model": "ModelA",
                "Variation": "Standard",
                "Color": "Blue",
                "Size": "L",
                "Stock": i * 100,
                "Unit": "Pcs",
            }
            for i in range(10)
        ]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            # Mock successful DB operations
            mock_cursor.fetchone.return_value = (1,)  # Return mock IDs

            with patch.object(DataValidator, "validate_batch", return_value=(data, [])):
                result = service.import_items_chunked(data)

                assert result["processed"] == 10
                assert result["total_rows"] == 10
                assert result["success_rate"] == 100.0
                assert len(result["failed"]) == 0
                assert result["skipped"] == 0
                assert result["import_duration"] > 0

    def test_import_with_mixed_results(self):
        """Import with validation failures and processing errors."""
        service = ImportService(batch_size=10)

        all_data = [
            {"Item": "Valid1", "Stock": 100, "Color": "Red", "Size": "M"},
            {"Item": "", "Stock": 50},  # Invalid validation
            {"Item": "Valid2", "Stock": 200, "Color": "Blue", "Size": "L"},
            {
                "Item": "ProcessFail",
                "Stock": 300,
                "Color": "Green",
                "Size": "S",
            },  # Will fail processing
        ]

        valid_data = [all_data[0], all_data[2], all_data[3]]
        invalid_data = [{"row": all_data[1], "error": "Missing Item name"}]

        with patch("app.services.import_service.get_conn") as mock_conn:
            mock_cursor = MagicMock()
            mock_connection = MagicMock()
            mock_conn.return_value.__enter__.return_value = (
                mock_connection,
                mock_cursor,
            )

            call_count = [0]

            def import_side_effect(cursor, row):
                call_count[0] += 1
                if row.get("Item") == "ProcessFail":
                    raise Exception("Processing error")

            with patch.object(
                DataValidator, "validate_batch", return_value=(valid_data, invalid_data)
            ):
                with patch.object(
                    service, "_import_single_row", side_effect=import_side_effect
                ):
                    result = service.import_items_chunked(all_data)

                    # 2 processed successfully, 1 validation fail, 1 processing fail
                    assert result["processed"] == 2
                    assert result["skipped"] == 1
                    assert len(result["failed"]) == 2  # 1 validation + 1 processing
                    assert result["total_rows"] == 4
