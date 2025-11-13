import pytest


def test_app_creation(app):
    """Test that the Flask app is created."""
    assert app is not None


@pytest.mark.parametrize(
    "path, expected_status",
    [
        ("/login", 200),
        ("/dashboard", [200, 302]),  # 200 with LOGIN_DISABLED, 302 normally
        ("/inventory", [200, 302]),
    ("/suppliers/view", [200, 302]),
        ("/purchase-orders", [200, 302]),
    ],
)
def test_pages_load(client, path, expected_status):
    """Test that key pages load with the correct status code."""
    response = client.get(path)
    if isinstance(expected_status, list):
        assert response.status_code in expected_status
    else:
        assert response.status_code == expected_status
