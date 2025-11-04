# Frontend Developer Quick Start - Universal Process Framework

**Target Audience:** Frontend developers building the UI for the Universal Process Framework  
**Prerequisites:** Backend API complete, database migration run  
**Estimated Development Time:** 2 weeks

---

## What You're Building

A comprehensive process management interface for manufacturing/assembly workflows with these key features:

1. **Process Editor** - Visual builder for multi-step processes
2. **Drag-and-Drop Variant Search** - Intuitive material selection
3. **OR Group Selection** - Production-time flexibility for alternative components
4. **Cost Calculator** - Real-time worst-case cost estimation
5. **Production Execution** - Lot creation, validation, and execution

---

## Architecture Overview

```
Frontend (You Build)          Backend (Already Built)
├── HTML Templates            ├── 47 REST API Endpoints
├── JavaScript Components     ├── Authentication (Flask-Login)
├── CSS Styling               ├── Database (PostgreSQL)
└── AJAX Requests             └── Business Logic Services
```

**Your Job:** Build the UI that calls the existing API endpoints.

---

## 5 Pages to Build

### 1. Process Management Page
**Route:** `/upf/processes`  
**Template:** `templates/upf_process_management.html`  
**JavaScript:** `static/js/process_manager.js`

**Features:**
- Table view of all processes
- Search bar (calls `/api/upf/process/search`)
- Filter dropdowns (status: active/archived)
- Pagination controls
- "New Process" button → Modal or redirect
- Edit/Delete actions per row
- Cost and profitability columns

**Key API Endpoints:**
- `GET /api/upf/processes?page=1&per_page=25`
- `GET /api/upf/process/search?q=assembly`
- `POST /api/upf/process` (create new)
- `DELETE /api/upf/process/<id>` (soft delete)

---

### 2. Process Editor Page
**Route:** `/upf/process/<id>/edit`  
**Template:** `templates/upf_process_editor.html`  
**JavaScript:** `static/js/process_editor.js`, `static/js/drag_drop_handler.js`

**Layout (3-panel):**

```
┌─────────────────────────────────────────────────────────┐
│ Process Name: [Input Field]           [Save] [Cancel]  │
├─────────────────────────┬───────────────────────────────┤
│                         │                               │
│  VARIANT SEARCH PANEL   │   PROCESS BUILDER PANEL       │
│  (40% width)            │   (60% width)                 │
│                         │                               │
│  [Search: ______]       │   Subprocess 1: Component...  │
│  📁 Category: [All]     │   ├── Variant: M4 Screw (2x) │
│  📦 In Stock Only: ☑    │   ├── Cost: Labor ($50)      │
│  💰 Max Cost: [___]     │   └── OR Group: Screw Options│
│                         │                               │
│  Drag Items:            │   Subprocess 2: Testing...    │
│  🔩 M4 Screw - Steel    │   ├── Variant: Test Jig (1x) │
│  🔩 M4 Screw - SS       │   └── Cost: Labor ($25)      │
│  🔧 Wrench Set          │                               │
│  ⚙️ Bearing A           │   [+ Add Subprocess]          │
│                         │                               │
└─────────────────────────┴───────────────────────────────┘
```

**Key Features:**
- **Left Panel:** Autocomplete search with drag-enabled variant cards
- **Center Panel:** Subprocess list with nested variants/costs
- **Drag-and-Drop:** Drag variants from left to center to add them
- **OR Groups:** Visual indicator for substitute groups
- **Real-Time Cost:** Update total cost as variants are added/removed

**Key API Endpoints:**
- `GET /api/upf/process/<id>` (load process structure)
- `GET /api/upf/variants/search?q=screw&limit=50` (autocomplete)
- `POST /api/upf/process/<id>/add_subprocess` (add subprocess)
- `POST /api/upf/variant_usage` (add variant to subprocess)
- `POST /api/upf/substitute_group` (create OR group)
- `POST /api/upf/process/<id>/reorder_subprocesses` (reorder)
- `GET /api/upf/process/<id>/worst_case_costing` (cost breakdown)

