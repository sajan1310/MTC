# Testing Checklist

This checklist outlines the manual and automated tests that should be performed to verify the application's functionality.

## Manual Testing

### 1. Authentication

- [ ] **Login:**
    - [ ] Verify that a user can log in with valid credentials.
    - [ ] Verify that a user cannot log in with invalid credentials.
    - [ ] Verify that a user is redirected to the dashboard after a successful login.
- [ ] **Logout:**
    - [ ] Verify that a user can log out.
    - [ ] Verify that a user is redirected to the login page after logging out.

### 2. Navigation

- [ ] **Sidebar:**
    - [ ] Verify that all sidebar links are working correctly.
    - [ ] Verify that the "Master Data" link is only visible to admin and super_admin users.
    - [ ] Verify that the "User Management" link is only visible to super_admin users.
- [ ] **Breadcrumbs:**
    - [ ] Verify that the breadcrumbs are displayed correctly on all pages.

### 3. Inventory

- [ ] **Add Item:**
    - [ ] Verify that a new item can be added with all required fields.
    - [ ] Verify that a new item with variants can be added.
    - [ ] Verify that the item is displayed in the inventory list after being added.
- [ ] **Edit Item:**
    - [ ] Verify that an existing item can be edited.
    - [ ] Verify that the changes are reflected in the inventory list.
- [ ] **Delete Item:**
    - [ ] Verify that an existing item can be deleted.
    - [ ] Verify that the item is removed from the inventory list.
- [ ] **Search and Filter:**
    - [ ] Verify that the inventory can be searched by item name.
    - [ ] Verify that the inventory can be filtered by low stock.

### 4. Master Data

- [ ] **Colors:**
    - [ ] Verify that a new color can be added.
    - [ ] Verify that an existing color can be edited.
    - [ ] Verify that an existing color can be deleted.
- [ ] **Sizes:**
    - [ ] Verify that a new size can be added.
    - [ ] Verify that an existing size can be edited.
    - [ ] Verify that an existing size can be deleted.
- [ ] **Models:**
    - [ ] Verify that a new model can be added.
    - [ ] Verify that an existing model can be edited.
    - [ ] Verify that an existing model can be deleted.
- [ ] **Variations:**
    - [ ] Verify that a new variation can be added.
    - [ ] Verify that an existing variation can be edited.
    - [ ] Verify that an existing variation can be deleted.

## Automated Testing (Pytest)

The following is a basic set of `pytest` tests that can be used to verify the application's routes and database interactions.

```python
import pytest
from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_home_page(client):
    """Test that the home page redirects to the dashboard."""
    response = client.get('/')
    assert response.status_code == 302
    assert response.location == '/dashboard'

def test_dashboard_page(client):
    """Test that the dashboard page loads."""
    response = client.get('/dashboard')
    assert response.status_code == 200
    assert b'Dashboard' in response.data

def test_inventory_page(client):
    """Test that the inventory page loads."""
    response = client.get('/inventory')
    assert response.status_code == 200
    assert b'Inventory' in response.data

def test_add_item_page(client):
    """Test that the add item page loads."""
    response = client.get('/add_item')
    assert response.status_code == 200
    assert b'Add New Item' in response.data

def test_master_data_page(client):
    """Test that the master data page loads."""
    response = client.get('/master-data')
    assert response.status_code == 200
    assert b'Master Data Management' in response.data
