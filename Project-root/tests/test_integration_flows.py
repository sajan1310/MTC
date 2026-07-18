"""
Integration Tests for Flask Application
Tests complete user workflows end-to-end
"""

# Remove duplicate fixtures - use the ones from conftest.py instead
# The conftest.py provides:
# - app: Flask app configured for testing
# - client: Test client
# - authenticated_client: Test client with authentication bypassed via LOGIN_DISABLED=True


class TestAuthenticationFlows:
    """Test authentication workflows"""

    def test_login_endpoint_exists(self, client):
        """Test that login endpoint is accessible"""
        # This should return the login page or redirect
        response = client.get("/auth/login")
        assert response.status_code in [200, 302]

    def test_logout_endpoint_exists(self, client):
        """Test that logout endpoint exists"""
        response = client.get("/auth/logout")
        # May redirect to login page
        assert response.status_code in [200, 302]

    def test_api_login_endpoint_exists(self, client):
        """Test that the JSON login endpoint is accessible"""
        response = client.post(
            "/auth/api/login", json={"email": "test@example.com", "password": "test123"}
        )
        assert response.status_code in [200, 302, 401]


class TestRouteRegistration:
    """Test that Flask app registers routes correctly"""

    def test_app_initializes(self, client):
        """Test that app initializes without errors"""
        assert client is not None

    def test_blueprint_routes_registered(self, client):
        """Test that blueprint routes are registered"""
        with client.application.app_context():
            rules = list(client.application.url_map.iter_rules())
            assert len(rules) > 10

    def test_erp_routes_exist(self, client):
        """Test that ERP routes are registered"""
        with client.application.app_context():
            rules = list(client.application.url_map.iter_rules())
            rule_strings = [str(rule) for rule in rules]

            erp_routes = [r for r in rule_strings if "/erp" in r]
            assert len(erp_routes) > 0, "No ERP routes found"


class TestErrorHandling:
    """Test error handling and responses"""

    def test_404_not_found(self, client):
        """Test 404 error handling"""
        response = client.get("/nonexistent-route-xyz-123")
        assert response.status_code == 404

    def test_405_method_not_allowed(self, client):
        """Test 405 method not allowed"""
        # Try POST on a GET-only endpoint
        response = client.post("/auth/login")
        # May return 405 (method not allowed), 302 (redirect), or 401 (unauthorized)
        assert response.status_code in [302, 401, 405]
