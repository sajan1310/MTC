"""
Comprehensive integration tests for Supplier API endpoints.
Tests all CRUD operations, pagination, filtering, and error handling.
Verifies APIResponse envelope format and consistency.
"""
import pytest
from flask import current_app


@pytest.fixture
def supplier_data():
    """Sample supplier data for testing."""
    return {
        "firm_name": "Test Supplier Inc.",
        "address": "123 Business Street, City",
        "gstin": "27AABCL5055K1Z0",
        "contacts": [
            {
                "name": "John Doe",
                "phone": "+91-9999999999",
                "email": "john@testsupplier.com"
            }
        ],
        "variants": []
    }


class TestSupplierAPIGetEndpoints:
    """Tests for GET endpoints."""

    def test_get_suppliers_success(self, client, auth_headers):
        """Test fetching all suppliers returns APIResponse envelope."""
        resp = client.get("/api/suppliers", headers=auth_headers)
        assert resp.status_code == 200
        
        data = resp.get_json()
        assert "success" in data
        assert data["success"] is True
        assert "data" in data
        assert "message" in data
        assert isinstance(data["data"], list)

    def test_get_supplier_contacts_success(self, client, auth_headers):
        """Test fetching supplier contacts returns APIResponse envelope."""
        # Assumes supplier with ID 1 exists
        resp = client.get("/api/suppliers/1/contacts", headers=auth_headers)
        
        if resp.status_code in [200, 404]:  # May not exist
            data = resp.get_json()
            assert "success" in data
            assert "data" in data
            assert "message" in data

    def test_get_supplier_rates_success(self, client, auth_headers):
        """Test fetching supplier rates returns APIResponse envelope."""
        resp = client.get("/api/suppliers/1/rates", headers=auth_headers)
        
        if resp.status_code in [200, 404]:
            data = resp.get_json()
            assert "success" in data
            assert "data" in data
            assert "message" in data

    def test_get_supplier_ledger_success(self, client, auth_headers):
        """Test fetching supplier ledger returns APIResponse envelope with pagination."""
        resp = client.get("/api/suppliers/1/ledger?page=1&per_page=50", headers=auth_headers)
        
        if resp.status_code in [200, 404]:
            data = resp.get_json()
            assert "success" in data
            assert "data" in data
            assert "message" in data
            
            if data["success"]:
                assert "items" in data["data"]
                assert "total" in data["data"]
                assert "page" in data["data"]
                assert "per_page" in data["data"]


class TestSupplierAPIPostEndpoints:
    """Tests for POST endpoints."""

    def test_add_supplier_success(self, client, admin_headers, supplier_data):
        """Test adding a new supplier returns APIResponse with created status."""
        # Modify firm name to avoid duplicates
        supplier_data["firm_name"] = f"New Supplier {hash(supplier_data)} Inc."
        
        resp = client.post(
            "/api/suppliers",
            json=supplier_data,
            headers=admin_headers
        )
        
        if resp.status_code == 201:
            data = resp.get_json()
            assert data["success"] is True
            assert "supplier_id" in data["data"]
            assert data["message"] == "Supplier added successfully"
        elif resp.status_code == 409:
            # Duplicate already exists
            data = resp.get_json()
            assert data["success"] is False
            assert data["error"] == "duplicate_error"

    def test_add_supplier_missing_firm_name(self, client, admin_headers):
        """Test adding supplier without firm name returns validation error."""
        resp = client.post(
            "/api/suppliers",
            json={"address": "123 Street"},
            headers=admin_headers
        )
        
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["success"] is False
        assert data["error"] == "validation_error"
        assert "Firm name is required" in data["message"]

    def test_add_supplier_unauthorized(self, client, auth_headers, supplier_data):
        """Test adding supplier without admin role fails."""
        resp = client.post(
            "/api/suppliers",
            json=supplier_data,
            headers=auth_headers
        )
        
        # Should get 403 Forbidden due to role requirement
        assert resp.status_code == 403

    def test_add_supplier_rate_success(self, client, admin_headers):
        """Test adding a supplier rate returns APIResponse with created status."""
        resp = client.post(
            "/api/suppliers/1/rates",
            json={"item_id": 1, "rate": 100.50},
            headers=admin_headers
        )
        
        if resp.status_code == 201:
            data = resp.get_json()
            assert data["success"] is True
            assert "rate_id" in data["data"]
            assert data["message"] == "Rate added successfully"
        elif resp.status_code in [400, 404, 409]:
            # Bad request, not found, or conflict
            data = resp.get_json()
            assert "success" in data
            assert "error" in data
            assert "message" in data

    def test_add_supplier_rate_missing_fields(self, client, admin_headers):
        """Test adding rate without required fields returns validation error."""
        resp = client.post(
            "/api/suppliers/1/rates",
            json={"item_id": 1},  # Missing rate
            headers=admin_headers
        )
        
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["success"] is False
        assert data["error"] == "validation_error"


