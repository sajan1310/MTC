/**
 * UPF API RESPONSE STANDARDIZATION
 * 
 * This file documents the standardization of API responses to ensure
 * frontend JavaScript can properly consume data across all endpoints.
 * 
 * Key changes:
 * 1. All list endpoints return { data: { items: [...] }, error: null }
 * 2. All variant_usage responses include 'id' field (AKA usage_id)
 * 3. All subprocess includes proper nesting
 * 4. Standardized error format { error, message, data }
 */

// ============================================
// RESPONSE STANDARDIZATION - BACKEND
// ============================================

// Process responses should include:
{
    "data": {
        "id": 1,
        "name": "Assembly Process",
        "description": "...",
        "class": "assembly",  // or process_class for compatibility
        "status": "active",
        "subprocesses": [
            {
                "process_subprocess_id": 10,  // Key for deletion
                "subprocess_id": 5,
                "subprocess_name": "Frame Assembly",
                "custom_name": null,
                "sequence_order": 1,
                "variants": [
                    {
                        "id": 100,  // variant_usage_id - CRITICAL for frontend tracking
                        "variant_id": 50,
                        "variant_name": "M4 Bolt",
                        "quantity": 10,
                        "cost_per_unit": 0.50,
                        "supplier_pricing": [...]
                    }
                ]
            }
        ]
    },
    "error": null
}

// Variant usage creation response should return:
{
    "data": {
        "id": 100,  // CRITICAL: usage_id for tracking/deletion
        "process_subprocess_id": 10,
        "variant_id": 50,
        "quantity": 10,
        "cost_per_unit": 0.50
    },
    "error": null
}

// ============================================
// FRONTEND CONSUMPTION PATTERNS
// ============================================

// When storing variant for deletion, use:
window.variantMap = {
    'subprocess_10_variant_50': {
        usage_id: 100,  // From API response.id
        variant_id: 50,
        subprocess_id: 10,
        process_subprocess_id: 10
    }
};

// When deleting variant, use usage_id:
DELETE /api/upf/variant_usage/100

// ============================================
// ENDPOINT VERIFICATION
// ============================================

// All critical endpoints verified as working:
// ✅ GET /api/upf/processes/<id>
// ✅ GET /api/upf/processes/<id>/structure
// ✅ POST /api/upf/processes/<id>/subprocesses
// ✅ DELETE /api/upf/process_subprocess/<id>
// ✅ POST /api/upf/processes/<id>/reorder_subprocesses
// ✅ POST /api/upf/variant_usage
// ✅ DELETE /api/upf/variant_usage/<id>
// ✅ GET /api/upf/production-lots/<id>
// ✅ POST /api/upf/production-lots

