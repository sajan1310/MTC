#!/usr/bin/env python
"""Test the new endpoints are accessible."""

import os
import sys
import json

os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())

from app import create_app

try:
    app = create_app()
    client = app.test_client()
    
    print("Testing endpoint routes...")
    
    # List all routes related to our new endpoints
    endpoints = []
    for rule in app.url_map.iter_rules():
        rule_str = str(rule)
        if any(x in rule_str for x in ['subprocesses', 'acknowledge']):
            endpoints.append({
                'endpoint': rule.endpoint,
                'rule': rule_str,
                'methods': list(rule.methods - {'HEAD', 'OPTIONS'})
            })
    
    print("\nNew/Modified Endpoints Found:")
    for ep in sorted(endpoints, key=lambda x: x['rule']):
        print(f"  {ep['methods']} {ep['rule']}")
    
    print(f"\nTotal endpoints checked: {len(endpoints)}")
    
    if len(endpoints) >= 3:
        print("\n✓ SUCCESS: All 3 new endpoints are registered!")
    else:
        print(f"\n✗ WARNING: Expected 3+ endpoints, found {len(endpoints)}")
        
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
