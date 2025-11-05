# Universal Process Framework - API Reference

Complete REST API documentation for the Universal Process Framework. All endpoints require authentication and are prefixed with `/api/upf`.

## Table of Contents

1. [Process Management API](#process-management-api) - 16 endpoints
2. [Subprocess Management API](#subprocess-management-api) - 7 endpoints
3. [Variant Management API](#variant-management-api) - 12 endpoints
4. [Production Lot API](#production-lot-api) - 12 endpoints

**Total: 47 REST API endpoints**

---

## Authentication

All endpoints require authentication via Flask-Login session. Include CSRF token for state-changing operations (POST/PUT/DELETE).

**Headers:**
```
Cookie: session=<session_cookie>
X-CSRFToken: <csrf_token>
Content-Type: application/json
```

**Error Responses:**
- `401 Unauthorized` - Authentication required
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error

---

## Process Management API

### 1. Create Process
**POST** `/api/upf/process`

Create a new process.

**Rate Limit:** 20 per hour

**Request Body:**
```json
{
  "name": "Product Assembly Process",
  "description": "Main assembly line for Product X",
  "class": "assembly"  // assembly|testing|packaging|other
}
```

**Response:** `201 Created`
```json
{
  "id": 1,
  "name": "Product Assembly Process",
  "description": "Main assembly line for Product X",
  "class": "assembly",
  "user_id": 5,
  "status": "active",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

---

### 2. Get Process (Full Structure)
**GET** `/api/upf/process/<process_id>`

Get process with full nested structure (subprocesses, variants, costs, OR groups).

**Response:** `200 OK`
```json
{
  "id": 1,
  "name": "Product Assembly Process",
  "description": "...",
  "class": "assembly",
  "user_id": 5,
  "status": "active",
  "subprocesses": [
    {
      "id": 10,
      "name": "Component Installation",
      "sequence_order": 1,
      "custom_name": null,
      "variants": [...],
      "costs": [...],
      "substitute_groups": [...]
    }
  ],
  "total_worst_case_cost": 1234.56,
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

---

### 3. List Processes
**GET** `/api/upf/processes?page=1&per_page=25&status=active`

List processes with pagination.

**Query Parameters:**
- `page` (int): Page number (default: 1)
- `per_page` (int): Items per page (default: 25, max: 100)
- `status` (string): Filter by status (active|archived)

**Response:** `200 OK`
```json
{
  "processes": [...],
  "total": 150,
  "page": 1,
  "per_page": 25,
  "pages": 6
}
```

---

### 4. Update Process
**PUT** `/api/upf/process/<process_id>`

Update process details.

**Request Body:**
```json
{
  "name": "Updated Process Name",
  "description": "New description",
  "class": "testing",
  "status": "archived"
}
```

**Response:** `200 OK`

---

### 5. Delete Process
**DELETE** `/api/upf/process/<process_id>`

Soft delete a process (sets `deleted_at`).

**Response:** `204 No Content`

---

### 6. Restore Process
**POST** `/api/upf/process/<process_id>/restore`

Restore a soft-deleted process.

**Response:** `200 OK`
```json
{
  "message": "Process restored successfully"
}
```

---

### 7. Search Processes
**GET** `/api/upf/process/search?q=assembly`

Search processes by name or description.

**Query Parameters:**
- `q` (string): Search query (min 2 characters)

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "name": "Product Assembly Process",
    "description": "...",
    "class": "assembly"
  }
]
```

---

### 8. Add Subprocess to Process
**POST** `/api/upf/process/<process_id>/add_subprocess`

Add a subprocess to a process at a specific sequence position.

**Request Body:**
```json
{
  "subprocess_id": 10,
  "sequence_order": 2,
  "custom_name": "Custom Subprocess Name",
  "notes": "Special handling required"
}
```

**Response:** `201 Created`

---

### 9. Remove Subprocess from Process
**DELETE** `/api/upf/process_subprocess/<ps_id>`

Remove subprocess from process (deletes association).

**Response:** `204 No Content`

---

### 10. Reorder Subprocesses (Drag-and-Drop)
**POST** `/api/upf/process/<process_id>/reorder_subprocesses`

Reorder subprocesses within a process.

**Request Body:**
```json
{
  "sequence_map": {
    "45": 1,  // process_subprocess_id: new_sequence_order
    "46": 2,
    "47": 3
  }
}
```

**Response:** `200 OK`
```json
{
  "message": "Subprocesses reordered successfully"
}
```

---

### 11. Get Worst-Case Costing
**GET** `/api/upf/process/<process_id>/worst_case_costing`

Get complete worst-case cost breakdown (MAX supplier prices).

**Response:** `200 OK`
```json
{
  "process_id": 1,
  "total_cost": 1234.56,
  "subprocesses": [
    {
      "subprocess_id": 10,
      "subprocess_name": "Component Installation",
      "variants_cost": 450.00,
      "substitute_groups": [
        {
          "group_id": 5,
          "worst_case_variant": "Variant A",
          "worst_case_cost": 200.00
        }
      ],
      "labor_cost": 100.00,
      "overhead_cost": 50.00,
      "total_subprocess_cost": 800.00
    }
  ]
}
```

---

### 12. Get Profitability
**GET** `/api/upf/process/<process_id>/profitability`

Get profitability metrics for a process.

**Response:** `200 OK`
```json
{
  "process_id": 1,
  "estimated_sales_price": 2000.00,
  "worst_case_cost": 1234.56,
  "profit_margin": 38.27,
  "absolute_profit": 765.44,
  "break_even_quantity": 50,
  "last_calculated_at": "2024-01-15T10:30:00Z"
}
```

---

### 13. Set Sales Price
**POST** `/api/upf/process/<process_id>/set_sales_price`

Set estimated sales price and recalculate profitability.

**Request Body:**
```json
{
  "sales_price": 2500.00
}
```

**Response:** `200 OK`
(Returns updated profitability metrics)

---

### 14. Recalculate Worst-Case Costing
**POST** `/api/upf/process/<process_id>/recalculate_worst_case`

Force recalculation of worst-case costing and profitability.

**Response:** `200 OK`
```json
{
  "cost_breakdown": {...},
  "profitability": {...}
}
```

---

## Subprocess Management API

### 15. Create Subprocess
**POST** `/api/upf/subprocess`

Create reusable subprocess template.

**Rate Limit:** 30 per hour

**Request Body:**
```json
{
  "name": "Component Installation",
  "description": "Install component with screws",
  "type": "assembly",  // assembly|testing|packaging|other
  "duration_minutes": 15
}
```

**Response:** `201 Created`

---

### 16. Get Subprocess
**GET** `/api/upf/subprocess/<subprocess_id>`

Get subprocess with full details (variants, costs, OR groups).

**Response:** `200 OK`
```json
{
  "id": 10,
  "name": "Component Installation",
  "description": "...",
  "type": "assembly",
  "duration_minutes": 15,
  "variants": [...],
  "costs": [...],
  "substitute_groups": [...]
}
```

---

### 17. List Subprocesses
**GET** `/api/upf/subprocesses?page=1&per_page=25&type=assembly`

List subprocess templates.

**Query Parameters:**
- `page` (int): Page number
- `per_page` (int): Items per page (max 100)
- `type` (string): Filter by type

**Response:** `200 OK`

---

### 18. Update Subprocess
**PUT** `/api/upf/subprocess/<subprocess_id>`

Update subprocess template.

**Request Body:**
```json
{
  "name": "Updated Name",
  "description": "...",
  "type": "testing",
  "duration_minutes": 20
}
```

**Response:** `200 OK`

---

### 19. Delete Subprocess
**DELETE** `/api/upf/subprocess/<subprocess_id>`

Soft delete subprocess template.

**Response:** `204 No Content`

---

### 20. Duplicate Subprocess
**POST** `/api/upf/subprocess/<subprocess_id>/duplicate`

Duplicate subprocess with all variants and costs.

**Request Body:**
```json
{
  "new_name": "Component Installation (Copy)"
}
```

**Response:** `201 Created`

---

### 21. Search Subprocesses
**GET** `/api/upf/subprocess/search?q=install&type=assembly&limit=50`

Search subprocess templates.

**Query Parameters:**
- `q` (string): Search query (min 2 characters)
- `type` (string): Filter by type
- `limit` (int): Max results (default 50, max 100)

**Response:** `200 OK`

---

## Variant Management API

### 22. Add Variant Usage
**POST** `/api/upf/variant_usage`

Add variant to subprocess.

**Request Body:**
```json
{
  "subprocess_id": 10,
  "item_id": 500,  // From inventory.items table
  "quantity": 2.5,
  "unit": "pcs",
  "notes": "Use premium quality"
}
```

**Response:** `201 Created`

---

### 23. Update Variant Usage
**PUT** `/api/upf/variant_usage/<usage_id>`

Update variant quantity/unit.

**Request Body:**
```json
{
  "quantity": 3.0,
  "unit": "kg",
  "notes": "Updated notes"
}
```

**Response:** `200 OK`

---

### 24. Remove Variant Usage
**DELETE** `/api/upf/variant_usage/<usage_id>`

Remove variant from subprocess.

**Response:** `204 No Content`

---

### 25. Create Substitute Group (OR Feature)
**POST** `/api/upf/substitute_group`

Create OR group for subprocess (variants that can substitute each other).

**Request Body:**
```json
{
  "subprocess_id": 10,
  "variant_ids": [500, 501, 502],  // Min 2 variants
  "group_name": "Screw Options",
  "selection_logic": "manual"  // manual|cheapest|fastest|auto
}
```

**Response:** `201 Created`
```json
{
  "id": 5,
  "subprocess_id": 10,
  "group_name": "Screw Options",
  "selection_logic": "manual",
  "variants": [
    {
      "variant_id": 500,
      "item_name": "M4 Screw - Steel",
      "current_price": 0.50
    },
    {
      "variant_id": 501,
      "item_name": "M4 Screw - Stainless",
      "current_price": 0.75
    }
  ]
}
```

---

### 26. Delete Substitute Group
**DELETE** `/api/upf/substitute_group/<group_id>`

Delete OR group.

**Response:** `204 No Content`

---

### 27. Add Cost Item
**POST** `/api/upf/cost_item`

Add labor/overhead cost to subprocess.

**Request Body:**
```json
{
  "subprocess_id": 10,
  "cost_type": "labor",  // labor|overhead|tooling|other
  "amount": 50.00,
  "description": "Assembly labor",
  "unit": "per_unit"  // per_unit|per_hour|per_batch
}
```

**Response:** `201 Created`

---

### 28. Update Cost Item
**PUT** `/api/upf/cost_item/<cost_id>`

Update cost item.

**Request Body:**
```json
{
  "amount": 60.00,
  "description": "Updated description",
  "unit": "per_hour"
}
```

**Response:** `200 OK`

---

### 29. Remove Cost Item
**DELETE** `/api/upf/cost_item/<cost_id>`

Remove cost item.

**Response:** `204 No Content`

---

### 30. Add Supplier Pricing
**POST** `/api/upf/variant/<item_id>/supplier_pricing`

Add supplier pricing for a variant (multi-supplier support).

**Roles:** admin, inventory_manager

**Request Body:**
```json
{
  "supplier_id": 15,
  "unit_price": 0.50,
  "moq": 100,  // Minimum Order Quantity
  "lead_time_days": 7,
  "effective_date": "2024-01-15"
}
```

**Response:** `201 Created`

---

### 31. Get Variant Suppliers
**GET** `/api/upf/variant/<item_id>/supplier_pricing`

Get all supplier pricing for a variant.

**Response:** `200 OK`
```json
[
  {
    "id": 25,
    "supplier_id": 15,
    "supplier_name": "Acme Fasteners",
    "unit_price": 0.50,
    "moq": 100,
    "lead_time_days": 7,
    "effective_date": "2024-01-15",
    "is_active": true
  }
]
```

---

### 32. Update Supplier Pricing
**PUT** `/api/upf/supplier_pricing/<pricing_id>`

Update supplier pricing.

**Roles:** admin, inventory_manager

**Request Body:**
```json
{
  "unit_price": 0.55,
  "moq": 50,
  "lead_time_days": 5,
  "is_active": true
}
```

**Response:** `200 OK`

---

### 33. Remove Supplier Pricing
**DELETE** `/api/upf/supplier_pricing/<pricing_id>`

Remove supplier pricing.

**Roles:** admin, inventory_manager

**Response:** `204 No Content`

---

### 34. Search Variants (Autocomplete)
**GET** `/api/upf/variants/search?q=screw&category_id=5&in_stock_only=true&limit=50`

Search variants for autocomplete in drag-and-drop panel.

**Query Parameters:**
- `q` (string): Search query
- `category_id` (int): Filter by category
- `in_stock_only` (bool): Only show in-stock items
- `min_stock` (int): Minimum stock quantity
- `max_cost` (float): Maximum cost per unit
- `limit` (int): Max results (default 50, max 100)

**Response:** `200 OK`
```json
[
  {
    "item_id": 500,
    "name": "M4 Screw - Steel",
    "category_name": "Fasteners",
    "current_stock": 5000,
    "unit": "pcs",
    "avg_cost": 0.50,
    "supplier_count": 3,
    "min_price": 0.45,
    "max_price": 0.60
  }
]
```

---

### 35. Check Variant Availability
**GET** `/api/upf/variant/<item_id>/availability?quantity=100`

Check if variant has sufficient stock.

**Query Parameters:**
- `quantity` (float): Required quantity (default: 1)

**Response:** `200 OK`
```json
{
  "item_id": 500,
  "name": "M4 Screw - Steel",
  "current_stock": 5000,
  "required_quantity": 100,
  "is_available": true,
  "shortage": 0
}
```

---

## Production Lot API

### 36. Create Production Lot
**POST** `/api/upf/production_lot`

Create new production lot from a process.

**Rate Limit:** 50 per hour

**Request Body:**
```json
{
  "process_id": 1,
  "quantity": 100,
  "notes": "Rush order for customer XYZ"
}
```

**Response:** `201 Created`
```json
{
  "id": 50,
  "lot_number": "LOT-2024011510300001",
  "process_id": 1,
  "process_name": "Product Assembly Process",
  "quantity": 100,
  "status": "planning",
  "estimated_total_cost": 123456.00,
  "user_id": 5,
  "notes": "Rush order for customer XYZ",
  "created_at": "2024-01-15T10:30:00Z"
}
```

---

### 37. Get Production Lot
**GET** `/api/upf/production_lot/<lot_id>`

Get production lot with full details (selections, costs).

**Response:** `200 OK`
```json
{
  "id": 50,
  "lot_number": "LOT-2024011510300001",
  "process_id": 1,
  "quantity": 100,
  "status": "planning",  // planning|in_progress|completed|cancelled
  "estimated_total_cost": 123456.00,
  "actual_total_cost": null,
  "selections": [
    {
      "substitute_group_id": 5,
      "group_name": "Screw Options",
      "selected_variant_id": 501,
      "selected_variant_name": "M4 Screw - Stainless",
      "reason": "Better corrosion resistance"
    }
  ],
  "executed_at": null,
  "completed_at": null
}
```

---

### 38. List Production Lots
**GET** `/api/upf/production_lots?page=1&per_page=25&status=planning&process_id=1`

List production lots with pagination.

**Query Parameters:**
- `page` (int): Page number
- `per_page` (int): Items per page (max 100)
- `status` (string): Filter by status
- `process_id` (int): Filter by process

**Response:** `200 OK`

---

### 39. Select Variant for OR Group
**POST** `/api/upf/production_lot/<lot_id>/select_variant`

Select which variant to use from an OR group (core of OR feature).

**Request Body:**
```json
{
  "substitute_group_id": 5,
  "selected_variant_id": 501,
  "reason": "Better corrosion resistance for this application"
}
```

**Response:** `201 Created`

---

### 40. Get Lot Selections
**GET** `/api/upf/production_lot/<lot_id>/selections`

Get all variant selections for a lot.

**Response:** `200 OK`
```json
[
  {
    "substitute_group_id": 5,
    "group_name": "Screw Options",
    "selected_variant_id": 501,
    "selected_variant_name": "M4 Screw - Stainless",
    "reason": "Better corrosion resistance"
  }
]
```

---

### 41. Validate Lot Readiness
**POST** `/api/upf/production_lot/<lot_id>/validate`

Validate lot is ready for execution (all OR groups selected, stock available).

**Response:** `200 OK`
```json
{
  "is_ready": true,
  "missing_selections": [],
  "stock_shortages": [],
  "warnings": []
}
```

Or if not ready:
```json
{
  "is_ready": false,
  "missing_selections": [
    {
      "substitute_group_id": 6,
      "group_name": "Paint Options",
      "message": "Please select a variant from this OR group"
    }
  ],
  "stock_shortages": [
    {
      "item_id": 500,
      "item_name": "M4 Screw - Steel",
      "required": 200,
      "available": 150,
      "shortage": 50
    }
  ],
  "warnings": []
}
```

---

### 42. Execute Production Lot
**POST** `/api/upf/production_lot/<lot_id>/execute`

Execute production lot (deduct inventory, calculate actual costs, complete lot).

**Roles:** admin, inventory_manager, production_manager

**Response:** `200 OK`
```json
{
  "id": 50,
  "lot_number": "LOT-2024011510300001",
  "status": "completed",
  "estimated_total_cost": 123456.00,
  "actual_total_cost": 118234.00,
  "variance": -5222.00,
  "variance_percentage": -4.23,
  "executed_at": "2024-01-15T14:25:00Z",
  "completed_at": "2024-01-15T14:25:00Z"
}
```

---

### 43. Cancel Production Lot
**POST** `/api/upf/production_lot/<lot_id>/cancel`

Cancel production lot.

**Request Body:**
```json
{
  "reason": "Customer cancelled order"
}
```

**Response:** `200 OK`

---

### 44. Get Actual Costing
**GET** `/api/upf/production_lot/<lot_id>/actual_costing`

Get actual costing breakdown for lot.

**Response:** `200 OK`
```json
{
  "lot_id": 50,
  "lot_number": "LOT-2024011510300001",
  "total_actual_cost": 118234.00,
  "breakdown": [
    {
      "subprocess_id": 10,
      "subprocess_name": "Component Installation",
      "variants": [
        {
          "item_id": 501,
          "item_name": "M4 Screw - Stainless",
          "quantity": 200,
          "actual_unit_cost": 0.65,
          "actual_total_cost": 130.00
        }
      ],
      "labor_costs": [...],
      "overhead_costs": [...]
    }
  ]
}
```

---

### 45. Get Variance Analysis
**GET** `/api/upf/production_lot/<lot_id>/variance_analysis`

Get variance analysis (worst-case vs actual).

**Response:** `200 OK`
```json
{
  "lot_id": 50,
  "lot_number": "LOT-2024011510300001",
  "estimated_cost": 123456.00,
  "actual_cost": 118234.00,
  "variance": -5222.00,
  "variance_percentage": -4.23,
  "subprocess_variances": [
    {
      "subprocess_id": 10,
      "subprocess_name": "Component Installation",
      "estimated": 800.00,
      "actual": 750.00,
      "variance": -50.00,
      "reason": "Used cheaper supplier"
    }
  ]
}
```

---

### 46. Get Production Summary
**GET** `/api/upf/production_lots/summary`

Get production summary statistics.

**Response:** `200 OK`
```json
[
  {
    "status": "planning",
    "count": 15,
    "total_quantity": 1500,
    "avg_estimated_cost": 1234.56
  },
  {
    "status": "completed",
    "count": 50,
    "total_quantity": 5000,
    "avg_estimated_cost": 1200.00
  }
]
```

---

### 47. Get Recent Lots
**GET** `/api/upf/production_lots/recent?limit=10`

Get recently executed production lots.

**Query Parameters:**
- `limit` (int): Max results (default 10, max 50)

**Response:** `200 OK`

---

## Common Patterns

### Pagination Response
```json
{
  "items": [...],
  "total": 150,
  "page": 1,
  "per_page": 25,
  "pages": 6
}
```

### Error Response
```json
{
  "error": "Detailed error message"
}
```

### Soft Delete Pattern
All delete operations are soft deletes (set `deleted_at` timestamp). Deleted items are excluded from queries but retained for audit purposes.

### Audit Trail
All tables track:
- `created_at` - Creation timestamp
- `updated_at` - Last update timestamp
- `deleted_at` - Soft delete timestamp (NULL if active)

---

## Rate Limiting

Default limits (per IP address):
- **Global:** 200 per day, 50 per hour
- **Process creation:** 20 per hour
- **Subprocess creation:** 30 per hour
- **Production lot creation:** 50 per hour

Rate limit headers in response:
```
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1610705400
```

---

## Testing the API

### Using curl
```bash
# Login first to get session cookie
curl -X POST https://yourdomain.com/auth/api_login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password"}' \
  -c cookies.txt

# Create process
curl -X POST https://yourdomain.com/api/upf/process \
  -H "Content-Type: application/json" \
  -H "X-CSRFToken: <token>" \
  -b cookies.txt \
  -d '{"name": "Test Process", "class": "assembly"}'

# Get process
curl -X GET https://yourdomain.com/api/upf/process/1 \
  -b cookies.txt
```

### Using Postman
1. Import collection from `postman_collection.json`
2. Set environment variables (base_url, csrf_token)
3. Login to get session cookie
4. Test endpoints

---

## Next Steps

1. **Run Migration:** `python run_migration.py migration_add_universal_process_framework`
2. **Test Endpoints:** Use curl/Postman to verify API functionality
3. **Build Frontend:** Create UI components that call these endpoints
4. **Integration Testing:** Test complete workflows end-to-end

---

**Document Version:** 1.0
**Last Updated:** 2024-01-15
**API Base URL:** `/api/upf`
**Total Endpoints:** 47
