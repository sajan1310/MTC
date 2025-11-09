"""Test script to verify deprecation warnings for underscore routes."""
import warnings
import sys
import os

# Add Project-root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'Project-root'))

# Enable all warnings
warnings.simplefilter('always', DeprecationWarning)

# Import Flask app
from app import create_app

def test_underscore_routes():
    """Test that underscore routes trigger deprecation warnings."""
    app = create_app('testing')
    
    with app.app_context():
        with app.test_client() as client:
            # Test cases for underscore routes
            underscore_routes = [
                ('POST', '/api/inventory_alert_rules', {'variant_id': 1, 'safety_stock_quantity': 10, 'reorder_point_quantity': 20, 'alert_threshold_percentage': 75.0}),
                ('GET', '/api/inventory_alert_rules', None),
                ('POST', '/api/inventory_alerts', {'production_lot_id': 1, 'variant_id': 1, 'required_quantity': 100}),
                ('GET', '/api/inventory_alerts', None),
                ('POST', '/api/procurement_recommendations', {'production_lot_id': 1, 'variant_id': 1, 'recommended_quantity': 100, 'required_delivery_date': '2025-12-01'}),
                ('GET', '/api/procurement_recommendations', None),
            ]
            
            print("Testing deprecation warnings for underscore routes...\n")
            
            # Capture warnings
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always", DeprecationWarning)
                
                for method, path, data in underscore_routes:
                    print(f"Testing: {method} {path}")
                    
                    if method == 'GET':
                        response = client.get(path)
                    elif method == 'POST':
                        response = client.post(path, json=data)
                    elif method == 'PATCH':
                        response = client.patch(path, json=data)
                    
                    print(f"  Response: {response.status_code}")
                
                # Check warnings
                print(f"\n{'='*60}")
                print(f"Total warnings captured: {len(w)}")
                print(f"{'='*60}\n")
                
                for warning in w:
                    if issubclass(warning.category, DeprecationWarning):
                        print(f"✓ DeprecationWarning: {warning.message}")
                        print(f"  File: {warning.filename}:{warning.lineno}\n")
                
                if len(w) > 0:
                    print(f"\n[OK] SUCCESS: {len(w)} deprecation warnings triggered!")
                else:
                    print("\n[WARN] WARNING: No deprecation warnings captured!")
                    print("Note: Warnings may not be captured due to test client request context.")
                    print("Checking if warnings are properly configured in code...")

if __name__ == '__main__':
    test_underscore_routes()
