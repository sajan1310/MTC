# MTC UPF – Implementation Fix Guide
## Code Snippets & Exact Repairs

---

## Section A: Backend Flask Repairs (Python)

### A.1 Fix #1: Standardized Response Handler Utility

**File: `app/utils/response.py` (CREATE NEW)**

```python
from flask import jsonify

class APIResponse:
    """Standardized API response wrapper"""
    
    @staticmethod
    def success(data=None, message='Success', status_code=200):
        return jsonify({
            'data': data,
            'error': None,
            'message': message
        }), status_code
    
    @staticmethod
    def error(error_code, message, status_code=400, data=None):
        return jsonify({
            'data': data,
            'error': error_code,
            'message': message
        }), status_code
    
    @staticmethod
    def created(data, message='Resource created'):
        return APIResponse.success(data, message, 201)
    
    @staticmethod
    def not_found(resource_type, resource_id):
        return APIResponse.error(
            'not_found',
            f'{resource_type} with ID {resource_id} not found',
            404
        )

# Import in blueprints:
# from app.utils.response import APIResponse
```

---

### A.2 Fix #2: Correct Process Routes

**File: `app/api/process_management.py` (CORRECTIONS)**

```python
from flask import Blueprint, request, jsonify
from app.utils.response import APIResponse
from app.models import Process, Subprocess
from app import db

bp = Blueprint('process', __name__, url_prefix='/api/upf')

# ✓ CORRECTED: All routes now use /api/upf/ prefix consistently

@bp.route('/processes', methods=['GET'])
def list_processes():
    """List all processes with pagination"""
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 10, type=int)
        
        query = Process.query.filter_by(is_deleted=False)
        paginated = query.paginate(page=page, per_page=per_page)
        
        data = {
            'processes': [p.to_dict() for p in paginated.items],
            'total': paginated.total,
            'pages': paginated.pages,
            'current_page': page
        }
        return APIResponse.success(data)
    except Exception as e:
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes', methods=['POST'])
def create_process():
    """Create new process"""
    try:
        data = request.get_json() or {}
        name = data.get('name', '').strip()
        description = data.get('description', '').strip()
        
        # Validation
        if not name:
            return APIResponse.error('validation_error', 'Process name required', 400)
        
        # Check duplicate
        if Process.query.filter_by(name=name, is_deleted=False).first():
            return APIResponse.error(
                'duplicate_name',
                f'Process "{name}" already exists',
                409
            )
        
        # Create
        process = Process(name=name, description=description)
        db.session.add(process)
        db.session.commit()
        
        return APIResponse.created(process.to_dict(), 'Process created successfully')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>', methods=['GET'])
def get_process(process_id):
    """Get single process details"""
    try:
        process = Process.query.get(process_id)
        if not process or process.is_deleted:
            return APIResponse.not_found('Process', process_id)
        
        return APIResponse.success(process.to_dict())
    except Exception as e:
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>/structure', methods=['GET'])
def get_process_structure(process_id):
    """
    Get complete process structure:
    - All subprocesses
    - All variants for each subprocess
    - All OR groups
    - Cost information
    """
    try:
        process = Process.query.get(process_id)
        if not process or process.is_deleted:
            return APIResponse.not_found('Process', process_id)
        
        data = {
            'process': process.to_dict(),
            'subprocesses': [
                {
                    'id': sp.id,
                    'name': sp.name,
                    'description': sp.description,
                    'order': sp.order,
                    'variants': [v.to_dict() for v in sp.variants if not v.is_deleted],
                    'or_groups': [
                        {
                            'id': og.id,
                            'name': og.name,
                            'variant_ids': [v.id for v in og.variants]
                        }
                        for og in sp.or_groups if not og.is_deleted
                    ]
                }
                for sp in process.subprocesses if not sp.is_deleted
            ]
        }
        return APIResponse.success(data)
    except Exception as e:
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>', methods=['PUT'])
def update_process(process_id):
    """Update process"""
    try:
        process = Process.query.get(process_id)
        if not process or process.is_deleted:
            return APIResponse.not_found('Process', process_id)
        
        data = request.get_json() or {}
        
        if 'name' in data:
            new_name = data['name'].strip()
            if not new_name:
                return APIResponse.error('validation_error', 'Name cannot be empty', 400)
            
            # Check for duplicate (excluding self)
            duplicate = Process.query.filter(
                Process.name == new_name,
                Process.id != process_id,
                Process.is_deleted == False
            ).first()
            if duplicate:
                return APIResponse.error('duplicate_name', f'Name "{new_name}" already exists', 409)
            
            process.name = new_name
        
        if 'description' in data:
            process.description = data['description'].strip()
        
        db.session.commit()
        return APIResponse.success(process.to_dict(), 'Process updated')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>', methods=['DELETE'])
def delete_process(process_id):
    """Soft delete process"""
    try:
        process = Process.query.get(process_id)
        if not process:
            return APIResponse.not_found('Process', process_id)
        
        process.is_deleted = True
        db.session.commit()
        return APIResponse.success(None, 'Process deleted successfully')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>/restore', methods=['POST'])
def restore_process(process_id):
    """Restore soft-deleted process"""
    try:
        process = Process.query.get(process_id)
        if not process:
            return APIResponse.not_found('Process', process_id)
        
        if not process.is_deleted:
            return APIResponse.error('invalid_state', 'Process is not deleted', 400)
        
        process.is_deleted = False
        db.session.commit()
        return APIResponse.success(process.to_dict(), 'Process restored')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)
```