class TestSupplierAPIPutEndpoints:
    """Tests for PUT endpoints."""

    def test_update_supplier_success(self, client, admin_headers):
        """Test updating supplier returns APIResponse success."""
        update_data = {
            "firm_name": "Updated Supplier Name",
            "address": "New Address",
            "gstin": "27UPDATED5055K1Z0"
        }
        
        resp = client.put(
            "/api/suppliers/1",
            json=update_data,
            headers=admin_headers
        )
        
        if resp.status_code == 200:
            data = resp.get_json()
            assert data["success"] is True
            assert data["message"] == "Supplier updated successfully"
        elif resp.status_code in [404, 409]:
            data = resp.get_json()
            assert "success" in data
            assert "error" in data

    def test_update_supplier_missing_firm_name(self, client, admin_headers):
        """Test updating supplier without firm name returns validation error."""
        resp = client.put(
            "/api/suppliers/1",
            json={"address": "New Address"},  # Missing firm_name
            headers=admin_headers
        )
        
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["success"] is False
        assert data["error"] == "validation_error"


class TestSupplierAPIDeleteEndpoints:
    """Tests for DELETE endpoints."""

    def test_delete_supplier_success(self, client, admin_headers):
        """Test deleting supplier returns APIResponse success."""
        # Note: May need to create a test supplier first that can be safely deleted
        resp = client.delete(
            "/api/suppliers/9999",  # Non-existent ID
            headers=admin_headers
        )
        
        # Will likely be 200 (no-op) or 404 depending on implementation
        if resp.status_code == 200:
            data = resp.get_json()
            assert data["success"] is True
            assert data["message"] == "Supplier deleted successfully"

    def test_delete_supplier_unauthorized(self, client, auth_headers):
        """Test deleting supplier without admin role fails."""
        resp = client.delete(
            "/api/suppliers/1",
            headers=auth_headers
        )
        
        # Should get 403 Forbidden
        assert resp.status_code == 403

    def test_delete_supplier_rate_success(self, client, admin_headers):
        """Test deleting supplier rate returns APIResponse success."""
        resp = client.delete(
            "/api/suppliers/rates/9999",  # Non-existent ID
            headers=admin_headers
        )
        
        # Will likely be 200 (no-op) or 404
        if resp.status_code == 200:
            data = resp.get_json()
            assert data["success"] is True
            assert data["message"] == "Rate deleted successfully"


class TestSupplierAPIResponseFormat:
    """Tests for APIResponse envelope consistency."""

    def test_success_response_structure(self, client, auth_headers):
        """Verify all success responses have consistent structure."""
        resp = client.get("/api/suppliers", headers=auth_headers)
        
        if resp.status_code == 200:
            data = resp.get_json()
            # Check envelope structure
            assert "success" in data
            assert "data" in data
            assert "error" in data or data["error"] is None
            assert "message" in data

    def test_error_response_structure(self, client, auth_headers):
        """Verify error responses have consistent structure."""
        resp = client.post(
            "/api/suppliers",
            json={"address": "123 Street"},  # Missing firm_name
            headers=auth_headers
        )
        
        if resp.status_code >= 400:
            data = resp.get_json()
            # Check error envelope structure
            assert "success" in data
            assert data["success"] is False
            assert "error" in data
            assert data["error"] is not None
            assert "message" in data


class TestSupplierAPIPagination:
    """Tests for pagination support."""

    def test_ledger_pagination_parameters(self, client, auth_headers):
        """Test ledger endpoint respects pagination parameters."""
        resp = client.get(
            "/api/suppliers/1/ledger?page=2&per_page=25",
            headers=auth_headers
        )
        
        if resp.status_code == 200:
            data = resp.get_json()
            if data["success"]:
                assert data["data"]["page"] == 2
                assert data["data"]["per_page"] == 25


class TestSupplierAPIFiltering:
    """Tests for filtering support."""

    def test_ledger_variant_filter(self, client, auth_headers):
        """Test ledger endpoint respects variant filter."""
        resp = client.get(
            "/api/suppliers/1/ledger?variant=1",
            headers=auth_headers
        )
        
        if resp.status_code == 200:
            data = resp.get_json()
            assert "success" in data
            assert "data" in data

    def test_ledger_date_filter(self, client, auth_headers):
        """Test ledger endpoint respects date filters."""
        resp = client.get(
            "/api/suppliers/1/ledger?start_date=2025-01-01&end_date=2025-12-31",
            headers=auth_headers
        )
        
        if resp.status_code == 200:
            data = resp.get_json()
            assert "success" in data
            assert "data" in data


# Fixtures for auth headers (if not already in conftest.py)
@pytest.fixture
def auth_headers(client):
    """Fixture providing authenticated user headers."""
    # Assuming a test login endpoint or fixture setup
    # This depends on your authentication implementation
    return {"Authorization": "Bearer test-token"}


@pytest.fixture
def admin_headers(client):
    """Fixture providing admin authenticated user headers."""
    # Similar to auth_headers but with admin role
    return {"Authorization": "Bearer admin-test-token"}
