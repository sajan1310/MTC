"""Test the new Select2 variants endpoint"""
import sys
sys.path.insert(0, '.')

from flask import Flask
import database
from config import Config
from app.api.routes import api_bp

def test_select2_endpoint():
    # Initialize Flask app and database
    app = Flask(__name__)
    app.config.from_object(Config)
    app.register_blueprint(api_bp, url_prefix='/api')
    database.init_app(app)
    
    with app.test_client() as client:
        # Test without search term
        print("Testing /api/variants/select2 without search term...")
        response = client.get('/api/variants/select2')
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.get_json()
            print(f"Results: {len(data.get('results', []))}")
            print(f"Has more: {data.get('pagination', {}).get('more', False)}")
            if data.get('results'):
                print(f"First result: {data['results'][0]}")
        else:
            print(f"Error: {response.data}")
        
        print("\n" + "="*50 + "\n")
        
        # Test with search term
        print("Testing /api/variants/select2 with search term 'paint'...")
        response = client.get('/api/variants/select2?q=paint')
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.get_json()
            print(f"Results: {len(data.get('results', []))}")
            print(f"Has more: {data.get('pagination', {}).get('more', False)}")
            if data.get('results'):
                print(f"First 3 results:")
                for i, result in enumerate(data['results'][:3], 1):
                    print(f"  {i}. {result.get('text')} (ID: {result.get('id')})")
        else:
            print(f"Error: {response.data}")
        
        print("\n" + "="*50 + "\n")
        
        # Test pagination
        print("Testing /api/variants/select2 with pagination (page 2)...")
        response = client.get('/api/variants/select2?page=2&page_size=10')
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.get_json()
            print(f"Results on page 2: {len(data.get('results', []))}")
            print(f"Has more: {data.get('pagination', {}).get('more', False)}")
        else:
            print(f"Error: {response.data}")

if __name__ == '__main__':
    try:
        test_select2_endpoint()
        print("\n✅ All endpoint tests completed!")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