---

### A.3 Fix #3: Correct Subprocess Routes

**File: `app/api/subprocess_management.py` (CORRECTIONS)**

```python
from flask import Blueprint, request, jsonify
from app.utils.response import APIResponse
from app.models import Process, Subprocess
from app import db

bp = Blueprint('subprocess', __name__, url_prefix='/api/upf')

@bp.route('/processes/<int:process_id>/subprocesses', methods=['POST'])
def add_subprocess(process_id):
    """Add subprocess to process"""
    try:
        process = Process.query.get(process_id)
        if not process or process.is_deleted:
            return APIResponse.not_found('Process', process_id)
        
        data = request.get_json() or {}
        name = data.get('name', '').strip()
        description = data.get('description', '').strip()
        order = data.get('order', 0)
        
        if not name:
            return APIResponse.error('validation_error', 'Subprocess name required', 400)
        
        # Create subprocess
        subprocess = Subprocess(
            process_id=process_id,
            name=name,
            description=description,
            order=order
        )
        db.session.add(subprocess)
        db.session.commit()
        
        return APIResponse.created(subprocess.to_dict(), 'Subprocess added')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>/subprocesses/<int:subprocess_id>', methods=['PUT'])
def update_subprocess(process_id, subprocess_id):
    """Update subprocess"""
    try:
        process = Process.query.get(process_id)
        if not process:
            return APIResponse.not_found('Process', process_id)
        
        subprocess = Subprocess.query.filter_by(
            id=subprocess_id,
            process_id=process_id,
            is_deleted=False
        ).first()
        if not subprocess:
            return APIResponse.not_found('Subprocess', subprocess_id)
        
        data = request.get_json() or {}
        
        if 'name' in data:
            subprocess.name = data['name'].strip()
        if 'description' in data:
            subprocess.description = data['description'].strip()
        if 'order' in data:
            subprocess.order = data['order']
        
        db.session.commit()
        return APIResponse.success(subprocess.to_dict(), 'Subprocess updated')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>/subprocesses/<int:subprocess_id>', methods=['DELETE'])
def delete_subprocess(process_id, subprocess_id):
    """Soft delete subprocess"""
    try:
        subprocess = Subprocess.query.filter_by(
            id=subprocess_id,
            process_id=process_id
        ).first()
        if not subprocess:
            return APIResponse.not_found('Subprocess', subprocess_id)
        
        subprocess.is_deleted = True
        db.session.commit()
        return APIResponse.success(None, 'Subprocess deleted')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/processes/<int:process_id>/reorder_subprocesses', methods=['POST'])
def reorder_subprocesses(process_id):
    """Reorder subprocesses (for drag-and-drop)"""
    try:
        process = Process.query.get(process_id)
        if not process or process.is_deleted:
            return APIResponse.not_found('Process', process_id)
        
        data = request.get_json() or {}
        new_order = data.get('order', [])  # List of subprocess IDs in new order
        
        if not new_order:
            return APIResponse.error('validation_error', 'Order list required', 400)
        
        # Update all subprocesses with new order
        for idx, subprocess_id in enumerate(new_order):
            subprocess = Subprocess.query.filter_by(
                id=subprocess_id,
                process_id=process_id
            ).first()
            if subprocess:
                subprocess.order = idx + 1
        
        db.session.commit()
        return APIResponse.success(None, 'Subprocesses reordered')
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)
```

