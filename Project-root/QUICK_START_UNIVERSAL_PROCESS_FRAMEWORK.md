# Universal Process Framework - Quick Start Guide

## 🚀 Getting Started

This guide helps you run what's been implemented and continue building the framework.

---

## Step 1: Run the Database Migration

### Prerequisites:
- PostgreSQL database running
- Database connection configured in `.env` or `config.py`
- Python virtual environment activated

### Run Migration:
```powershell
cd C:\Users\erkar\OneDrive\Desktop\MTC\Project-root
python migrations\migration_add_universal_process_framework.py
```

### Expected Output:
```
Starting Universal Process Framework migration...
Creating processes table...
Creating subprocesses table...
Creating process_subprocesses table...
...
Creating performance indexes...
Creating update timestamp triggers...
✅ Universal Process Framework migration completed successfully!
📊 Created 15 tables with comprehensive indexes and triggers
```

### Verify Tables Created:
```sql
-- Connect to your PostgreSQL database and run:
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE '%process%'
  OR tablename LIKE '%production%';

-- Should show:
-- processes
-- subprocesses
-- process_subprocesses
-- variant_usage
-- cost_items
-- additional_costs
-- process_timing
-- conditional_flags
-- profitability
-- substitute_groups
-- variant_supplier_pricing
-- process_worst_case_costing
-- production_lots
-- production_lot_selections
-- production_lot_actual_costing
```

---

## Step 2: Test the Services

### Create a Test Script:
Create `test_process_framework.py` in Project-root:

```python
"""
Test script for Universal Process Framework
Run: python test_process_framework.py
"""
import sys
import os
from datetime import datetime

# Add project to path
sys.path.insert(0, os.path.dirname(__file__))

from app import create_app
from app.services.process_service import ProcessService
from app.services.costing_service import CostingService
from app.models import generate_lot_number

def test_process_creation():
    """Test creating a process."""
    print("\n" + "="*60)
    print("TEST 1: Process Creation")
    print("="*60)

    app = create_app('development')
    with app.app_context():
        # Create a test process
        process = ProcessService.create_process(
            name="Widget Assembly Process",
            user_id=1,  # Replace with your actual user ID
            description="Test process for assembling widgets",
            process_class="assembly"
        )

        print(f"✅ Created process:")
        print(f"   ID: {process['id']}")
        print(f"   Name: {process['name']}")
        print(f"   Status: {process['status']}")
        print(f"   Class: {process['class']}")

        return process['id']

def test_process_retrieval(process_id):
    """Test retrieving a process."""
    print("\n" + "="*60)
    print("TEST 2: Process Retrieval")
    print("="*60)

    app = create_app('development')
    with app.app_context():
        process = ProcessService.get_process(process_id)

        if process:
            print(f"✅ Retrieved process:")
            print(f"   ID: {process['id']}")
            print(f"   Name: {process['name']}")
            print(f"   Subprocesses: {len(process.get('subprocesses', []))}")
        else:
            print("❌ Process not found")

def test_process_list():
    """Test listing processes."""
    print("\n" + "="*60)
    print("TEST 3: Process Listing")
    print("="*60)

    app = create_app('development')
    with app.app_context():
        result = ProcessService.list_processes(
            user_id=1,  # Replace with your actual user ID
            page=1,
            per_page=10
        )

        print(f"✅ Found {result['pagination']['total']} processes")
        print(f"   Page: {result['pagination']['page']}")
        print(f"   Per page: {result['pagination']['per_page']}")
        print(f"   Total pages: {result['pagination']['pages']}")

        for process in result['processes']:
            print(f"\n   - {process['name']} (ID: {process['id']})")
            print(f"     Status: {process['status']}")
            print(f"     Subprocesses: {process.get('subprocess_count', 0)}")

def test_lot_number_generation():
    """Test lot number generation."""
    print("\n" + "="*60)
    print("TEST 4: Lot Number Generation")
    print("="*60)

    lot_numbers = [generate_lot_number() for _ in range(3)]

    print("✅ Generated lot numbers:")
    for lot_num in lot_numbers:
        print(f"   - {lot_num}")

def test_search():
    """Test process search."""
    print("\n" + "="*60)
    print("TEST 5: Process Search")
    print("="*60)

    app = create_app('development')
    with app.app_context():
        results = ProcessService.search_processes(
            query="widget",
            user_id=1  # Replace with your actual user ID
        )

        print(f"✅ Found {len(results)} matching processes")
        for process in results:
            print(f"   - {process['name']} (ID: {process['id']})")

def main():
    """Run all tests."""
    print("\n" + "#"*60)
    print("# Universal Process Framework - Service Tests")
    print("#"*60)

    try:
        # Test 1: Create a process
        process_id = test_process_creation()

        # Test 2: Retrieve the process
        test_process_retrieval(process_id)

        # Test 3: List all processes
        test_process_list()

        # Test 4: Generate lot numbers
        test_lot_number_generation()

        # Test 5: Search processes
        test_search()

        print("\n" + "="*60)
        print("✅ ALL TESTS PASSED")
        print("="*60)

    except Exception as e:
        print("\n" + "="*60)
        print(f"❌ TEST FAILED: {e}")
        print("="*60)
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
```