**Drag-and-Drop Libraries (Recommended):**
- **SortableJS** - Simple, lightweight (https://github.com/SortableJS/Sortable)
- **Dragula** - Drag-and-drop so simple it hurts (https://bevacqua.github.io/dragula/)

---

### 3. Subprocess Library Page
**Route:** `/upf/subprocesses`  
**Template:** `templates/upf_subprocess_library.html`  
**JavaScript:** `static/js/subprocess_manager.js`

**Features:**
- Grid or table view of subprocess templates
- Search/filter by type (assembly|testing|packaging)
- Preview variants and costs
- Create new template
- Duplicate existing template
- Edit/Delete actions

**Key API Endpoints:**
- `GET /api/upf/subprocesses?page=1&per_page=25`
- `GET /api/upf/subprocess/search?q=install&type=assembly`
- `POST /api/upf/subprocess` (create template)
- `POST /api/upf/subprocess/<id>/duplicate` (duplicate)
- `PUT /api/upf/subprocess/<id>` (update)
- `DELETE /api/upf/subprocess/<id>` (delete)

---

### 4. Production Lot Interface
**Route:** `/upf/production_lots` (list), `/upf/production_lot/<id>` (detail)  
**Templates:** `templates/upf_production_lot_list.html`, `templates/upf_production_lot_detail.html`  
**JavaScript:** `static/js/production_lot.js`, `static/js/or_group_selector.js`

**Production Lot Creation Wizard:**

```
Step 1: Select Process
┌──────────────────────────────────────┐
│ Process: [Dropdown: Product Assembly]│
│ Quantity: [100]                      │
│ Notes: [Optional notes]              │
│                     [Next →]         │
└──────────────────────────────────────┘

Step 2: Select Variants from OR Groups
┌──────────────────────────────────────┐
│ OR Group: Screw Options              │
│ ○ M4 Screw - Steel ($0.50)           │
│ ● M4 Screw - Stainless ($0.75) ✓     │
│ ○ M4 Screw - Brass ($0.90)           │
│                                      │
│ Reason: [Better corrosion resistance]│
│                                      │
│ OR Group: Paint Options              │
│ ● Red Paint ($5.00) ✓                │
│ ○ Blue Paint ($5.50)                 │
│                                      │
│           [← Back] [Validate →]      │
└──────────────────────────────────────┘

Step 3: Validation & Execution
┌──────────────────────────────────────┐
│ ✅ All OR groups selected             │
│ ✅ Sufficient stock available         │
│                                      │
│ Estimated Cost: $1,234.56            │
│ Total Quantity: 100 units            │
│                                      │
│       [← Back] [Execute Production]  │
└──────────────────────────────────────┘
```

**Key API Endpoints:**
- `POST /api/upf/production_lot` (create lot)
- `GET /api/upf/production_lot/<id>` (get lot details)
- `POST /api/upf/production_lot/<id>/select_variant` (select from OR group)
- `POST /api/upf/production_lot/<id>/validate` (validate readiness)
- `POST /api/upf/production_lot/<id>/execute` (execute production)
- `GET /api/upf/production_lot/<id>/variance_analysis` (after completion)

---

### 5. Reports Dashboard
**Route:** `/upf/reports`  
**Template:** `templates/upf_reports.html`  
**JavaScript:** `static/js/upf_reports.js`

**Features:**
- Production statistics cards
- Variance analysis charts
- Cost trends over time
- Profitability reports
- Export to CSV/PDF

**Key API Endpoints:**
- `GET /api/upf/production_lots/summary` (statistics)
- `GET /api/upf/production_lots/recent?limit=10` (recent lots)
- `GET /api/upf/production_lot/<id>/variance_analysis` (variance report)

**Chart Libraries (Recommended):**
- **Chart.js** - Simple, flexible (https://www.chartjs.org/)
- **ApexCharts** - Modern, feature-rich (https://apexcharts.com/)

---

## JavaScript Components to Build

### 1. `process_manager.js`
**Responsibility:** Process list CRUD operations

```javascript
class ProcessManager {
  constructor() {
    this.processes = [];
    this.currentPage = 1;
    this.perPage = 25;
  }

  async loadProcesses(page = 1, filters = {}) {
    const response = await fetch(`/api/upf/processes?page=${page}&per_page=${this.perPage}`, {
      method: 'GET',
      credentials: 'include'
    });
    const data = await response.json();
    this.processes = data.processes;
    this.renderTable();
    this.renderPagination(data.total, data.pages);
  }

  async createProcess(name, description, processClass) {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    const response = await fetch('/api/upf/process', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({ name, description, class: processClass })
    });
    if (response.ok) {
      this.loadProcesses();  // Reload list
    }
  }

  async deleteProcess(processId) {
    if (!confirm('Delete this process?')) return;
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    await fetch(`/api/upf/process/${processId}`, {
      method: 'DELETE',
      headers: { 'X-CSRFToken': csrf_token },
      credentials: 'include'
    });
    this.loadProcesses();
  }

  renderTable() {
    // Populate table with this.processes
  }

  renderPagination(total, pages) {
    // Render pagination controls
  }
}
```

---

### 2. `process_editor.js`
**Responsibility:** Process builder interface

```javascript
class ProcessEditor {
  constructor(processId) {
    this.processId = processId;
    this.process = null;
    this.isDirty = false;
  }

  async load() {
    const response = await fetch(`/api/upf/process/${this.processId}`, {
      credentials: 'include'
    });
    this.process = await response.json();
    this.render();
  }

  render() {
    // Render subprocess list
    // Render variants for each subprocess
    // Render OR groups
    // Update cost display
  }

  async addSubprocess(subprocessId, sequenceOrder) {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    await fetch(`/api/upf/process/${this.processId}/add_subprocess`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({ subprocess_id: subprocessId, sequence_order: sequenceOrder })
    });
    this.load();  // Reload process
  }

  async reorderSubprocesses(sequenceMap) {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    await fetch(`/api/upf/process/${this.processId}/reorder_subprocesses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({ sequence_map: sequenceMap })
    });
  }

  async updateCost() {
    const response = await fetch(`/api/upf/process/${this.processId}/worst_case_costing`, {
      credentials: 'include'
    });
    const costData = await response.json();
    document.getElementById('total-cost').textContent = `$${costData.total_cost.toFixed(2)}`;
  }
}
```

---

### 3. `drag_drop_handler.js`
**Responsibility:** Drag-and-drop logic

```javascript
class DragDropHandler {
  constructor(editor) {
    this.editor = editor;
    this.initDragAndDrop();
  }