---

### A.4 Fix #4: Correct Cost Item Routes (rate vs amount)

**File: `app/api/cost_item.py` (CORRECTIONS or CREATE NEW)**

```python
from flask import Blueprint, request, jsonify
from app.utils.response import APIResponse
from app.models import CostItem, Subprocess
from app import db

bp = Blueprint('cost', __name__, url_prefix='/api/upf')

@bp.route('/cost_item', methods=['POST'])
def add_cost_item():
    """Add cost item to subprocess"""
    try:
        data = request.get_json() or {}
        subprocess_id = data.get('subprocess_id')
        rate = data.get('rate')  # ✓ Use "rate" not "amount"
        quantity = data.get('quantity', 1)
        
        if not subprocess_id or rate is None:
            return APIResponse.error(
                'validation_error',
                'subprocess_id and rate required',
                400
            )
        
        subprocess = Subprocess.query.get(subprocess_id)
        if not subprocess:
            return APIResponse.not_found('Subprocess', subprocess_id)
        
        cost_item = CostItem(
            subprocess_id=subprocess_id,
            rate=float(rate),
            quantity=float(quantity),
            total_cost=float(rate) * float(quantity)
        )
        db.session.add(cost_item)
        db.session.commit()
        
        return APIResponse.created(cost_item.to_dict(), 'Cost item added')
    except ValueError as e:
        return APIResponse.error('validation_error', f'Invalid number: {str(e)}', 400)
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)

@bp.route('/cost_item/<int:cost_item_id>', methods=['PUT'])
def update_cost_item(cost_item_id):
    """Update cost item"""
    try:
        cost_item = CostItem.query.get(cost_item_id)
        if not cost_item or cost_item.is_deleted:
            return APIResponse.not_found('CostItem', cost_item_id)
        
        data = request.get_json() or {}
        
        if 'rate' in data:
            cost_item.rate = float(data['rate'])
        if 'quantity' in data:
            cost_item.quantity = float(data['quantity'])
        
        # Recalculate total
        cost_item.total_cost = cost_item.rate * cost_item.quantity
        
        db.session.commit()
        return APIResponse.success(cost_item.to_dict(), 'Cost item updated')
    except ValueError as e:
        return APIResponse.error('validation_error', f'Invalid number: {str(e)}', 400)
    except Exception as e:
        db.session.rollback()
        return APIResponse.error('internal_error', str(e), 500)
```

---

## Section B: Frontend JavaScript Repairs

### B.1 Fix #1: Unified Error Handler Utility

**File: `static/js/api_client.js` (CREATE NEW)**

```javascript
/**
 * Unified API client with error handling
 */
class APIClient {
  static BASE_URL = '/api/upf';

  /**
   * Make API call with standardized error handling
   */
  static async request(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      headers = {},
      onError = null,
      onLoading = null
    } = options;

    // Show loading indicator
    if (onLoading) onLoading(true);

    try {
      const url = path.startsWith('http') ? path : `${this.BASE_URL}${path}`;
      
      const fetchOptions = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      };

      if (body) {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      const data = await response.json();

      // Check for API-level error
      if (data.error) {
        const errorMsg = data.message || data.error || 'Unknown error';
        console.error(`API Error (${data.error}):`, errorMsg);
        
        if (onError) {
          onError(errorMsg, data.error, response.status);
        } else {
          this.showErrorModal(errorMsg);
        }
        return null;
      }

      return data.data; // Return actual data
    } catch (err) {
      const errorMsg = `Network error: ${err.message}`;
      console.error(errorMsg, err);
      
      if (onError) {
        onError(errorMsg, 'network_error', 0);
      } else {
        this.showErrorModal(errorMsg, { retry: () => this.request(path, options) });
      }
      return null;
    } finally {
      if (onLoading) onLoading(false);
    }
  }

  // Convenience methods
  static get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }

  static post(path, body, options) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  static put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  static delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }

  // UI Error display
  static showErrorModal(message, actions = {}) {
    const modal = document.createElement('div');
    modal.className = 'error-modal';
    modal.innerHTML = `
      <div class="error-modal-content">
        <h3>Error</h3>
        <p>${message}</p>
        <div class="error-modal-actions">
          ${actions.retry ? '<button id="retryBtn" class="btn btn-primary">Retry</button>' : ''}
          <button id="closeBtn" class="btn btn-secondary">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    if (actions.retry) {
      document.getElementById('retryBtn').addEventListener('click', () => {
        modal.remove();
        actions.retry();
      });
    }

    document.getElementById('closeBtn').addEventListener('click', () => {
      modal.remove();
    });
  }
}