### Run the Test:
```powershell
python test_process_framework.py
```

---

## Step 3: Continue Implementation

### Next Files to Create:

#### 1. Production Service
Create `app/services/production_service.py`:

```python
"""
Production Service for lot creation and execution.
"""
from app.services.costing_service import CostingService
from app.models import generate_lot_number, validate_lot_selections

class ProductionService:

    @staticmethod
    def create_production_lot(process_id, user_id, quantity=1):
        """Create a new production lot from a process."""
        # TODO: Implement
        pass

    @staticmethod
    def select_variant_for_group(lot_id, group_id, variant_id, supplier_id=None):
        """Select a variant from an OR group for a lot."""
        # TODO: Implement
        pass

    @staticmethod
    def execute_production_lot(lot_id):
        """Execute the lot and deduct inventory."""
        # TODO: Implement
        pass
```

#### 2. API Blueprint for Processes
Create `app/api/process_management.py`:

```python
"""
API endpoints for process management.
"""
from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user
from app.services.process_service import ProcessService

process_api = Blueprint('process_api', __name__)

@process_api.route('/process', methods=['POST'])
@login_required
def create_process():
    """Create a new process."""
    data = request.json

    try:
        process = ProcessService.create_process(
            name=data['name'],
            user_id=current_user.id,
            description=data.get('description'),
            process_class=data.get('class', 'assembly')
        )
        return jsonify(process), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@process_api.route('/process/<int:process_id>', methods=['GET'])
@login_required
def get_process(process_id):
    """Get process with full structure."""
    try:
        process = ProcessService.get_process_full_structure(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        return jsonify(process), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@process_api.route('/processes', methods=['GET'])
@login_required
def list_processes():
    """List processes with pagination."""
    page = int(request.args.get('page', 1))
    per_page = int(request.args.get('per_page', 25))
    status = request.args.get('status')

    try:
        result = ProcessService.list_processes(
            user_id=current_user.id,
            status=status,
            page=page,
            per_page=per_page
        )
        return jsonify(result), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400

# Add more endpoints...
```

#### 3. Register the Blueprint
In `app/__init__.py`, add:

```python
# Import the new blueprint
from .api.process_management import process_api

# Register it in create_app():
app.register_blueprint(process_api, url_prefix='/api')
```

---

## Step 4: Create Basic UI

### Process Management Page
Create `templates/process/management.html`:

```html
{% extends "base.html" %}

{% block title %}Process Management{% endblock %}

{% block content %}
<div class="container-fluid">
    <div class="row mb-4">
        <div class="col-md-6">
            <h2>Process Management</h2>
        </div>
        <div class="col-md-6 text-right">
            <button class="btn btn-primary" onclick="createProcess()">
                <i class="fas fa-plus"></i> Create New Process
            </button>
        </div>
    </div>

    <!-- Filters -->
    <div class="row mb-3">
        <div class="col-md-4">
            <input type="text"
                   id="searchInput"
                   class="form-control"
                   placeholder="Search processes...">
        </div>
        <div class="col-md-3">
            <select id="statusFilter" class="form-control">
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
            </select>
        </div>
    </div>

    <!-- Process List -->
    <div class="card">
        <div class="card-body">
            <table class="table table-hover">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Class</th>
                        <th>Status</th>
                        <th>Subprocesses</th>
                        <th>Created</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="processTableBody">
                    <!-- Populated by JavaScript -->
                </tbody>
            </table>
        </div>
    </div>
</div>

<script src="{{ url_for('static', filename='js/process_manager.js') }}"></script>
{% endblock %}
```

### JavaScript for Process Management
Create `static/js/process_manager.js`:

```javascript
/**
 * Process Manager - Handles process CRUD operations
 */

// Load processes on page load
document.addEventListener('DOMContentLoaded', function() {
    loadProcesses();

    // Set up search
    document.getElementById('searchInput').addEventListener('input', function() {
        searchProcesses(this.value);
    });

    // Set up status filter
    document.getElementById('statusFilter').addEventListener('change', function() {
        loadProcesses(this.value);
    });
});

function loadProcesses(status = '') {
    const params = new URLSearchParams();
    if (status) params.append('status', status);

    fetch(`/api/processes?${params.toString()}`)
        .then(response => response.json())
        .then(data => {
            displayProcesses(data.processes);
        })
        .catch(error => {
            console.error('Error loading processes:', error);
            showError('Failed to load processes');
        });
}

function displayProcesses(processes) {
    const tbody = document.getElementById('processTableBody');
    tbody.innerHTML = '';

    if (processes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No processes found</td></tr>';
        return;
    }

    processes.forEach(process => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${process.name}</strong></td>
            <td><span class="badge badge-info">${process.class}</span></td>
            <td><span class="badge badge-${getStatusColor(process.status)}">${process.status}</span></td>
            <td>${process.subprocess_count || 0}</td>
            <td>${new Date(process.created_at).toLocaleDateString()}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="editProcess(${process.id})">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteProcess(${process.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function getStatusColor(status) {
    const colors = {
        'draft': 'secondary',
        'active': 'success',
        'archived': 'warning',
        'inactive': 'danger'
    };
    return colors[status] || 'secondary';
}

function createProcess() {
    // TODO: Show create modal
    alert('Create process modal coming soon!');
}

function editProcess(processId) {
    window.location.href = `/process/${processId}/edit`;
}

function deleteProcess(processId) {
    if (!confirm('Are you sure you want to delete this process?')) {
        return;
    }

    fetch(`/api/process/${processId}`, {
        method: 'DELETE',
        headers: {
            'X-CSRFToken': getCSRFToken()
        }
    })
    .then(response => {
        if (response.ok) {
            showSuccess('Process deleted successfully');
            loadProcesses();
        } else {
            showError('Failed to delete process');
        }
    })
    .catch(error => {
        console.error('Error deleting process:', error);
        showError('Failed to delete process');
    });
}

function searchProcesses(query) {
    if (query.length < 2) {
        loadProcesses();
        return;
    }

    fetch(`/api/process/search?q=${encodeURIComponent(query)}`)
        .then(response => response.json())
        .then(processes => {
            displayProcesses(processes);
        })
        .catch(error => {
            console.error('Error searching processes:', error);
        });
}

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

function showSuccess(message) {
    // TODO: Implement toast notification
    alert(message);
}

function showError(message) {
    // TODO: Implement toast notification
    alert(message);
}
```

---

## Step 5: Add Navigation

In your `templates/base.html`, add a menu item:

```html
<!-- Add to navigation menu -->
<li class="nav-item">
    <a class="nav-link" href="/process-management">
        <i class="fas fa-cogs"></i> Processes
    </a>
</li>
```

In `app/main/routes.py`, add the route:

```python
@main_bp.route('/process-management')
@login_required
def process_management():
    """Process management page."""
    return render_template('process/management.html')
```

---

## 📊 Testing Checklist

Before moving to production, verify:

- [ ] Migration runs without errors
- [ ] All 15 tables created
- [ ] Indexes created successfully
- [ ] Test script passes all tests
- [ ] Process creation works
- [ ] Process retrieval works
- [ ] Process listing works
- [ ] Process search works
- [ ] Lot number generation works
- [ ] No errors in application logs

---

## 🐛 Troubleshooting

### Migration Fails:
```powershell
# Check database connection
python -c "from database import get_conn; get_conn()"

# Check if tables already exist
# If so, either drop them or use the downgrade() function
python migrations\migration_add_universal_process_framework.py downgrade
```

### Import Errors:
```powershell
# Make sure you're in the Project-root directory
cd C:\Users\erkar\OneDrive\Desktop\MTC\Project-root

# Activate virtual environment if needed
.\venv2\Scripts\Activate.ps1
```

### Service Errors:
- Check that user_id exists in users table
- Verify database connection is working
- Check application logs in `logs/app.log`

---

## 📚 Next Reading

1. `UNIVERSAL_PROCESS_FRAMEWORK_PROGRESS.md` - Full progress report
2. `app/services/process_service.py` - Service implementation examples
3. `app/models/process.py` - Model structure
4. Original specification (your prompt) - Complete requirements

---

## ✨ You're Ready!

The foundation is complete. You can now:
1. ✅ Create processes via services
2. ✅ Calculate worst-case costs
3. ✅ Track profitability
4. 🚧 Continue building API endpoints
5. 🚧 Continue building UI components

**Happy coding!** 🚀
