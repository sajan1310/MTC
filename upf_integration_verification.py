#!/usr/bin/env python3
"""
UPF Integration Verification Script

Tests the complete UPF workflow to verify all endpoints are working correctly.
"""

import requests
import json
import time

BASE_URL = "http://localhost:5000/api/upf"
HEADERS = {"Content-Type": "application/json"}

# Test user context
TEST_USER_ID = 1
TEST_PROCESS_ID = None
TEST_SUBPROCESS_ID = None
TEST_VARIANT_USAGE_ID = None

def test_create_process():
    """Test: Create a new process"""
    global TEST_PROCESS_ID
    print("\n[TEST 1] Creating process...")
    
    payload = {
        "name": f"Test Process {int(time.time())}",
        "description": "Integration test process",
        "class": "assembly",
        "status": "draft"
    }
    
    response = requests.post(f"{BASE_URL}/processes", json=payload, headers=HEADERS)
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code in [200, 201]:
        data = response.json()
        TEST_PROCESS_ID = data.get("data", {}).get("id")
        print(f"✅ Process created: {TEST_PROCESS_ID}")
        return True
    else:
        print("❌ Failed to create process")
        return False

def test_get_process():
    """Test: Get process details with structure"""
    if not TEST_PROCESS_ID:
        print("⚠️ Skipping: No TEST_PROCESS_ID")
        return False
    
    print(f"\n[TEST 2] Getting process {TEST_PROCESS_ID}...")
    
    response = requests.get(f"{BASE_URL}/processes/{TEST_PROCESS_ID}", headers=HEADERS)
    print(f"Status: {response.status_code}")
    data = response.json().get("data", {})
    print(f"Process: {data.get('name')}")
    print(f"Subprocesses: {len(data.get('subprocesses', []))}")
    
    if response.status_code == 200:
        print("✅ Process retrieved")
        return True
    else:
        print("❌ Failed to get process")
        return False

def test_get_process_structure():
    """Test: Get process full structure"""
    if not TEST_PROCESS_ID:
        print("⚠️ Skipping: No TEST_PROCESS_ID")
        return False
    
    print(f"\n[TEST 3] Getting process structure {TEST_PROCESS_ID}...")
    
    response = requests.get(f"{BASE_URL}/processes/{TEST_PROCESS_ID}/structure", headers=HEADERS)
    print(f"Status: {response.status_code}")
    data = response.json().get("data", {})
    print(f"Process: {data.get('name')}")
    print(f"Full structure keys: {list(data.keys())}")
    
    if response.status_code == 200:
        print("✅ Process structure retrieved")
        return True
    else:
        print("❌ Failed to get process structure")
        return False

def test_create_subprocess():
    """Test: Create a subprocess template"""
    global TEST_SUBPROCESS_ID
    print("\n[TEST 4] Creating subprocess...")
    
    payload = {
        "name": f"Test Subprocess {int(time.time())}",
        "description": "Integration test subprocess",
        "category": "assembly",
        "estimated_time_minutes": 30,
        "labor_cost": 50.00
    }
    
    response = requests.post(f"{BASE_URL}/subprocesses", json=payload, headers=HEADERS)
    print(f"Status: {response.status_code}")
    print(f"Response keys: {list(response.json().keys())}")
    
    if response.status_code in [200, 201]:
        data = response.json()
        TEST_SUBPROCESS_ID = data.get("data", {}).get("id")
        print(f"✅ Subprocess created: {TEST_SUBPROCESS_ID}")
        return True
    else:
        print("❌ Failed to create subprocess")
        return False

def test_add_subprocess_to_process():
    """Test: Add subprocess to process"""
    if not TEST_PROCESS_ID or not TEST_SUBPROCESS_ID:
        print("⚠️ Skipping: Missing TEST_PROCESS_ID or TEST_SUBPROCESS_ID")
        return False
    
    print(f"\n[TEST 5] Adding subprocess {TEST_SUBPROCESS_ID} to process {TEST_PROCESS_ID}...")
    
    payload = {
        "subprocess_id": TEST_SUBPROCESS_ID,
        "sequence_order": 1,
        "custom_name": "Main Assembly Step"
    }
    
    response = requests.post(
        f"{BASE_URL}/processes/{TEST_PROCESS_ID}/subprocesses",
        json=payload,
        headers=HEADERS
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code in [200, 201]:
        print("✅ Subprocess added to process")
        return True
    else:
        print("❌ Failed to add subprocess to process")
        return False

def test_list_processes():
    """Test: List processes"""
    print("\n[TEST 6] Listing processes...")
    
    response = requests.get(f"{BASE_URL}/processes?page=1&per_page=10", headers=HEADERS)
    print(f"Status: {response.status_code}")
    data = response.json().get("data", {})
    processes = data.get("processes", [])
    print(f"Found {len(processes)} processes")
    print(f"Response structure: {list(data.keys())}")
    
    if response.status_code == 200:
        print("✅ Processes listed")
        return True
    else:
        print("❌ Failed to list processes")
        return False

def test_production_lots():
    """Test: Production lot endpoints"""
    if not TEST_PROCESS_ID:
        print("⚠️ Skipping: No TEST_PROCESS_ID")
        return False
    
    print(f"\n[TEST 7] Creating production lot for process {TEST_PROCESS_ID}...")
    
    payload = {
        "process_id": TEST_PROCESS_ID,
        "quantity": 100,
        "notes": "Integration test lot"
    }
    
    response = requests.post(
        f"{BASE_URL}/production-lots",
        json=payload,
        headers=HEADERS
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code in [200, 201]:
        lot_id = response.json().get("data", {}).get("id")
        print(f"✅ Production lot created: {lot_id}")
        
        # Test get lot
        print(f"\n[TEST 7b] Getting production lot {lot_id}...")
        response = requests.get(f"{BASE_URL}/production-lots/{lot_id}", headers=HEADERS)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            print("✅ Production lot retrieved")
            return True
        else:
            print("❌ Failed to get production lot")
            return False
    else:
        print("❌ Failed to create production lot")
        return False

def main():
    """Run all tests"""
    print("=" * 60)
    print("UPF INTEGRATION VERIFICATION")
    print("=" * 60)
    
    tests = [
        test_create_process,
        test_get_process,
        test_get_process_structure,
        test_create_subprocess,
        test_add_subprocess_to_process,
        test_list_processes,
        test_production_lots,
    ]
    
    results = []
    for test in tests:
        try:
            result = test()
            results.append((test.__name__, result))
        except Exception as e:
            print(f"❌ Exception in {test.__name__}: {e}")
            results.append((test.__name__, False))
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    passed = sum(1 for _, r in results if r)
    total = len(results)
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed! UPF integration is working.")
    else:
        print(f"\n⚠️ {total - passed} tests failed. Review errors above.")

if __name__ == "__main__":
    main()