// Export for use in other files
// import { APIClient } from './api_client.js';
```

---

### B.2 Fix #2: Corrected Process Editor Form Validation

**File: `static/js/process_editor.js` (PARTIAL REWRITE)**

```javascript
/**
 * Process Editor - Corrected version with proper validation and error handling
 */

class ProcessEditor {
  constructor() {
    this.processId = null;
    this.currentData = null;
    this.isLoading = false;
  }

  /**
   * Load process structure with error handling
   */
  async loadProcess(processId) {
    this.processId = processId;
    this.setLoading(true);

    // Show loading indicator
    this.showLoadingSpinner('Loading process...');

    try {
      // ✓ Correct: Use template literal with proper interpolation
      const data = await APIClient.get(
        `/processes/${processId}/structure`,
        {
          onError: (msg, code, status) => {
            this.handleLoadError(msg, code);
          }
        }
      );

      if (!data) {
        throw new Error('Failed to load process');
      }

      this.currentData = data;
      this.renderProcess(data);
      this.hideErrorMessage();
    } catch (err) {
      this.handleLoadError(err.message, 'load_error');
    } finally {
      this.setLoading(false);
      this.hideLoadingSpinner();
    }
  }

  /**
   * Handle load errors with retry option
   */
  handleLoadError(message, errorCode) {
    this.showErrorMessage(message, {
      retry: () => this.loadProcess(this.processId)
    });
  }

  /**
   * Save process with full validation
   */
  async saveProcess(formData) {
    // ✓ Step 1: Client-side validation
    const validationError = this.validateProcessForm(formData);
    if (validationError) {
      this.showErrorMessage(validationError);
      return false;
    }

    // ✓ Step 2: Check for duplicate name (if updating)
    if (this.currentData && formData.name !== this.currentData.name) {
      if (await this.checkDuplicateName(formData.name)) {
        this.showErrorMessage('Process name already exists');
        return false;
      }
    }

    // ✓ Step 3: Show saving indicator
    this.showLoadingSpinner('Saving process...');
    this.disableAllButtons();

    try {
      // ✓ POST/PUT to correct endpoint
      const method = this.currentData ? 'PUT' : 'POST';
      const endpoint = this.currentData ? `/processes/${this.processId}` : '/processes';

      const data = await APIClient.request(
        endpoint,
        {
          method,
          body: formData,
          onError: (msg) => {
            this.showErrorMessage(msg);
          }
        }
      );

      if (!data) {
        throw new Error('Save failed');
      }

      // ✓ Only close modal on success
      this.showSuccessMessage('Process saved successfully');
      this.currentData = data;
      setTimeout(() => this.closeModal(), 1500);
      return true;
    } catch (err) {
      this.showErrorMessage(`Save failed: ${err.message}`);
      return false;
    } finally {
      this.hideLoadingSpinner();
      this.enableAllButtons();
    }
  }

  /**
   * Validate process form
   */
  validateProcessForm(formData) {
    if (!formData.name || !formData.name.trim()) {
      return 'Process name is required';
    }
    if (formData.name.length < 3) {
      return 'Process name must be at least 3 characters';
    }
    return null;
  }

  /**
   * Check if process name already exists
   */
  async checkDuplicateName(name) {
    // Query backend for processes with same name
    const processes = await APIClient.get('/processes?name=' + encodeURIComponent(name));
    return processes && processes.length > 0;
  }