  initDragAndDrop() {
    // Initialize SortableJS or Dragula
    const variantCards = document.querySelectorAll('.variant-card');
    const subprocessContainers = document.querySelectorAll('.subprocess-container');

    // Make variant cards draggable
    variantCards.forEach(card => {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', this.onDragStart.bind(this));
    });

    // Make subprocess containers drop targets
    subprocessContainers.forEach(container => {
      container.addEventListener('dragover', this.onDragOver.bind(this));
      container.addEventListener('drop', this.onDrop.bind(this));
    });
  }

  onDragStart(event) {
    const itemId = event.target.dataset.itemId;
    event.dataTransfer.setData('itemId', itemId);
    event.dataTransfer.effectAllowed = 'copy';
  }

  onDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  async onDrop(event) {
    event.preventDefault();
    const itemId = event.dataTransfer.getData('itemId');
    const subprocessId = event.target.closest('.subprocess-container').dataset.subprocessId;
    
    // Add variant to subprocess
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    await fetch('/api/upf/variant_usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({
        subprocess_id: subprocessId,
        item_id: itemId,
        quantity: 1,
        unit: 'pcs'
      })
    });
    
    this.editor.load();  // Reload process
  }
}
```

---

### 4. `variant_search.js`
**Responsibility:** Autocomplete variant search

```javascript
class VariantSearch {
  constructor(inputElement, resultsContainer) {
    this.input = inputElement;
    this.results = resultsContainer;
    this.debounceTimer = null;
    this.initSearch();
  }

  initSearch() {
    this.input.addEventListener('input', (e) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.search(e.target.value);
      }, 300);  // Debounce 300ms
    });
  }

  async search(query) {
    if (query.length < 2) {
      this.results.innerHTML = '';
      return;
    }

    const response = await fetch(`/api/upf/variants/search?q=${encodeURIComponent(query)}&limit=50`, {
      credentials: 'include'
    });
    const variants = await response.json();
    this.renderResults(variants);
  }

  renderResults(variants) {
    this.results.innerHTML = '';
    variants.forEach(variant => {
      const card = document.createElement('div');
      card.className = 'variant-card';
      card.dataset.itemId = variant.item_id;
      card.draggable = true;
      card.innerHTML = `
        <strong>${variant.name}</strong>
        <span>Stock: ${variant.current_stock} ${variant.unit}</span>
        <span>Cost: $${variant.avg_cost.toFixed(2)}</span>
      `;
      this.results.appendChild(card);
    });
  }
}
```

---

### 5. `production_lot.js`
**Responsibility:** Production lot creation and execution

```javascript
class ProductionLot {
  constructor() {
    this.currentLot = null;
    this.currentStep = 1;
  }

