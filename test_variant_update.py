"""Test script to debug variant usage update errors."""
import requests
import json

# Test the variant usage update endpoint
url = "http://127.0.0.1:5000/api/upf/variant_usage/14"

# Payload
payload = {
    "quantity": 2.0,
    "cost_per_unit": 10.50
}

print(f"Testing PUT {url}")
print(f"Payload: {json.dumps(payload, indent=2)}")

try:
    response = requests.put(
        url,
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    
    print(f"\nStatus Code: {response.status_code}")
    print(f"Response Headers: {dict(response.headers)}")
    print(f"\nResponse Body:")
    print(json.dumps(response.json(), indent=2))
    
except Exception as e:
    print(f"\nError: {e}")
    print(f"Response Text: {response.text if 'response' in locals() else 'No response'}")