  /**
   * Add subprocess with validation
   */
  async addSubprocess(formData) {
    // Validate
    if (!formData.name || !formData.name.trim()) {
      this.showErrorMessage('Subprocess name required');
      return false;
    }

    this.showLoadingSpinner('Adding subprocess...');

    try {
      // ✓ Correct endpoint with process ID
      const data = await APIClient.post(
        `/processes/${this.processId}/subprocesses`,
        formData
      );

      if (!data) {
        throw new Error('Failed to add subprocess');
      }

      // Refresh process structure
      await this.loadProcess(this.processId);
      this.closeSubprocessModal();
      this.showSuccessMessage('Subprocess added');
      return true;
    } catch (err) {
      this.showErrorMessage(`Failed to add subprocess: ${err.message}`);
      return false;
    } finally {
      this.hideLoadingSpinner();
    }
  }

  /**
   * Add variant with validation
   */
  async addVariant(formData) {
    // Validate
    if (!formData.name || formData.rate === undefined) {
      this.showErrorMessage('Variant name and rate required');
      return false;
    }

    this.showLoadingSpinner('Adding variant...');

    try {
      // ✓ Use "rate" not "amount"
      const data = await APIClient.post('/variant_usage', {
        subprocess_id: formData.subprocess_id,
        name: formData.name,
        rate: parseFloat(formData.rate),  // ✓ Correct field name
        supplier_id: formData.supplier_id
      });

      if (!data) {
        throw new Error('Failed to add variant');
      }

      await this.loadProcess(this.processId);
      this.closeVariantModal();
      this.showSuccessMessage('Variant added');
      return true;
    } catch (err) {
      this.showErrorMessage(`Failed to add variant: ${err.message}`);
      return false;
    } finally {
      this.hideLoadingSpinner();
    }
  }

  /**
   * Create OR group with validation
   */
  async createORGroup(subprocess_id, variant_ids) {
    // Validate: Must have >= 2 variants
    if (!variant_ids || variant_ids.length < 2) {
      this.showErrorMessage('OR group requires at least 2 variants');
      return false;
    }

    this.showLoadingSpinner('Creating OR group...');

    try {
      const data = await APIClient.post('/substitute_group', {
        subprocess_id,
        variant_usage_ids: variant_ids
      });

      if (!data) {
        throw new Error('Failed to create OR group');
      }

      await this.loadProcess(this.processId);
      this.showSuccessMessage('OR group created');
      return true;
    } catch (err) {
      this.showErrorMessage(`Failed to create OR group: ${err.message}`);
      return false;
    } finally {
      this.hideLoadingSpinner();
    }
  }

  // ========== UI Helpers ==========

  setLoading(isLoading) {
    this.isLoading = isLoading;
  }

  showLoadingSpinner(message = 'Loading...') {
    const spinner = document.getElementById('loadingSpinner');
    if (spinner) {
      spinner.textContent = message;
      spinner.style.display = 'block';
    }
  }

  hideLoadingSpinner() {
    const spinner = document.getElementById('loadingSpinner');
    if (spinner) spinner.style.display = 'none';
  }

  showErrorMessage(message, actions = {}) {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = 'block';

      if (actions.retry) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.onclick = actions.retry;
        errorDiv.appendChild(retryBtn);
      }
    } else {
      console.error(message);
      alert(message); // Fallback
    }
  }

  hideErrorMessage() {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) errorDiv.style.display = 'none';
  }

  showSuccessMessage(message) {
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    setTimeout(() => successDiv.remove(), 3000);
  }

  disableAllButtons() {
    document.querySelectorAll('button:not([disabled])').forEach(btn => {
      btn.disabled = true;
      btn.dataset.wasEnabled = 'true';
    });
  }

  enableAllButtons() {
    document.querySelectorAll('button[data-was-enabled="true"]').forEach(btn => {
      btn.disabled = false;
      delete btn.dataset.wasEnabled;
    });
  }

  closeModal() {
    const modal = document.getElementById('processModal');
    if (modal) modal.close();
  }

  closeSubprocessModal() {
    const modal = document.getElementById('addSubprocessModal');
    if (modal) modal.close();
  }

  closeVariantModal() {
    const modal = document.getElementById('addVariantModal');
    if (modal) modal.close();
  }

  renderProcess(data) {
    // Update UI with loaded process data
    // Implementation depends on your template structure
    console.log('Rendering process:', data);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  window.processEditor = new ProcessEditor();
});
```

---

### B.3 Fix #3: Production Lots with Error Recovery

**File: `static/js/production_lots.js` (CORRECTED VERSION)**

```javascript
/**
 * Production Lots Page - With proper error handling for variant selection
 */