  async createLot(processId, quantity, notes) {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    const response = await fetch('/api/upf/production_lot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({ process_id: processId, quantity, notes })
    });
    this.currentLot = await response.json();
    this.showStep2();  // Move to OR group selection
  }

  async selectVariant(groupId, variantId, reason) {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    await fetch(`/api/upf/production_lot/${this.currentLot.id}/select_variant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf_token
      },
      credentials: 'include',
      body: JSON.stringify({
        substitute_group_id: groupId,
        selected_variant_id: variantId,
        reason
      })
    });
  }

  async validate() {
    const response = await fetch(`/api/upf/production_lot/${this.currentLot.id}/validate`, {
      method: 'POST',
      credentials: 'include'
    });
    const validation = await response.json();
    this.displayValidation(validation);
    return validation.is_ready;
  }

  async execute() {
    const csrf_token = document.querySelector('[name=csrf-token]').content;
    const response = await fetch(`/api/upf/production_lot/${this.currentLot.id}/execute`, {
      method: 'POST',
      headers: { 'X-CSRFToken': csrf_token },
      credentials: 'include'
    });
    if (response.ok) {
      alert('Production lot executed successfully!');
      window.location.href = '/upf/production_lots';
    }
  }
}
```

---

### 6. `or_group_selector.js`
**Responsibility:** OR group variant selection UI

```javascript
class ORGroupSelector {
  constructor(lotId, groups) {
    this.lotId = lotId;
    this.groups = groups;
    this.selections = {};
  }

  render() {
    const container = document.getElementById('or-groups-container');
    this.groups.forEach(group => {
      const groupHtml = `
        <div class="or-group" data-group-id="${group.id}">
          <h4>${group.group_name}</h4>
          ${group.variants.map(v => `
            <label>
              <input type="radio" name="group_${group.id}" value="${v.variant_id}">
              ${v.item_name} ($${v.current_price})
            </label>
          `).join('')}
          <textarea placeholder="Reason for selection..."></textarea>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', groupHtml);
    });
  }

  getSelections() {
    const selections = [];
    this.groups.forEach(group => {
      const selected = document.querySelector(`input[name="group_${group.id}"]:checked`);
      const reason = document.querySelector(`[data-group-id="${group.id}"] textarea`).value;
      if (selected) {
        selections.push({
          group_id: group.id,
          variant_id: selected.value,
          reason
        });
      }
    });
    return selections;
  }
}
```

---

### 7. `cost_calculator.js`
**Responsibility:** Real-time cost updates

```javascript
class CostCalculator {
  constructor(processId) {
    this.processId = processId;
    this.costBreakdown = null;
  }

  async update() {
    const response = await fetch(`/api/upf/process/${this.processId}/worst_case_costing`, {
      credentials: 'include'
    });
    this.costBreakdown = await response.json();
    this.render();
  }

  render() {
    const totalCost = this.costBreakdown.total_cost;
    document.getElementById('total-cost-display').innerHTML = `
      <h3>Total Worst-Case Cost: $${totalCost.toFixed(2)}</h3>
      <div class="cost-breakdown">
        ${this.costBreakdown.subprocesses.map(sp => `
          <div class="subprocess-cost">
            <strong>${sp.subprocess_name}</strong>: $${sp.total_subprocess_cost.toFixed(2)}
          </div>
        `).join('')}
      </div>
    `;
  }
}
```

---

## CSS Styling Tips

### Variant Card Design
```css
.variant-card {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 10px;
  margin: 5px 0;
  cursor: grab;
  transition: all 0.2s;
}

.variant-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transform: translateY(-2px);
}

.variant-card.dragging {
  opacity: 0.5;
  cursor: grabbing;
}
```

### Subprocess Container
```css
.subprocess-container {
  background: #f9f9f9;
  border: 2px dashed #ccc;
  border-radius: 4px;
  padding: 15px;
  margin: 10px 0;
  min-height: 100px;
}

.subprocess-container.drag-over {
  background: #e8f5e9;
  border-color: #4caf50;
}
```

### OR Group Selector
```css
.or-group {
  background: #fff3cd;
  border: 1px solid #ffc107;
  border-radius: 4px;
  padding: 15px;
  margin: 10px 0;
}

.or-group label {
  display: block;
  padding: 8px;
  cursor: pointer;
}

