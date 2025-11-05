import pytest


def test_app_creation(app):
    """Test that the Flask app is created."""
    assert app is not None


@pytest.mark.parametrize(
    "path, expected_status",
    [
        ("/login", 200),
        ("/dashboard", 302),
        ("/inventory", 302),
        ("/suppliers", 302),
        ("/purchase-orders", 302),
    ],
)
def test_pages_load(client, path, expected_status):
    """Test that key pages load with the correct status code."""
    response = client.get(path)
    assert response.status_code == expected_status