class ProductionLots {
  constructor() {
    this.currentLot = null;
    this.orGroups = [];
  }

  /**
   * Load variant options with error handling
   */
  async loadVariantOptions(lotId) {
    const loadingDiv = document.getElementById('variantLoadingIndicator');
    const errorDiv = document.getElementById('variantErrorMessage');

    if (loadingDiv) loadingDiv.style.display = 'block';
    if (errorDiv) errorDiv.style.display = 'none';

    try {
      // ✓ Correct endpoint with proper error handling
      const data = await APIClient.get(
        `/production-lot/${lotId}/variant_options`,
        {
          onError: (msg, code, status) => {
            // Show error with retry
            if (errorDiv) {
              errorDiv.innerHTML = `
                <div class="error-box">
                  <p>${msg}</p>
                  <button onclick="productionLots.loadVariantOptions(${lotId})">Retry</button>
                </div>
              `;
              errorDiv.style.display = 'block';
            }
          }
        }
      );

      if (!data) {
        throw new Error('No variant data received');
      }

      this.orGroups = data;
      this.populateVariantDropdowns(data);
    } catch (err) {
      console.error('Failed to load variant options:', err);
    } finally {
      if (loadingDiv) loadingDiv.style.display = 'none';
    }
  }

  /**
   * Populate variant dropdowns for each OR group
   */
  populateVariantDropdowns(orGroups) {
    const container = document.getElementById('variantSelectionsContainer');
    if (!container) return;

    container.innerHTML = ''; // Clear

    orGroups.forEach(orGroup => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'or-group-selection';
      groupDiv.innerHTML = `
        <label>${orGroup.name}:</label>
        <select class="variant-select" data-or-group-id="${orGroup.id}">
          <option value="">-- Select variant --</option>
          ${orGroup.variants
            .map(v => `<option value="${v.id}">${v.name} ($${v.cost})</option>`)
            .join('')}
        </select>
      `;

      // Listen for selection changes to update cost
      const select = groupDiv.querySelector('.variant-select');
      select.addEventListener('change', () => this.updateCostCalculation());

      container.appendChild(groupDiv);
    });
  }

  /**
   * Update total cost based on variant selections
   */
  updateCostCalculation() {
    const selections = this.getVariantSelections();
    let totalCost = 0;

    selections.forEach(sel => {
      const orGroup = this.orGroups.find(og => og.id === sel.orGroupId);
      if (orGroup) {
        const variant = orGroup.variants.find(v => v.id === sel.variantId);
        if (variant) {
          totalCost += variant.cost;
        }
      }
    });

    const costDiv = document.getElementById('totalCostDisplay');
    if (costDiv) {
      costDiv.textContent = `Total Cost: $${totalCost.toFixed(2)}`;
    }
  }

  /**
   * Get current variant selections
   */
  getVariantSelections() {
    const selections = [];
    document.querySelectorAll('.variant-select').forEach(select => {
      if (select.value) {
        selections.push({
          orGroupId: parseInt(select.dataset.orGroupId),
          variantId: parseInt(select.value)
        });
      }
    });
    return selections;
  }

  /**
   * Execute production lot
   */
  async executeLot(lotId) {
    // Validate all OR groups have selection
    const selections = this.getVariantSelections();
    if (selections.length !== this.orGroups.length) {
      alert('Please select a variant for all options');
      return;
    }

    const executeBtn = document.getElementById('executeBtn');
    executeBtn.disabled = true;

    const progressDiv = document.createElement('div');
    progressDiv.id = 'executionProgress';
    progressDiv.innerHTML = '<p>Executing production lot...</p><progress></progress>';
    document.getElementById('lotActionsContainer').appendChild(progressDiv);

    try {
      // ✓ Post with variant selections
      const data = await APIClient.post(
        `/production-lot/${lotId}/execute`,
        { variant_selections: selections },
        {
          onError: (msg) => {
            alert(`Execution failed: ${msg}`);
          }
        }
      );

      if (!data) {
        throw new Error('Execution failed');
      }

      alert('Production lot executed successfully!');
      this.currentLot = data;
      // Refresh UI
      location.reload();
    } catch (err) {
      console.error('Execution error:', err);
      alert(`Error: ${err.message}`);
    } finally {
      executeBtn.disabled = false;
      progressDiv.remove();
    }
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.productionLots = new ProductionLots();
});
```

---

## Section C: HTML Template Fixes

### C.1 Fix: Add Error Message Divs to Templates

**File: `templates/upf_process_editor.html` (ADDITIONS)**

```html
<!-- ADD THESE ELEMENTS TO YOUR MODAL -->

