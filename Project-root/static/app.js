/* === GLASS DASHBOARD UI (Final Complete Version) === */

// Global client-side error capture
window.addEventListener('unhandledrejection', function (ev) {
  try {
    const payload = {
      type: 'unhandledrejection',
      reason: ev.reason && (ev.reason.message || (ev.reason.toString && ev.reason.toString())) || String(ev.reason),
      stack: ev.reason && ev.reason.stack,
      page: location.href,
    };
    const stackText = payload.stack || payload.reason || '';
    const isExtensionError = /chrome-extension:\/\/|moz-extension:\/\/|safari-extension:\/\/|extension:\/\//i.test(stackText);
    if (isExtensionError) return;
    console.error('UnhandledRejection captured:', payload);
  } catch (e) {
    console.error('Error reporting unhandled rejection', e);
  }
});

window.addEventListener('error', function (ev) {
  try {
    const payload = {
      type: 'error',
      message: ev.message,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      error: ev.error && (ev.error.stack || (ev.error.toString && ev.error.toString())),
      page: location.href,
    };
    const originText = (payload.filename || '') + (payload.error || '');
    if (/chrome-extension:\/\/|moz-extension:\/\/|safari-extension:\/\/|extension:\/\//i.test(originText)) return;
    console.error('Window error captured:', payload);
  } catch (e) {
    console.error('Error reporting window error', e);
  }
});

const App = {
  apiBase: 'http://127.0.0.1:5000/api',
  colors: [],
  sizes: [],
  allItems: [],
  elementThatOpenedModal: null,

  // DOM Elements Cache
  sidebarToggleBtn: null,
  darkModeToggle: null,
  inventoryTableBody: null,
  addItemBtn: null,
  addEditModal: null,
  itemForm: null,
  modalTitle: null,
  variantsContainer: null,
  addVariantBtn: null,
  userManagementTableBody: null,
  searchInput: null,
  clearSearchBtn: null,
  manageDataBtn: null,
  masterDataModal: null,
  masterColorList: null,
  masterSizeList: null,
  addColorForm: null,
  addSizeForm: null,

  // Add this method alongside your other methods like init(), renderVariantMatrix(), etc.
handleThresholdUpdate(inputElement) {
    const editor = inputElement.closest('.threshold-editor');
    if (!editor) return;

    const variantId = editor.dataset.variantId;
    const newThreshold = inputElement.value;
    const originalValue = inputElement.dataset.originalValue;
    const textElement = editor.querySelector('.threshold-text');

    // Hide the input and show the text again
    textElement.classList.remove('hidden');
    inputElement.classList.add('hidden');
    
    // Update the display text with the new value
    textElement.textContent = `T: ${newThreshold}`;

    // Only call the API if the value has actually changed
    if (newThreshold !== originalValue) {
        const parentItemRow = inputElement.closest('tr.item-row'); // Adjust selector if needed
        this.updateThreshold(variantId, newThreshold, parentItemRow);
        inputElement.dataset.originalValue = newThreshold; // Update the original value for the next edit
    }
},


  init() {
    const onReady = () => {
      this.cacheDOMElements();
      this.bindEventListeners();
      this.initializeTheme();
      this.fetchInitialData();
      this.setActiveNavItem();
      this.setupSearchFunctionality();
    };
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady);
    } else {
      onReady();
    }
  },

  cacheDOMElements() {
    // Core navigation elements
    this.sidebarToggleBtn = document.getElementById('sidebar-toggle');
    this.darkModeToggle = document.getElementById('dark-mode-toggle');
    
    // Inventory management elements
    this.inventoryTableBody = document.getElementById('inventory-table-body');
    this.addItemBtn = document.getElementById('add-item-btn');
    this.searchInput = document.getElementById('inventory-search');
    this.clearSearchBtn = document.querySelector('.clear-search-btn');
    
    // Modal elements
    this.addEditModal = document.getElementById('add-edit-item-modal');
    this.itemForm = document.getElementById('item-form');
    this.modalTitle = document.getElementById('modal-title');
    this.variantsContainer = document.getElementById('variants-list-container');
    this.addVariantBtn = document.getElementById('add-variant-btn');
    
    // Master data elements
    this.manageDataBtn = document.getElementById('manage-data-btn');
    this.masterDataModal = document.getElementById('master-data-modal');
    this.masterColorList = document.getElementById('color-list');
    this.masterSizeList = document.getElementById('size-list');
    this.addColorForm = document.getElementById('add-color-form');
    this.addSizeForm = document.getElementById('add-size-form');
    
    // User management
    this.userManagementTableBody = document.getElementById('user-management-table-body');
  },

  bindEventListeners() {
    // Sidebar toggle
    if (this.sidebarToggleBtn) {
      this.sidebarToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('sidebar-collapsed');
        // Store preference
        localStorage.setItem('sidebarCollapsed', document.body.classList.contains('sidebar-collapsed'));
      });
    }

    // Dark mode toggle
    if (this.darkModeToggle) {
      this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());
    }

    // Inventory management
    if (this.addItemBtn) {
      this.addItemBtn.addEventListener('click', () => this.openItemModal());
    }

    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
      this.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.target.value = '';
          this.handleSearch('');
          e.target.blur();
        }
      });
    }

    if (this.clearSearchBtn) {
      this.clearSearchBtn.addEventListener('click', () => {
        this.searchInput.value = '';
        this.handleSearch('');
        this.searchInput.focus();
      });
    }

    // Master data management
    if (this.manageDataBtn) {
      this.manageDataBtn.addEventListener('click', () => this.openMasterDataModal());
    }

    // Modal event listeners
    if (this.addEditModal) {
      this.addEditModal.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-modal-btn') || e.target === this.addEditModal) {
          this.closeItemModal();
        }
      });
      this.addEditModal.addEventListener('keydown', (e) => this.handleModalKeydown(e));
    }

    if (this.masterDataModal) {
      this.masterDataModal.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-modal-btn') || e.target === this.masterDataModal) {
          this.closeMasterDataModal();
        }
      });
      this.masterDataModal.addEventListener('keydown', (e) => this.handleModalKeydown(e));
    }

    // Form submissions
    if (this.itemForm) {
      this.itemForm.addEventListener('submit', (e) => this.handleItemFormSubmit(e));
    }

    if (this.addVariantBtn) {
      this.addVariantBtn.addEventListener('click', () => this.addVariantRow());
    }


    // Variant container delegation
    if (this.variantsContainer) {
      this.variantsContainer.addEventListener('click', (e) => {
        if (e.target.closest('.remove-variant-btn')) {
          const row = e.target.closest('tr');
          if (row) {
            row.remove();
            this.updateVariantPlaceholder();
          }
        }
      });
    }

    // Table actions
    if (this.inventoryTableBody) {
      this.inventoryTableBody.addEventListener('click', (e) => this.handleTableActions(e));
      this.inventoryTableBody.addEventListener('change', (e) => this.handleTableActions(e));
      this.inventoryTableBody.addEventListener('input', (e) => this.handleTableInput(e));
    }

    // User management
    if (this.userManagementTableBody) {
      this.userManagementTableBody.addEventListener('click', (e) => this.handleUserActions(e));
    }

    // Master data forms
    if (this.addColorForm) {
      this.addColorForm.addEventListener('submit', (e) => this.handleMasterAdd(e, 'color'));
    }

    if (this.addSizeForm) {
      this.addSizeForm.addEventListener('submit', (e) => this.handleMasterAdd(e, 'size'));
    }

    // Master data lists
    if (this.masterColorList) {
      this.masterColorList.addEventListener('click', (e) => this.handleMasterActions(e, 'color'));
    }

    if (this.masterSizeList) {
      this.masterSizeList.addEventListener('click', (e) => this.handleMasterActions(e, 'size'));
    }

    // NEW: Listener for starting the threshold edit
    if(this.container){
    this.container.addEventListener('click', (e) => {
        if (e.target.classList.contains('threshold-text')) {
            const editor = e.target.closest('.threshold-editor');
            const input = editor.querySelector('.threshold-input');

            e.target.classList.add('hidden');
            input.classList.remove('hidden');
            input.focus();
        }
    });
  }

    // NEW: Listener for saving when the input loses focus
    if(this.container){
    this.container.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('threshold-input')) {
            this.handleThresholdUpdate(e.target);
        }
    });
  }

    // NEW: Listener for saving when 'Enter' is pressed
    if(this.container){
    this.container.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('threshold-input') && e.key === 'Enter') {
            e.preventDefault(); // Prevents form submission
            this.handleThresholdUpdate(e.target);
        }
    });
  }

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'k') {
          e.preventDefault();
          if (this.searchInput) {
            this.searchInput.focus();
            this.searchInput.select();
          }
        }
        if (e.key === 'n' && this.addItemBtn) {
          e.preventDefault();
          this.openItemModal();
        }
      }
    });
  },

  initializeTheme() {
    // Load saved theme preference
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    }

    // Load sidebar preference
    const sidebarCollapsed = localStorage.getItem('sidebarCollapsed');
    if (sidebarCollapsed === 'true') {
      document.body.classList.add('sidebar-collapsed');
    }
  },

  setupSearchFunctionality() {
    if (this.searchInput && this.clearSearchBtn) {
      // Show/hide clear button based on input value
      const toggleClearButton = () => {
        if (this.searchInput.value.trim()) {
          this.clearSearchBtn.style.display = 'block';
        } else {
          this.clearSearchBtn.style.display = 'none';
        }
      };

      this.searchInput.addEventListener('input', toggleClearButton);
      toggleClearButton(); // Initial state
    }
  },

  setActiveNavItem() {
    const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
    const navLinks = document.querySelectorAll('.sidebar-nav .nav-item');
    
    navLinks.forEach(link => {
      try {
        const href = link.href ? 
          new URL(link.href, location.href).pathname.replace(/\/$/, '') : 
          (link.getAttribute('href') || '').replace(/\/$/, '');
        const normalizedHref = href || '/';
        const isMatch = normalizedHref === currentPath || 
          (currentPath === '/' && normalizedHref === '/inventory');
        
        if (isMatch) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      } catch (e) {
        const attr = (link.getAttribute('href') || '').replace(/\/$/, '') || '/';
        if (attr === currentPath || (currentPath === '/' && attr === '/inventory')) {
          link.classList.add('active');
        }
      }
    });
  },

  async fetchInitialData() {
    if (this.inventoryTableBody) {
      await Promise.all([
        this.fetchItems(),
        this.fetchMasterData('colors'),
        this.fetchMasterData('sizes'),
        this.fetchItemNames()
      ]);
      this.populateDatalists();
    }

    if (this.userManagementTableBody) {
      this.fetchUsers();
    }
  },

  async fetchJson(url, options = {}) {
    const defaultOptions = { 
      credentials: 'include', 
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'application/json' 
      } 
    };
    
    try {
      const res = await fetch(url, { ...defaultOptions, ...options });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`HTTP ${res.status}: ${errorData.error || errorData.message}`);
      }
      
      return res.status === 204 ? true : await res.json();
    } catch (err) {
      console.error(`Fetch error for ${url}:`, err);
      this.showNotification(err.message, 'error');
      return null;
    }
  },

  showNotification(message, type = 'success') {
    const container = document.querySelector('.container') || document.body;
    const notification = document.createElement('div');
    notification.className = `flash ${type}`;
    notification.textContent = message;
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:inherit;font-size:1.2em;cursor:pointer;margin-left:auto;padding:0 0.5rem;';
    closeBtn.addEventListener('click', () => notification.remove());
    
    notification.style.display = 'flex';
    notification.style.alignItems = 'center';
    notification.appendChild(closeBtn);
    
    container.prepend(notification);
    
    // Auto remove
    setTimeout(() => {
      if (notification.parentNode) {
        notification.style.opacity = '0';
        setTimeout(() => {
          if (notification.parentNode) {
            notification.remove();
          }
        }, 500);
      }
    }, 4000);
  },

  toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDarkMode = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  },

  handleSearch(searchTerm) {
    if (!this.allItems || !Array.isArray(this.allItems)) return;
    
    const filteredItems = searchTerm.trim() === '' ? this.allItems : 
      this.allItems.filter(item => {
        const searchableText = [
          item.name || '', 
          item.model || '', 
          item.variation || ''
        ].join(' ').toLowerCase();
        return searchableText.includes(searchTerm.toLowerCase());
      });
    
    this.renderItemsList(filteredItems);
    
    const resultCount = document.getElementById('search-result-count');
    if (resultCount) {
      if (searchTerm.trim() === '') {
        resultCount.textContent = `Showing all ${this.allItems.length} items`;
      } else {
        resultCount.textContent = `Showing ${filteredItems.length} of ${this.allItems.length} items`;
      }
    }
  },

  async fetchUsers() {
    const users = await this.fetchJson(`${this.apiBase}/users`);
    if (users) this.renderUsersList(users);
  },

  renderUsersList(users) {
    if (!this.userManagementTableBody) return;
    
    if (users.length === 0) {
      this.userManagementTableBody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 2rem;">
            No other users found.
          </td>
        </tr>`;
      return;
    }
    
    const roles = ['user', 'admin', 'pending_approval'];
    this.userManagementTableBody.innerHTML = users.map(user => `
      <tr data-user-id="${user.user_id}">
        <td data-label="Name">${this.escapeHtml(user.name)}</td>
        <td data-label="Email">${this.escapeHtml(user.email)}</td>
        <td data-label="Role" class="current-role">${user.role.replace('_', ' ')}</td>
        <td data-label="Actions" class="actions-cell">
          <select class="role-select">
            ${roles.map(r => `
              <option value="${r}" ${user.role === r ? 'selected' : ''}>
                ${r.replace('_', ' ')}
              </option>
            `).join('')}
          </select>
          <button class="button create update-role-btn">Update</button>
        </td>
      </tr>
    `).join('');
  },

  async handleUserActions(e) {
    const button = e.target.closest('button.update-role-btn');
    if (!button) return;
    
    const row = button.closest('tr');
    const userId = row.dataset.userId;
    const newRole = row.querySelector('.role-select').value;
    const currentRoleCell = row.querySelector('.current-role');
    
    // Disable button during update
    button.disabled = true;
    button.textContent = 'Updating...';
    
    try {
      const result = await this.fetchJson(`${this.apiBase}/users/${userId}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: newRole })
      });
      
      if (result) {
        this.showNotification(`User role updated to ${newRole.replace('_', ' ')}.`, 'success');
        currentRoleCell.textContent = newRole.replace('_', ' ');
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Update';
    }
  },

  async fetchItems() {
    const items = await this.fetchJson(`${this.apiBase}/items`);
    if (items) {
      this.allItems = items;
      this.renderItemsList(items);
      
      const resultCount = document.getElementById('search-result-count');
      if (resultCount) {
        resultCount.textContent = `Showing all ${items.length} items`;
      }
    }
  },

  renderItemsList(items) {
    if (!this.inventoryTableBody) return;
    
    if (items.length === 0) {
      const message = this.allItems.length > 0 ? 
        'No items match your search.' : 
        'No items found. Click "Add New Item" to get started!';
      
      this.inventoryTableBody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; padding: 2rem;">
            ${message}
          </td>
        </tr>`;
      return;
    }
    
    this.inventoryTableBody.innerHTML = items.map(item => {
      const isLowStock = item.has_low_stock_variants;
      const statusClass = isLowStock ? 'low-stock' : 'in-stock';
      const statusText = isLowStock ? 'Low Stock' : 'In Stock';
      
      return `
        <tr class="item-row" data-item-id="${item.id}" data-item-name="${this.escapeHtml(item.name)}" data-item-description="${this.escapeHtml(item.description || '')}">
          <td data-label="">
            <button class="expand-btn" title="View Variants" aria-expanded="false">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"></polyline>
              </svg>
            </button>
          </td>
          <td data-label="ID">${item.id}</td>
          <td data-label="Item Name" class="item-name-cell" title="${this.escapeHtml(item.description || 'No description provided.')}">
            ${this.escapeHtml(item.name)}
          </td>
          <td data-label="Model">${this.escapeHtml(item.model || 'N/A')}</td>
          <td data-label="Variation" class="item-variation-cell">${this.escapeHtml(item.variation || 'N/A')}</td>
          <td data-label="Variants">${item.variant_count}</td>
          <td data-label="Total Stock" class="total-stock-cell">${item.total_stock}</td>
          <td data-label="Status">
            <span class="status-badge ${statusClass}">${statusText}</span>
          </td>
          <td data-label="Actions" class="actions-cell">
            <button class="button create edit-item" title="Edit Item">Edit</button>
            <button class="button cancel delete-item" title="Delete Item">Delete</button>
          </td>
        </tr>
        <tr class="variant-details-row" style="display: none;">
          <td colspan="9" class="variant-details-container"></td>
        </tr>
      `;
    }).join('');
  },

  async handleTableActions(e) {
    // Handle input changes for stock and threshold
    if (e.type === 'change' && (e.target.classList.contains('stock-input') || e.target.classList.contains('threshold-input'))) {
      this.handleStockThresholdChange(e.target);
      return;
    }
    
    const button = e.target.closest('button');
    if (!button) return;
    
    const row = button.closest('.item-row');
    if (!row) return;
    
    const itemId = row.dataset.itemId;
    const itemName = row.dataset.itemName;
    
    if (button.classList.contains('expand-btn')) {
      await this.toggleVariantDetails(row, button, itemId);
    } else if (button.classList.contains('edit-item')) {
      this.openItemModal(itemId);
    } else if (button.classList.contains('delete-item')) {
      this.deleteItem(itemId, itemName);
    }
  },

  handleTableInput(e) {
    // Handle real-time input changes with debouncing
    if (e.target.classList.contains('stock-input') || e.target.classList.contains('threshold-input')) {
      clearTimeout(e.target.debounceTimeout);
      e.target.debounceTimeout = setTimeout(() => {
        this.handleStockThresholdChange(e.target);
      }, 1000); // 1 second debounce
    }
  },

  async handleStockThresholdChange(input) {
    const variantId = input.dataset.variantId;
    const parentDetailsRow = input.closest('.variant-details-row');
    const parentItemRow = parentDetailsRow ? parentDetailsRow.previousElementSibling : null;
    
    if (!parentItemRow || !variantId) return;
    
    const originalValue = input.dataset.originalValue || input.defaultValue;
    const newValue = parseInt(input.value);
    
    // Validate input
    if (isNaN(newValue) || newValue < 0) {
      input.value = originalValue;
      this.showNotification('Please enter a valid number.', 'error');
      return;
    }
    
    // Skip if value hasn't changed
    if (newValue.toString() === originalValue) return;
    
    try {
      if (input.classList.contains('stock-input')) {
        await this.updateStock(variantId, newValue, parentItemRow);
      } else {
        await this.updateThreshold(variantId, newValue, parentItemRow);
      }
      
      // Update the original value
      input.dataset.originalValue = newValue.toString();
    } catch (error) {
      // Revert on error
      input.value = originalValue;
    }
  },

  async toggleVariantDetails(itemRow, expandBtn, itemId) {
    const detailsRow = itemRow.nextElementSibling;
    const isVisible = detailsRow.style.display !== 'none';
    
    if (isVisible) {
      detailsRow.style.display = 'none';
      expandBtn.classList.remove('expanded');
      expandBtn.setAttribute('aria-expanded', 'false');
    } else {
      const container = detailsRow.querySelector('.variant-details-container');
      
      // Show loading state
      container.innerHTML = `
        <div style="padding: 1rem; text-align: center;">
          <div class="loading-spinner">
            <div class="spinner"></div>
            <span>Loading details...</span>
          </div>
        </div>`;
      
      detailsRow.style.display = 'table-row';
      expandBtn.classList.add('expanded');
      expandBtn.setAttribute('aria-expanded', 'true');
      
      const description = itemRow.dataset.itemDescription;
      const variants = await this.fetchJson(`${this.apiBase}/items/${itemId}/variants`);
      
      container.innerHTML = '';
      
      if (description) {
        container.innerHTML += `
          <div class="item-description-detail">
            <strong>Description:</strong> ${this.escapeHtml(description)}
          </div>`;
      }
      
      if (variants && variants.length > 0) {
        this.renderVariantMatrix(container, variants);
      } else {
        container.innerHTML += `
          <p style="padding: 1rem; text-align: center; color: var(--subtle-text-color);">
            No variants found for this item.
          </p>`;
      }
    }
  },

  renderVariantMatrix(container, variants) {
    // Get all unique sizes and sort them
    const allSizes = [...new Set(variants.map(v => v.size.name))].sort((a, b) => {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    
    // Group variants by color
    const variantsByColor = variants.reduce((acc, v) => {
      if (!acc[v.color.name]) acc[v.color.name] = {};
      acc[v.color.name][v.size.name] = {
        stock: v.opening_stock,
        threshold: v.threshold,
        variantId: v.id
      };
      return acc;
    }, {});
    
    const sizeHeaders = allSizes.map(size => `<th class="size-header">${this.escapeHtml(size)}</th>`).join('');
    
    const colorRows = Object.entries(variantsByColor).map(([colorName, sizeData]) => {
      const stockCells = allSizes.map(size => {
        const variantInfo = sizeData[size];
        if (variantInfo) {
          const isLowStock = variantInfo.stock <= variantInfo.threshold;
          const statusClass = isLowStock ? 'low-stock' : 'in-stock';
          
          return `
          <td class="variant-cell">
          <div class="variant-cell-compact" data-threshold="Threshold: ${variantInfo.threshold}">
          <input type="number" 
             id="stock_${variantInfo.variantId}"   
             name="stock"                         
             class="stock-input compact" 
             value="${variantInfo.stock}" 
             data-variant-id="${variantInfo.variantId}"
             data-original-value="${variantInfo.stock}"
             min="0"
             title="Stock">
        <span class="status-badge variant-status ${statusClass}">
        ${isLowStock ? 'LOW' : 'OK'}
      </span>

      </div>
    </td>`;
        }
        return `<td class="empty-cell">—</td>`;
      }).join('');
      
      return `
        <tr>
          <td class="color-cell">${this.escapeHtml(colorName)}</td>
          ${stockCells}
        </tr>`;
    }).join('');
    
    container.innerHTML += `
      <div class="variants-matrix-container">
        <table class="variants-matrix-table">
          <thead>
            <tr>
              <th class="color-header">Color</th>
              ${sizeHeaders}
            </tr>
          </thead>
          <tbody>
            ${colorRows}
          </tbody>
        </table>
      </div>`;
  },

  async updateStock(variantId, newStock, parentItemRow) {
    const result = await this.fetchJson(`${this.apiBase}/variants/${variantId}/stock`, {
      method: 'PUT',
      body: JSON.stringify({ stock: newStock })
    });
    
    if (result) {
      this.showNotification('Stock updated!', 'success');
      
      if (parentItemRow) {
        const totalStockCell = parentItemRow.querySelector('.total-stock-cell');
        if (totalStockCell && result.new_total_stock !== undefined) {
          totalStockCell.textContent = result.new_total_stock;
        }
        
        // Update status badge if needed
        this.updateItemStatusBadge(parentItemRow, result.has_low_stock_variants);
      }
      
      // Refresh items list to ensure consistency
      this.fetchItems();
    }
  },

  async updateThreshold(variantId, newThreshold, parentItemRow) {
    const result = await this.fetchJson(`${this.apiBase}/variants/${variantId}/threshold`, {
      method: 'PUT',
      body: JSON.stringify({ threshold: newThreshold })
    });
    
    if (result) {
      this.showNotification('Threshold updated!', 'success');
      
      // Update status badge if needed
      if (parentItemRow) {
        this.updateItemStatusBadge(parentItemRow, result.has_low_stock_variants);
      }
      
      // Refresh items list to ensure consistency
      this.fetchItems();
    }
  },

  updateItemStatusBadge(itemRow, hasLowStockVariants) {
    const statusBadge = itemRow.querySelector('.status-badge');
    if (statusBadge) {
      statusBadge.className = `status-badge ${hasLowStockVariants ? 'low-stock' : 'in-stock'}`;
      statusBadge.textContent = hasLowStockVariants ? 'Low Stock' : 'In Stock';
    }
  },

  async fetchItemNames() {
    const names = await this.fetchJson(`${this.apiBase}/item-names`);
    const datalist = document.getElementById('item-name-list');
    if (!datalist) return;
    
    datalist.innerHTML = '';
    if (!Array.isArray(names)) return;
    
    names.forEach(name => {
      const val = typeof name === 'string' ? name : (name && (name.name || name.value));
      if (!val) return;
      
      const opt = document.createElement('option');
      opt.value = val;
      datalist.appendChild(opt);
    });
  },

  handleModalKeydown(e) {
    if (e.key === 'Escape') {
      // Close the appropriate modal
      if (this.addEditModal && this.addEditModal.getAttribute('aria-hidden') === 'false') {
        this.closeItemModal();
      } else if (this.masterDataModal && this.masterDataModal.getAttribute('aria-hidden') === 'false') {
        this.closeMasterDataModal();
      }
      return;
    }
    
    // Tab trap for modals
    if (e.key === 'Tab') {
      const activeModal = document.querySelector('.modal[aria-hidden="false"]');
      if (!activeModal) return;
      
      const focusableElements = Array.from(activeModal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )).filter(el => !el.disabled && !el.hidden);
      
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement?.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement?.focus();
          e.preventDefault();
        }
      }
    }
  },

  async openItemModal(itemId = null) {
    this.elementThatOpenedModal = document.activeElement;
    
    if (this.itemForm) this.itemForm.reset();
    
    const itemIdInput = document.getElementById('item-id');
    if (itemIdInput) itemIdInput.value = itemId || '';
    
    if (itemId) {
      this.modalTitle.textContent = 'Edit Item';
      
      const [itemData, variantData] = await Promise.all([
        this.fetchJson(`${this.apiBase}/items/${itemId}`),
        this.fetchJson(`${this.apiBase}/items/${itemId}/variants`)
      ]);
      
      if (itemData && variantData) {
        // Populate form fields
        const fields = ['item-name', 'item-model', 'item-variation', 'item-description'];
        const data = [itemData.name, itemData.model || '', itemData.variation || '', itemData.description || ''];
        
        fields.forEach((fieldId, index) => {
          const field = document.getElementById(fieldId);
          if (field) field.value = data[index];
        });
        
        this.renderVariantsInModal(variantData);
      }
    } else {
      this.modalTitle.textContent = 'Add New Item';
      this.renderVariantsInModal([]);
      setTimeout(() => this.addVariantRow(), 100);
    }
    
    this.addEditModal.setAttribute('aria-hidden', 'false');
    this.addEditModal.style.display = 'flex';
    
    // Focus management
    setTimeout(() => {
      const firstInput = this.addEditModal.querySelector('input, select, textarea, button');
      if (firstInput) firstInput.focus();
    }, 100);
  },

  closeItemModal() {
    if (this.addEditModal) {
      this.addEditModal.setAttribute('aria-hidden', 'true');
      this.addEditModal.style.display = 'none';
    }
    
    if (this.variantsContainer) {
      this.variantsContainer.innerHTML = '';
    }
    
    if (this.elementThatOpenedModal) {
      this.elementThatOpenedModal.focus();
      this.elementThatOpenedModal = null;
    }
  },

  renderVariantsInModal(variants) {
    if (!this.variantsContainer) return;
    
    if (variants.length === 0) {
      this.variantsContainer.innerHTML = `
        <div class="variants-placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 1v6m0 6v6m11-7h-6m-6 0H1"></path>
          </svg>
          <p>No variants added yet</p>
          <small>Click "Add Variant" to create color/size combinations</small>
        </div>`;
      return;
    }
    
    const tableHTML = `
      <div class="variants-table-wrapper">
        <table class="variants-modal-table">
          <thead>
            <tr>
              <th>Color</th>
              <th>Size</th>
              <th>Stock</th>
              <th>Threshold</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${variants.map(v => this.createVariantRowHTML(v)).join('')}
          </tbody>
        </table>
      </div>`;
    
    this.variantsContainer.innerHTML = tableHTML;
  },

  addVariantRow() {
    if (!this.variantsContainer) return;
    
    let tbody = this.variantsContainer.querySelector('tbody');
    
    if (!tbody) {
      // Create table structure if it doesn't exist
      this.variantsContainer.innerHTML = `
        <div class="variants-table-wrapper">
          <table class="variants-modal-table">
            <thead>
              <tr>
                <th>Color</th>
                <th>Size</th>
                <th>Stock</th>
                <th>Threshold</th>
                <th></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>`;
      tbody = this.variantsContainer.querySelector('tbody');
    }
    
    tbody.insertAdjacentHTML('beforeend', this.createVariantRowHTML());
    
    // Focus the new row's first input
    const newRow = tbody.lastElementChild;
    const firstInput = newRow.querySelector('input');
    if (firstInput) firstInput.focus();
  },

  createVariantRowHTML(variant = null) {
    const variantId = variant ? variant.id : '';
    const stock = variant ? variant.opening_stock : 0;
    const threshold = variant ? variant.threshold : 5;
    const colorName = variant ? this.escapeHtml(variant.color.name) : '';
    const sizeName = variant ? this.escapeHtml(variant.size.name) : '';
    
    return `
      <tr class="variant-modal-row" data-variant-id="${variantId}">
        <td>
          <input type="text" 
                 list="color-datalist" 
                 class="variant-color" 
                 value="${colorName}" 
                 placeholder="Color"
                 required>
        </td>
        <td>
          <input type="text" 
                 list="size-datalist" 
                 class="variant-size" 
                 value="${sizeName}" 
                 placeholder="Size"
                 required>
        </td>
        <td>
          <input type="number" 
                 class="stock-input" 
                 value="${stock}" 
                 min="0"
                 required>
        </td>
        <td>
          <input type="number" 
                 class="threshold-input" 
                 value="${threshold}" 
                 min="0"
                 required>
        </td>
        <td>
          <button type="button" 
                  class="button cancel remove-variant-btn" 
                  title="Remove variant">
            &times;
          </button>
        </td>
      </tr>`;
  },

  updateVariantPlaceholder() {
    if (!this.variantsContainer) return;
    
    const tbody = this.variantsContainer.querySelector('tbody');
    if (tbody && tbody.children.length === 0) {
      this.renderVariantsInModal([]);
    }
  },

  async handleItemFormSubmit(e) {
    e.preventDefault();
    
    const itemId = document.getElementById('item-id')?.value;
    const isEditing = !!itemId;
    
    // Get form data
    const formData = {
      name: document.getElementById('item-name')?.value?.trim(),
      model: document.getElementById('item-model')?.value?.trim(),
      variation: document.getElementById('item-variation')?.value?.trim(),
      description: document.getElementById('item-description')?.value?.trim()
    };
    
    // Validate required fields
    if (!formData.name) {
      this.showNotification('Item name is required.', 'error');
      document.getElementById('item-name')?.focus();
      return;
    }
    
    // Get variants data
    const variantRows = this.variantsContainer?.querySelectorAll('tbody tr') || [];
    const variants = Array.from(variantRows).map(row => {
      const variantId = row.dataset.variantId;
      const color = row.querySelector('.variant-color')?.value?.trim();
      const size = row.querySelector('.variant-size')?.value?.trim();
      const stock = parseInt(row.querySelector('.stock-input')?.value) || 0;
      const threshold = parseInt(row.querySelector('.threshold-input')?.value) || 5;
      
      if (!color || !size) {
        throw new Error('All variants must have both color and size specified.');
      }
      
      return {
        ...(variantId && { id: variantId }),
        color,
        size,
        opening_stock: stock,
        threshold
      };
    });
    
    // Validate variants
    if (variants.length === 0) {
      this.showNotification('At least one variant is required.', 'error');
      return;
    }
    
    try {
      const payload = { ...formData, variants };
      const url = isEditing ? `${this.apiBase}/items/${itemId}` : `${this.apiBase}/items`;
      const method = isEditing ? 'PUT' : 'POST';
      
      const result = await this.fetchJson(url, { method, body: JSON.stringify(payload) });
      
      if (result) {
        this.showNotification(`Item ${isEditing ? 'updated' : 'added'} successfully!`, 'success');
        this.closeItemModal();
        
        // Refresh data
        await Promise.all([
          this.fetchItems(),
          this.fetchMasterData('colors'),
          this.fetchMasterData('sizes'),
          this.fetchItemNames()
        ]);
        
        this.populateDatalists();
      }
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  },

  async deleteItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"? This action cannot be undone.`)) {
      return;
    }
    
    const result = await this.fetchJson(`${this.apiBase}/items/${itemId}`, { method: 'DELETE' });
    
    if (result) {
      this.showNotification(`Item "${itemName}" deleted.`, 'success');
      await this.fetchItems();
      await this.fetchItemNames();
    }
  },

  async fetchMasterData(type) {
    const data = await this.fetchJson(`${this.apiBase}/${type}`) || [];
    this[type] = data;
    return data;
  },

  populateDatalists() {
    const colorDatalist = document.getElementById('color-datalist');
    const sizeDatalist = document.getElementById('size-datalist');
    
    if (colorDatalist) {
      colorDatalist.innerHTML = this.colors.map(c => 
        `<option value="${this.escapeHtml(c.name)}"></option>`
      ).join('');
    }
    
    if (sizeDatalist) {
      sizeDatalist.innerHTML = this.sizes.map(s => 
        `<option value="${this.escapeHtml(s.name)}"></option>`
      ).join('');
    }
  },

  async openMasterDataModal() {
    if (!this.masterDataModal) return;
    
    this.masterDataModal.setAttribute('aria-hidden', 'false');
    this.masterDataModal.style.display = 'flex';
    this.elementThatOpenedModal = document.activeElement;
    
    await this.fetchAndRenderAllMasterData();
    
    setTimeout(() => {
      const firstInput = this.masterDataModal.querySelector('input, button');
      if (firstInput) firstInput.focus();
    }, 100);
  },

  closeMasterDataModal() {
    if (this.masterDataModal) {
      this.masterDataModal.setAttribute('aria-hidden', 'true');
      this.masterDataModal.style.display = 'none';
    }
    
    if (this.elementThatOpenedModal) {
      this.elementThatOpenedModal.focus();
      this.elementThatOpenedModal = null;
    }
  },

  async fetchAndRenderAllMasterData() {
    await Promise.all([
      this.fetchAndRenderMasterData('color'),
      this.fetchAndRenderMasterData('size')
    ]);
  },

  async fetchAndRenderMasterData(type) {
    const listEl = type === 'color' ? this.masterColorList : this.masterSizeList;
    if (!listEl) return;
    
    const items = await this.fetchJson(`${this.apiBase}/${type}s`);
    
    if (items && items.length > 0) {
      listEl.innerHTML = items.map(item => this.createMasterItemHTML(item)).join('');
    } else {
      listEl.innerHTML = `<p class="empty-list-message">No ${type}s found.</p>`;
    }
  },

  createMasterItemHTML(item) {
    return `
      <div class="master-item" data-id="${item.id}">
        <input type="text" 
               class="master-item-input" 
               value="${this.escapeHtml(item.name)}" 
               readonly>
        <div class="master-item-actions">
          <button class="button icon-btn edit-master" title="Edit" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="button icon-btn save-master" title="Save" style="display: none;" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
          <button class="button icon-btn danger delete-master" title="Delete" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>`;
  },

  async handleMasterAdd(e, type) {
    e.preventDefault();
    
    const form = e.target;
    const input = form.querySelector('.add-new-input');
    const name = input?.value?.trim();
    
    if (!name) {
      this.showNotification(`Please enter a ${type} name.`, 'error');
      input?.focus();
      return;
    }
    
    const result = await this.fetchJson(`${this.apiBase}/${type}s`, {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    
    if (result) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} added successfully!`, 'success');
      input.value = '';
      
      await Promise.all([
        this.fetchAndRenderMasterData(type),
        this.fetchMasterData(`${type}s`)
      ]);
      
      this.populateDatalists();
    }
  },

  handleMasterActions(e, type) {
    const button = e.target.closest('button');
    if (!button) return;
    
    const itemEl = button.closest('.master-item');
    const input = itemEl.querySelector('.master-item-input');
    const id = itemEl.dataset.id;
    const editBtn = itemEl.querySelector('.edit-master');
    const saveBtn = itemEl.querySelector('.save-master');
    
    if (button.classList.contains('edit-master')) {
      input.readOnly = false;
      input.focus();
      input.select();
      editBtn.style.display = 'none';
      saveBtn.style.display = 'flex';
    } else if (button.classList.contains('save-master')) {
      this.handleMasterUpdate(type, id, input.value.trim(), () => {
        input.readOnly = true;
        editBtn.style.display = 'flex';
        saveBtn.style.display = 'none';
      });
    } else if (button.classList.contains('delete-master')) {
      this.handleMasterDelete(type, id, input.value);
    }
  },

  async handleMasterUpdate(type, id, name, onFinish) {
    if (!name) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} name cannot be empty.`, 'error');
      onFinish();
      return;
    }
    
    const result = await this.fetchJson(`${this.apiBase}/${type}s/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    
    if (result) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} updated.`, 'success');
      onFinish();
      
      await this.fetchMasterData(`${type}s`);
      this.populateDatalists();
    } else {
      onFinish();
    }
  },

  async handleMasterDelete(type, id, name) {
    if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis may affect existing item variants and cannot be undone.`)) {
      return;
    }
    
    const result = await this.fetchJson(`${this.apiBase}/${type}s/${id}`, {
      method: 'DELETE'
    });
    
    if (result) {
      this.showNotification(`"${name}" has been deleted.`, 'success');
      
      await Promise.all([
        this.fetchAndRenderMasterData(type),
        this.fetchMasterData(`${type}s`)
      ]);
      
      this.populateDatalists();
    }
  },

  // Utility function to escape HTML
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text ? text.replace(/[&<>"']/g, function(m) { return map[m]; }) : '';
  }
};

// Initialize the app
App.init();