.or-group label:hover {
  background: rgba(255, 193, 7, 0.1);
}
```

---

## Authentication & CSRF

### Getting CSRF Token
```html
<meta name="csrf-token" content="{{ csrf_token() }}">
```

```javascript
const csrf_token = document.querySelector('[name=csrf-token]').content;
```

### Session-Based Auth
All API requests automatically include session cookies via `credentials: 'include'`.

---

## Error Handling Pattern

```javascript
async function apiRequest(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include'
    });
    
    if (response.status === 401) {
      window.location.href = '/auth/login';
      return;
    }
    
    if (response.status === 429) {
      alert('Rate limit exceeded. Please wait and try again.');
      return;
    }
    
    if (!response.ok) {
      const error = await response.json();
      alert(`Error: ${error.error}`);
      return;
    }
    
    return await response.json();
  } catch (error) {
    console.error('API request failed:', error);
    alert('Network error. Please try again.');
  }
}
```

---

## Testing Your UI

### Manual Testing Checklist
- [ ] Create new process
- [ ] Search for variants
- [ ] Drag variant into subprocess
- [ ] Create OR group with 2+ variants
- [ ] Reorder subprocesses
- [ ] View worst-case cost breakdown
- [ ] Create production lot
- [ ] Select variant from OR group
- [ ] Validate lot readiness
- [ ] Execute production lot
- [ ] View variance analysis

### Browser Console Testing
```javascript
// Test API connectivity
fetch('/api/upf/processes?page=1', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log);

// Test process creation
fetch('/api/upf/process', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRFToken': document.querySelector('[name=csrf-token]').content
  },
  credentials: 'include',
  body: JSON.stringify({ name: 'Test Process', class: 'assembly' })
}).then(r => r.json()).then(console.log);
```

---

## Common Pitfalls & Solutions

### Problem: CSRF Token Missing
**Solution:** Ensure `<meta name="csrf-token">` is in all templates, include in all POST/PUT/DELETE requests.

### Problem: Drag-and-Drop Not Working
**Solution:** Check `draggable="true"` attribute, verify event listeners, test in different browsers.

### Problem: Real-Time Cost Not Updating
**Solution:** Call `updateCost()` after every variant add/remove/change.

### Problem: OR Group Selection Not Saving
**Solution:** Verify `substitute_group_id` and `selected_variant_id` are correct, check API response.

### Problem: Production Lot Validation Fails
**Solution:** Check `missing_selections` and `stock_shortages` in validation response, display to user.

---

## Resources

### API Documentation
- **Full API Reference:** `API_REFERENCE_UNIVERSAL_PROCESS_FRAMEWORK.md`
- **Base URL:** `/api/upf`
- **Total Endpoints:** 47

### Backend Code Reference
- **Services:** `app/services/` (business logic)
- **Models:** `app/models/` (data structures)
- **API Blueprints:** `app/api/` (endpoint implementations)

### JavaScript Libraries (Recommended)
- **Drag-and-Drop:** SortableJS (https://github.com/SortableJS/Sortable)
- **Charts:** Chart.js (https://www.chartjs.org/)
- **HTTP Requests:** Native Fetch API (built-in)
- **UI Components:** Bootstrap 5 (if already used) or custom CSS

---

## Getting Help

### Check These First
1. API Reference document - Complete endpoint documentation
2. Browser console - Check for JavaScript errors
3. Network tab - Verify API requests/responses
4. Backend logs - `logs/app.log` for server errors

### Common Questions

**Q: What's the difference between a process and a subprocess?**  
A: A **process** is a complete workflow (e.g., "Product Assembly"). A **subprocess** is a reusable step within processes (e.g., "Component Installation"). One subprocess can be used in many processes.

**Q: What is an OR group?**  
A: An **OR group** (substitute group) contains 2+ variants that can substitute for each other. During production lot creation, you choose ONE variant from each OR group.

**Q: What is worst-case costing?**  
A: **Worst-case costing** uses the MAX supplier price for each variant/OR group to ensure profitability even in the worst scenario.

**Q: When does inventory get deducted?**  
A: Inventory is deducted when you **execute** a production lot (not during planning).

---

## Timeline Estimate

| Task | Estimated Time |
|------|----------------|
| Process management page | 2 days |
| Process editor (basic) | 3 days |
| Drag-and-drop implementation | 2 days |
| Variant search autocomplete | 1 day |
| Production lot interface | 2 days |
| OR group selector | 1 day |
| Reports dashboard | 2 days |
| Testing & bug fixes | 2 days |
| **TOTAL** | **15 days (3 weeks)** |

---

## Success Criteria

- [ ] All 5 pages functional
- [ ] Drag-and-drop works smoothly
- [ ] Real-time cost updates work
- [ ] OR group selection intuitive
- [ ] Production lot execution successful
- [ ] Variance analysis displays correctly
- [ ] Mobile-responsive (optional but recommended)
- [ ] No console errors
- [ ] Passes manual testing checklist

---

**Good luck building the Universal Process Framework UI!**

If you have questions, refer to the API documentation or check the backend service implementations for business logic details.

---

**Document Version:** 1.0  
**Target Completion:** 2-3 weeks  
**Backend Status:** ✅ Complete (47 endpoints ready)