<!-- Error Message Container (add to top of modal) -->
<div id="errorMessage" class="alert alert-danger" style="display:none; margin-bottom:15px;">
  <!-- Error text will be populated by JS -->
</div>

<!-- Loading Spinner (add to modal) -->
<div id="loadingSpinner" class="spinner-container" style="display:none;">
  <div class="spinner"></div>
  <p id="loadingText">Loading...</p>
</div>

<!-- Success Message (add to modal) -->
<div id="successMessage" class="alert alert-success" style="display:none;">
  <!-- Success text will be populated by JS -->
</div>

<!-- Process Name Input (corrected with validation) -->
<div class="form-group">
  <label for="processName">Process Name *</label>
  <input
    type="text"
    id="processName"
    class="form-control"
    placeholder="Enter process name (min 3 chars)"
    required
  />
  <small id="processNameError" class="text-danger" style="display:none;">
    <!-- Validation error text -->
  </small>
</div>

<!-- Add Subprocess Modal (with error handling) -->
<div id="addSubprocessModal" class="modal">
  <div id="subprocessErrorMessage" class="alert alert-danger" style="display:none;"></div>
  <div id="subprocessLoadingSpinner" class="spinner-container" style="display:none;">
    <div class="spinner"></div>
  </div>
  <form onsubmit="return processEditor.addSubprocess(getFormData(this))">
    <input type="text" id="subprocessName" placeholder="Subprocess name" required />
    <textarea id="subprocessDesc" placeholder="Description"></textarea>
    <button type="submit" id="addSubprocessBtn">Add Subprocess</button>
    <button type="button" onclick="this.closest('.modal').close()">Cancel</button>
  </form>
</div>

<!-- Variant Selection (with loading indicator) -->
<div id="variantLoadingIndicator" class="spinner-container" style="display:none;">
  <p>Loading variants...</p>
</div>
<div id="variantErrorMessage" class="alert alert-danger" style="display:none;"></div>
<div id="variantSelectionContainer"></div>

<!-- CSS for spinner (add to <style>) -->
<style>
  .spinner-container {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 15px;
  }

  .spinner {
    border: 3px solid #f3f3f3;
    border-top: 3px solid #3498db;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .alert {
    padding: 12px;
    border-radius: 4px;
    margin-bottom: 15px;
  }

  .alert-danger {
    background-color: #f8d7da;
    border: 1px solid #f5c6cb;
    color: #721c24;
  }

  .alert-success {
    background-color: #d4edda;
    border: 1px solid #c3e6cb;
    color: #155724;
  }

  .error-message {
    color: #d32f2f;
    font-size: 14px;
    margin-top: 5px;
  }
</style>
```

---

## Quick Reference: Where to Add JavaScript

Add these imports to your HTML `<head>` or before closing `</body>`:

```html
<!-- Add these in order -->
<script src="/static/js/api_client.js"></script>
<script src="/static/js/process_editor.js"></script>
<script src="/static/js/production_lots.js"></script>
</body>
```

---

## Testing Checklist for Each Fix

- [ ] **API Response Format:** POST to `/api/upf/processes` → returns `{ data, error, message }`
- [ ] **Path Params:** GET `/api/upf/processes/1/structure` → uses `<int:process_id>` in Flask
- [ ] **Cost Field:** POST cost with `rate` field → backend accepts it (not `amount`)
- [ ] **Error Callbacks:** Variant load fails → shows "Loading variants... [Retry]"
- [ ] **Modal Close:** Save successful → modal closes ONLY after API success
- [ ] **Duplicate Check:** Create process with duplicate name → blocked before POST
- [ ] **Subprocess Add:** POST `/api/upf/processes/1/subprocesses` → works end-to-end

