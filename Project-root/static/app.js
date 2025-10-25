/* === GLASS DASHBOARD UI (Final Complete Version) === */

// Global client-side error capture
window.addEventListener('unhandledrejection', function (ev) {
  // This is a common error caused by browser extensions and can be safely ignored.
  const message = ev?.reason?.message || '';
  if (message.includes('message channel closed') || message.includes('A listener indicated an asynchronous response')) {
    ev.preventDefault();
    return;
  }

  try {
    const reason = ev.reason || {};
    const reasonText = reason.message || (reason.toString && reason.toString()) || '';
    const payload = {
      type: 'unhandledrejection',
      reason: reasonText,
      stack: reason.stack,
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
    if (ev.message && ev.message.includes('message channel closed')) {
      ev.preventDefault();
      return;
    }
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

// ✅ PERFORMANCE: Debounce utility to prevent excessive function calls
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const App = {
  apiBase: 'http://127.0.0.1:5000/api',
  colors: [],
  sizes: [],
  models: [],
  variations: [],
  allItems: [],
  allVariantsForSearch: [],
  elementThatOpenedModal: null,

  // DOM Elements Cache
  sidebarToggleBtn: null,
  darkModeToggle: null,
  inventoryTableBody: null,
  addItemBtn: null,
  itemForm: null,
  modalTitle: null,
  variantsContainer: null,
  addVariantBtn: null,
  userManagementTableBody: null,
  searchInput: null,
  clearSearchBtn: null,
  addColorForm: null,
  addSizeForm: null,

  async init() {
    const onReady = async () => {
      // Non-essential setup can be delayed to improve INP
      setTimeout(() => {
        this.cacheDOMElements();
        this.bindEventListeners();
        this.initImportModal();
        this.initializeTheme();
        this.fetchInitialData();
        this.setActiveNavItem();
        this.setupSearchFunctionality();
      }, 100); // A small delay can make a big difference
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady);
    } else {
      await onReady();
    }
  },

  cacheDOMElements() {
    this.sidebarToggleBtn = document.getElementById('sidebar-toggle');
    this.darkModeToggle = document.getElementById('dark-mode-toggle');
    this.inventoryTableBody = document.getElementById('inventory-table-body');
    this.addItemBtn = document.getElementById('add-item-btn');
    this.searchInput = document.getElementById('inventory-search');
    this.lowStockFilter = document.getElementById('low-stock-filter');
    this.clearSearchBtn = document.querySelector('.clear-search-btn');
    this.itemForm = document.getElementById('item-form');
    this.modalTitle = document.getElementById('modal-title');
    this.variantsContainer = document.getElementById('variants-list-container');
    this.addVariantBtn = document.getElementById('add-variant-btn');
    this.userManagementTableBody = document.getElementById('user-management-table-body');
    this.addColorForm = document.getElementById('add-color-form');
    this.addSizeForm = document.getElementById('add-size-form');
    this.masterColorList = document.getElementById('color-list');
    this.masterSizeList = document.getElementById('size-list');
    this.importModal = document.getElementById('import-modal');
    this.importDataBtn = document.getElementById('import-data-btn');
    this.lowStockReportBtn = document.getElementById('low-stock-report-btn');
    this.lowStockReportModal = document.getElementById('low-stock-report-modal');
    this.lowStockReportBody = document.getElementById('low-stock-report-body');
    this.printLowStockReportBtn = document.getElementById('print-low-stock-report-btn');

    // Supplier elements
    this.suppliersTableBody = document.getElementById('suppliers-table-body');
    this.addSupplierBtn = document.getElementById('add-supplier-btn');
    this.supplierModal = document.getElementById('supplier-modal');
    this.supplierForm = document.getElementById('supplier-form');
    this.contactsContainer = document.getElementById('contacts-container');
    this.addContactBtn = document.getElementById('add-contact-btn');
    this.ledgerModal = document.getElementById('ledger-modal');
    this.ratesModal = document.getElementById('rates-modal');

    // PO elements
    this.poTableBody = document.getElementById('po-table-body');
    this.addPoBtn = document.getElementById('add-po-btn');
    this.poModal = document.getElementById('po-modal');
    this.poDetailsModal = document.getElementById('po-details-modal');
    this.poForm = document.getElementById('po-form');
    this.poItemsContainer = document.getElementById('po-items-container');
    this.addPoItemBtn = document.getElementById('add-po-item-btn');

    // Inventory page buttons
    this.receiveStockBtn = document.getElementById('receive-stock-btn');
    this.generatePoBtn = document.getElementById('generate-po-btn');
    this.receiveStockModal = document.getElementById('receive-stock-modal');
    this.receiveStockForm = document.getElementById('receive-stock-form');

    // Variant search modal elements
    this.variantSearchModal = document.getElementById('variant-search-modal');
    this.variantSearchInput = document.getElementById('variant-search-input');
    this.variantSearchResults = document.getElementById('variant-search-results');
    this.addSelectedVariantsBtn = document.getElementById('add-selected-variants-btn');
    this.selectAllVariantsCheckbox = document.getElementById('select-all-variants');
  },

  bindEventListeners() {
    if (this.sidebarToggleBtn) {
      this.sidebarToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('sidebar-collapsed');
        localStorage.setItem('sidebarCollapsed', document.body.classList.contains('sidebar-collapsed'));
      });
    }

    if (this.darkModeToggle) {
      this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());
    }

    if (this.addItemBtn) {
      this.addItemBtn.addEventListener('click', () => window.location.href = '/add_item');
    }

    if (this.searchInput) {
    // ✅ PERFORMANCE: Debounce search to reduce API calls
    const debouncedSearch = debounce((value) => this.handleSearch(value), 300);
    this.searchInput.addEventListener('input', (e) => debouncedSearch(e.target.value));
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

    if (this.lowStockFilter) {
      this.lowStockFilter.addEventListener('change', () => this.fetchItems());
    }

    if (this.itemForm) {
      this.itemForm.addEventListener('submit', (e) => this.handleItemFormSubmit(e));
    }

    if (this.addVariantBtn) {
      this.addVariantBtn.addEventListener('click', () => this.addVariantRow());
    }

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

    if (this.inventoryTableBody) {
      this.inventoryTableBody.addEventListener('click', (e) => {
          this.handleTableActions(e);
      });
      this.inventoryTableBody.addEventListener('change', (e) => {
        this.handleVariantMatrixActions(e);
      });
    }

    if (this.userManagementTableBody) {
      this.userManagementTableBody.addEventListener('click', (e) => this.handleUserActions(e));
    }
    
    if (this.addColorForm) {
      this.addColorForm.addEventListener('submit', (e) => this.handleMasterAdd(e, 'color'));
    }

    if (this.addSizeForm) {
      this.addSizeForm.addEventListener('submit', (e) => this.handleMasterAdd(e, 'size'));
    }

    if (this.masterColorList) {
      this.masterColorList.addEventListener('click', (e) => this.handleMasterActions(e, 'color'));
    }

    if (this.masterSizeList) {
      this.masterSizeList.addEventListener('click', (e) => this.handleMasterActions(e, 'size'));
    }

    if (this.addSupplierBtn) {
      this.addSupplierBtn.addEventListener('click', () => this.openSupplierModal());
    }

    if (this.supplierForm) {
      this.supplierForm.addEventListener('submit', (e) => this.handleSupplierFormSubmit(e));
    }

    if (this.addContactBtn) {
      this.addContactBtn.addEventListener('click', () => this.addContactField());
    }

    if (this.suppliersTableBody) {
      this.suppliersTableBody.addEventListener('click', (e) => this.handleSupplierActions(e));
    }

    if (this.addPoBtn) {
      this.addPoBtn.addEventListener('click', () => this.openPurchaseOrderModal());
    }

    if (this.poForm) {
      this.poForm.addEventListener('submit', (e) => this.handlePurchaseOrderFormSubmit(e));
    }

    // The "Add Item" button is being replaced by a searchable dropdown
    // if (this.addPoItemBtn) {
    //   this.addPoItemBtn.addEventListener('click', () => this.openVariantSearchModal());
    // }

    if (this.poTableBody) {
      this.poTableBody.addEventListener('click', (e) => this.handlePurchaseOrderActions(e));
    }

    if (this.receiveStockBtn) {
      this.receiveStockBtn.addEventListener('click', () => this.openReceiveStockModal());
    }

    if (this.generatePoBtn) {
      this.generatePoBtn.addEventListener('click', () => this.openPurchaseOrderModal());
    }

    if (this.variantSearchInput) {
        this.variantSearchInput.addEventListener('input', () => this.renderVariantSearchResults());
    }

    if (this.addSelectedVariantsBtn) {
        this.addSelectedVariantsBtn.addEventListener('click', () => this.addSelectedVariantsToPO());
    }

    if (this.selectAllVariantsCheckbox) {
        this.selectAllVariantsCheckbox.addEventListener('change', (e) => {
            const checkboxes = this.variantSearchResults.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
            this.updateSelectAllCheckboxState();
        });
    }

    if (this.variantSearchResults) {
        this.variantSearchResults.addEventListener('change', (e) => {
            if (e.target.matches('input[type="checkbox"]')) {
                this.updateSelectAllCheckboxState();
            }
        });
    }

    if (this.receiveStockForm) {
      this.receiveStockForm.addEventListener('submit', (e) => this.handleReceiveStockFormSubmit(e));
    }

    document.body.addEventListener('click', (e) => {
        // Generic modal close button handler
        if (e.target.matches('.close-modal-btn')) {
            const modal = e.target.closest('.modal');
            if (modal) {
                modal.classList.remove('is-open');
            }
        }
        if (e.target.closest('.edit-model-btn')) {
            this.handleDropdownActions(e, 'model', 'edit');
        } else if (e.target.closest('.delete-model-btn')) {
            this.handleDropdownActions(e, 'model', 'delete');
        } else if (e.target.closest('.edit-variation-btn')) {
            this.handleDropdownActions(e, 'variation', 'edit');
        } else if (e.target.closest('.delete-variation-btn')) {
            this.handleDropdownActions(e, 'variation', 'delete');
        }
    });

    const itemNameInput = document.getElementById('item-name');
    const itemModelSelect = document.getElementById('item-model');

    if (itemNameInput) {
      // Use 'input' for immediate feedback, 'change' for when focus is lost.
      // 'change' is generally safer for performance if the user types quickly.
      itemNameInput.addEventListener('change', async (e) => {
        const selectedItem = e.target.value;
        
        // Fetch and populate the main item details if it's an existing item
        const itemData = await this.fetchJson(`${this.apiBase}/items/by-name?name=${encodeURIComponent(selectedItem)}`);
        
        if (itemData) {
            // This is an existing item, let's populate the fields
            await this.fetchModels(selectedItem);
            const modelSelect = $('#item-model');
            if (itemData.model && modelSelect.find(`option[value="${itemData.model}"]`).length === 0) {
                const newOption = new Option(itemData.model, itemData.model, true, true);
                modelSelect.append(newOption).trigger('change');
            }
            modelSelect.val(itemData.model || '').trigger('change');

            await this.fetchVariations(selectedItem, itemData.model);
            const variationSelect = $('#item-variation');
            if (itemData.variation && variationSelect.find(`option[value="${itemData.variation}"]`).length === 0) {
                const newOption = new Option(itemData.variation, itemData.variation, true, true);
                variationSelect.append(newOption).trigger('change');
            }
            variationSelect.val(itemData.variation || '').trigger('change');

            document.getElementById('item-description').value = itemData.description || '';
        } else {
            // This is a new item, just fetch models and clear variation
            this.fetchModels(selectedItem);
            this.populateSelect(document.getElementById('item-variation'), []);
        }
      });
    }


    $(document).on('dblclick', '.select2-results__option[role="option"]', (e) => {
        e.stopPropagation();
        const target = $(e.currentTarget);
        const text = target.text();
        
        const resultsId = target.closest('ul').attr('id');
        if (!resultsId) return;

        const originalSelectId = resultsId.replace('select2-', '').replace('-results', '');
        const selectElement = $('#' + originalSelectId);
        const type = originalSelectId.includes('model') ? 'model' : 'variation';

        const optionElement = selectElement.find('option').filter(function() {
            return $(this).text() === text;
        });
        
        let id = optionElement.data('id');
        if (!id) {
            const masterList = type === 'model' ? this.models : this.variations;
            const foundItem = masterList ? masterList.find(item => item.name === text) : undefined;
            if (foundItem) {
                id = foundItem.id;
            }
        }

        if (!id) {
            this.showNotification(`Could not find ID for ${type} "${text}". It might be a new entry.`, 'info');
            return;
        }

        const newText = prompt(`Edit ${type}:`, text);
        if (newText && newText !== text) {
            this.handleMasterUpdate(type, id, newText, (success) => {
                const form = selectElement.closest('form');
                const itemNameInput = form.find('input[id^="item-name"], input[id^="edit-item-name-"]');
                const modelSelect = form.find('select[id^="item-model"], select[id^="edit-item-model-"]');

                const refresh = async () => {
                    const itemName = itemNameInput.val();
                    const modelName = modelSelect.val();
                    const valueToSelect = success ? newText : text;

                    if (type === 'model') {
                        const models = await this.fetchJson(`${this.apiBase}/models-by-item?item_name=${encodeURIComponent(itemName)}`);
                        if (models) {
                            this.models = models;
                            this.populateSelect(selectElement[0], models, valueToSelect);
                        }
                    } else if (type === 'variation') {
                        const variations = await this.fetchJson(`${this.apiBase}/variations-by-item-model?item_name=${encodeURIComponent(itemName)}&model=${encodeURIComponent(modelName)}`);
                        if (variations) {
                            this.variations = variations;
                            this.populateSelect(selectElement[0], variations, valueToSelect);
                        }
                    }
                };
                refresh();
                selectElement.select2('close');
            });
        }
    });
  },

  initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    }
    const sidebarCollapsed = localStorage.getItem('sidebarCollapsed');
    if (sidebarCollapsed === 'true') {
      document.body.classList.add('sidebar-collapsed');
    }
  },

  setupSearchFunctionality() {
    if (this.searchInput && this.clearSearchBtn) {
      const toggleClearButton = () => {
        this.clearSearchBtn.style.display = this.searchInput.value.trim() ? 'block' : 'none';
      };
      this.searchInput.addEventListener('input', toggleClearButton);
      toggleClearButton();
    }
  },

  setActiveNavItem() {
    const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
    const navLinks = document.querySelectorAll('.sidebar-nav .nav-item');
    navLinks.forEach(link => {
      const href = (link.getAttribute('href') || '').replace(/\/$/, '') || '/';
      const isMatch = href === currentPath || (currentPath === '/' && href === '/inventory');
      link.classList.toggle('active', isMatch);
    });
  },

  async fetchInitialData() {
    if (this.inventoryTableBody) {
      await Promise.all([
        this.fetchItems(),
        this.fetchMasterData('colors'),
        this.fetchMasterData('sizes'),
        this.fetchItemNames()
      ]).catch(() => {});
      this.populateDatalists();
    }
    if (this.userManagementTableBody) {
      this.fetchUsers();
    }
    if (this.suppliersTableBody) {
      this.fetchSuppliers();
    }
    if (this.poTableBody) {
      this.fetchPurchaseOrders();
    }
  },

async fetchJson(url, options = {}) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    const defaultHeaders = {
        'Accept': 'application/json',
        'X-CSRFToken': csrfToken  // ✅ Always include CSRF token
    };
    
    // Handle Content-Type for JSON bodies
    if (options.body && typeof options.body === 'string') {
        try {
            JSON.parse(options.body);
            defaultHeaders['Content-Type'] = 'application/json';
        } catch (e) {
            // Not JSON, let browser set Content-Type
        }
    } else if (options.body && !(options.body instanceof FormData)) {
        defaultHeaders['Content-Type'] = 'application/json';
    }
    
    const config = {
        ...options,
        headers: {
            ...defaultHeaders,
            ...options.headers,
        },
    };
    
    try {
        const res = await fetch(url, config);
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ message: res.statusText }));
            if (res.status === 409 && errorData.conflict) {
                return errorData; // Return conflict data instead of throwing
            }
            throw new Error(errorData.error || errorData.message);
        }
        return res.status === 204 ? { success: true } : await res.json();
    } catch (err) {
        console.error(`Fetch error for ${url}:`, err);
        if (typeof this.showNotification === 'function') {
            this.showNotification(err.message, 'error');
        }
        return { error: err.message, success: false };  // ✅ Consistent error structure
    }
},

  showNotification(message, type = 'success') {
    const container = document.querySelector('.container') || document.body;
    const notification = document.createElement('div');
    notification.className = `flash ${type}`;
    notification.textContent = message;
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:inherit;font-size:1.2em;cursor:pointer;margin-left:auto;padding:0 0.5rem;';
    closeBtn.addEventListener('click', () => notification.remove());
    notification.style.display = 'flex';
    notification.style.alignItems = 'center';
    notification.appendChild(closeBtn);
    container.prepend(notification);
    setTimeout(() => {
      if (notification.parentNode) {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 500);
      }
    }, 2500);
  },

  toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
  },

  handleSearch(searchTerm) {
    if (!this.allItems) return;
    const filteredItems = searchTerm.trim() === '' ? this.allItems : 
      this.allItems.filter(item => 
        [item.name, item.model, item.variation].join(' ').toLowerCase().includes(searchTerm.toLowerCase())
      );
    this.renderItemsList(filteredItems);
    const resultCount = document.getElementById('search-result-count');
    if (resultCount) {
      resultCount.textContent = searchTerm.trim() === '' ? `Showing all ${this.allItems.length} items` : `Showing ${filteredItems.length} of ${this.allItems.length} items`;
    }
  },

  async fetchUsers() {
    const users = await this.fetchJson(`${this.apiBase}/users`);
    if (users) this.renderUsersList(users);
  },

  renderUsersList(users) {
    if (!this.userManagementTableBody) return;
    if (users.length === 0) {
      this.userManagementTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 2rem;">No other users found.</td></tr>`;
      return;
    }
    const roles = ['user', 'admin', 'pending_approval'];
    this.userManagementTableBody.innerHTML = users.map(user => `
      <tr data-user-id="${user.user_id}">
        <td data-label="Name">${this.escapeHtml(user.name)}</td>
        <td data-label="Email">${this.escapeHtml(user.email)}</td>
        <td data-label="Role" class="current-role">${user.role.replace('_', ' ')}</td>
        <td data-label="Actions" class="actions-cell">
          <select class="role-select">${roles.map(r => `<option value="${r}" ${user.role === r ? 'selected' : ''}>${r.replace('_', ' ')}</option>`).join('')}</select>
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
    button.disabled = true;
    button.textContent = 'Updating...';
    const result = await this.fetchJson(`${this.apiBase}/users/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role: newRole })
    });
    if (result) {
      this.showNotification(`User role updated to ${newRole.replace('_', ' ')}.`, 'success');
      row.querySelector('.current-role').textContent = newRole.replace('_', ' ');
    }
    button.disabled = false;
    button.textContent = 'Update';
  },

  async fetchItems() {
    const lowStockOnly = this.lowStockFilter ? this.lowStockFilter.checked : false;
    const url = new URL(`${this.apiBase}/items`);
    if (lowStockOnly) {
      url.searchParams.append('low_stock', 'true');
    }

    const items = await this.fetchJson(url.toString());
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
      const message = this.allItems.length > 0 ? 'No items match your search.' : 'No items found. Click "Add New Item" to get started!';
      this.inventoryTableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 2rem;">${message}</td></tr>`;
      return;
    }
    this.inventoryTableBody.innerHTML = items.map(item => {
      const statusClass = item.has_low_stock_variants ? 'low-stock' : 'in-stock';
      const statusText = item.has_low_stock_variants ? 'Low Stock' : 'In Stock';
      return `
        <tr class="item-row" data-item-id="${item.id}" data-item-name="${this.escapeHtml(item.name)}" data-item-description="${this.escapeHtml(item.description || '')}">
          <td data-label=""><button class="expand-btn" title="View Variants" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"></polyline></svg></button></td>
          <td data-label="Image"><img src="/static/${item.image_path || 'uploads/placeholder.png'}" alt="${this.escapeHtml(item.name)}" class="item-image-thumbnail"></td>
          <td data-label="Item Name" class="item-name-cell">
            <span title="${this.escapeHtml(item.description || 'No description provided.')}">${this.escapeHtml(item.name)}</span>
          </td>
          <td data-label="Model">${this.escapeHtml(item.model || '--')}</td>
          <td data-label="Variation">${this.escapeHtml(item.variation || '--')}</td>
          <td data-label="Variants">${item.variant_count}</td>
          <td data-label="Total Stock" class="total-stock-cell">${item.total_stock}</td>
          <td data-label="Status" class="status-col"><span class="status-badge ${statusClass}">${statusText}</span></td>
          <td data-label="Actions" class="actions-cell">
            <button class="button create edit-item" title="Edit Item">Edit</button>
            <button class="button cancel delete-item" title="Delete Item">Delete</button>
          </td>
        </tr>
        <tr class="variant-details-row" style="display: none;"><td colspan="9" class="variant-details-container"></td></tr>
      `;
    }).join('');
  },

  async handleTableActions(e) {
    const button = e.target.closest('button');
    if (!button) return;
    const row = button.closest('.item-row');
    if (!row) return;
    const itemId = row.dataset.itemId;
    const itemName = row.dataset.itemName;
    if (button.classList.contains('expand-btn')) {
      await this.toggleVariantDetails(row, button, itemId);
    } else if (button.classList.contains('edit-item')) {
      this.toggleEditForm(row, itemId);
    } else if (button.classList.contains('delete-item')) {
      this.deleteItem(itemId, itemName);
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
      container.innerHTML = `<div style="padding: auto; text-align: center;">Loading...</div>`;
      detailsRow.style.display = 'table-row';
      expandBtn.classList.add('expanded');
      expandBtn.setAttribute('aria-expanded', 'true');
      const variants = await this.fetchJson(`${this.apiBase}/items/${itemId}/variants`);
      container.innerHTML = '';
      if (itemRow.dataset.itemDescription) {
        container.innerHTML += `<div class="item-description-detail"><strong>Description:</strong> ${this.escapeHtml(itemRow.dataset.itemDescription)}</div>`;
      }
      if (variants && variants.length > 0) {
        this.renderVariantMatrix(container, variants);
      } else {
        container.innerHTML += `<p style="padding: 1rem; text-align: center;">No variants found.</p>`;
      }
    }
  },

  // Call this in your constructor or init() after the DOM is ready.
  initImportModal() {
    this.importModal = document.getElementById('import-modal');
    this.importDataBtn = document.getElementById('import-data-btn');

    // Step and button elements
    this.step1 = document.getElementById('import-step-1');
    this.step2 = document.getElementById('import-step-2');
    this.nextBtn = document.getElementById('import-next-btn');
    this.backBtn = document.getElementById('import-back-btn');
    this.commitBtn = document.getElementById('import-commit-btn');
    this.previewContainer = document.getElementById('import-preview-container');
    this.fileInput = document.getElementById('import-file');

    if (this.importDataBtn) {
      this.importDataBtn.addEventListener('click', () => this.openImportModal());
    }

    if (this.lowStockReportBtn) {
      this.lowStockReportBtn.addEventListener('click', () => this.showLowStockReport());
    }

    if (this.lowStockReportModal) {
      this.lowStockReportModal.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-modal-btn') || e.target.classList.contains('modal')) {
          this.closeLowStockReport();
        }
      });
    }

    if (this.printLowStockReportBtn) {
      this.printLowStockReportBtn.addEventListener('click', () => this.printLowStockReport());
    }

    if (this.importModal) {
      // Prefer targeting a known button container to avoid false positives.
      // const btnContainer = this.importModal.querySelector('.modal-actions') || this.importModal;
      const btnContainer = this.importModal;
      btnContainer.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;

        if (target.classList && target.classList.contains('close-modal-btn')) {
          this.closeImportModal();
          return;
        }
        const id = target.id;
        if (id === 'import-next-btn') {
          this.handleImportNext();
        } else if (id === 'import-back-btn') {
          this.handleImportBack();
        } else if (id === 'import-commit-btn') {
          this.handleImportCommit();
        }
      });
    }
  },

/**
 * ✅ BUG FIX: Open import modal with proper state management
 */
openImportModal() {
    if (!this.importModal) {
        console.error('❌ Import modal element not found');
        return;
    }
    
    // Reset modal state
    this.importModal.classList.add('is-open');
    
    // Reset to step 1
    if (this.step1) this.step1.style.display = 'block';
    if (this.step2) this.step2.style.display = 'none';
    if (this.nextBtn) this.nextBtn.style.display = 'block';
    if (this.backBtn) this.backBtn.style.display = 'none';
    if (this.commitBtn) this.commitBtn.style.display = 'none';
    
    // Clear file input
    if (this.fileInput) this.fileInput.value = '';
    if (this.previewContainer) this.previewContainer.innerHTML = '';
    
    console.log('✅ Import modal opened');
},

/**
 * ✅ BUG FIX: Close import modal and clean up
 */
closeImportModal() {
    if (this.importModal) {
        this.closeModal(this.importModal);
    }
},

  async handleImportNext() {
    try {
      if (!this.fileInput) {
        this.showNotification?.('File input not found.', 'error');
        return;
      }
      const file = this.fileInput.files?.[0];
      if (!file) {
        this.showNotification?.('Please select a file to import.', 'error');
        return;
      }

      // Client-side parsing with SheetJS
      const reader = new FileReader();
      reader.onload = async (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet);

        const response = await this.fetchJson('/api/import/preview-json', {
          method: 'POST',
          body: JSON.stringify(json),
        });

        if (!response || !Array.isArray(response.headers) || !Array.isArray(response.rows)) {
          this.showNotification?.('Invalid preview response from server.', 'error');
          return;
        }

        this.renderImportPreview(response);

        if (this.step1) this.step1.style.display = 'none';
        if (this.step2) this.step2.style.display = 'block';
        if (this.nextBtn) this.nextBtn.style.display = 'none';
        if (this.backBtn) this.backBtn.style.display = 'block';
        if (this.commitBtn) this.commitBtn.style.display = 'block';
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error(err);
      this.showNotification?.('Failed to load import preview.', 'error');
    }
  },

  handleImportBack() {
    if (this.step1) this.step1.style.display = 'block';
    if (this.step2) this.step2.style.display = 'none';
    if (this.nextBtn) this.nextBtn.style.display = 'block';
    if (this.backBtn) this.backBtn.style.display = 'none';
    if (this.commitBtn) this.commitBtn.style.display = 'none';
  },

  async showLowStockReport() {
    const reportData = await this.fetchJson(`${this.apiBase}/low-stock-report`);
    if (reportData) {
      this.renderLowStockReport(reportData);
      this.lowStockReportModal.classList.add('is-open');
    }
  },

  closeLowStockReport() {
    if (this.lowStockReportModal) {
      this.lowStockReportModal.classList.remove('is-open');
    }
  },

  renderLowStockReport(data) {
    if (!this.lowStockReportBody) return;
    if (data.length === 0) {
      this.lowStockReportBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem;">No low stock items found.</td></tr>`;
      return;
    }
    this.lowStockReportBody.innerHTML = data.map(item => `
      <tr>
        <td>${this.escapeHtml(item.item_name)}</td>
        <td>${this.escapeHtml(item.model_name || '--')}</td>
        <td>${this.escapeHtml(item.variation_name || '--')}</td>
        <td>${this.escapeHtml(item.color_name)}</td>
        <td>${this.escapeHtml(item.size_name)}</td>
        <td>${item.opening_stock}</td>
        <td>${item.threshold}</td>
      </tr>
    `).join('');
  },

  printLowStockReport() {
    const reportTitle = "Low Stock Report";
    const printContents = document.getElementById('low-stock-report-printable').innerHTML;
    
    const printWindow = window.open('', '', 'height=600,width=800');
    printWindow.document.write('<html><head><title>' + reportTitle + '</title>');
    printWindow.document.write(`
        <style>
            body { font-family: 'Inter', sans-serif; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
        </style>
    `);
    printWindow.document.write('</head><body>');
    printWindow.document.write('<h1>' + reportTitle + '</h1>');
    printWindow.document.write(printContents);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
  },

  showLoading(message = 'Processing...') {
    document.getElementById('loading-message').textContent = message;
    document.getElementById('global-loading').style.display = 'flex';
  },

  hideLoading() {
    document.getElementById('global-loading').style.display = 'none';
  },

  async handleImportCommit() {
    this.showLoading('Importing data...');
    try {
        const mappingSelects = this.previewContainer ? this.previewContainer.querySelectorAll('thead th select') : [];
        const mappings = {};
        const headerMapping = Array.from(mappingSelects).map(select => {
            const originalHeader = select.dataset.originalHeader || '';
            const chosenDbColumn = select.value || '';
            if (originalHeader) {
                mappings[originalHeader] = chosenDbColumn;
            }
            return { original: originalHeader, chosen: chosenDbColumn };
        });

        const data = [];
        const rows = this.previewContainer ? this.previewContainer.querySelectorAll('tbody tr') : [];
        rows.forEach(row => {
            // Skip rows marked with an error
            if (row.classList.contains('row-error')) return;
            
            const rowData = {};
            const cells = row.querySelectorAll('td[data-header]');
            cells.forEach(cell => {
                const headerName = cell.dataset.header;
                if (headerName) {
                    rowData[headerName] = cell.textContent ?? '';
                }
            });
            data.push(rowData);
        });

        if (data.length === 0) {
            this.showNotification?.('No valid data to commit.', 'warning');
            return;
        }

        // We now send the corrected table data instead of the original file
        const response = await this.fetchJson('/api/import/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mappings, data }),
        });

        if (response?.message) {
            this.showNotification?.(response.message, 'success');
        } else {
            this.showNotification?.('Import committed successfully.', 'success');
        }

        this.closeImportModal();
        this.fetchItems?.(); // Refresh the inventory list
    } catch (err) {
        console.error(err);
        this.showNotification?.(err.message || 'Failed to commit import.', 'error');
    } finally {
        this.hideLoading();
    }
  },

  renderImportPreview({ headers, rows }) {
    if (!this.previewContainer) return;

    const dbColumns = ['Item', 'Model', 'Variation', 'Description', 'Color', 'Size', 'Stock', 'Unit'];
    this.previewContainer.innerHTML = '';
    
    const controlsContainer = document.getElementById('import-controls-container');
    if (controlsContainer) {
        controlsContainer.innerHTML = `
            <div class="form-field" style="margin-bottom: 1rem; max-width: 200px;">
                <label for="import-status-filter">Filter by status</label>
                <select id="import-status-filter">
                    <option value="all">Show All</option>
                    <option value="errors">Show Errors Only</option>
                </select>
            </div>
        `;
        document.getElementById('import-status-filter').addEventListener('change', (e) => {
            const value = e.target.value;
            const tableRows = this.previewContainer.querySelectorAll('tbody tr');
            tableRows.forEach(row => {
                const hasError = row.classList.contains('row-error');
                if (value === 'all' || (value === 'errors' && hasError)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    const table = document.createElement('table');
    table.className = 'inventory-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    
    // Add a new header for the error status
    const statusTh = document.createElement('th');
    statusTh.textContent = 'Status';
    headerRow.appendChild(statusTh);

    headers.forEach(header => {
        const th = document.createElement('th');
        const select = document.createElement('select');
        select.dataset.originalHeader = header;
        
        const ignoreOption = document.createElement('option');
        ignoreOption.value = 'Ignore';
        ignoreOption.textContent = '— Ignore —';
        select.appendChild(ignoreOption);

        dbColumns.forEach(col => {
            const option = document.createElement('option');
            option.value = col;
            option.textContent = col;
            if (col.toLowerCase() === String(header).toLowerCase()) {
                option.selected = true;
            }
            select.appendChild(option);
        });
        th.appendChild(select);
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let errorCount = 0;
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.dataset.rowId = row._id;

        const statusTd = document.createElement('td');
        if (row._errors.length > 0) {
            tr.classList.add('row-error');
            statusTd.innerHTML = `<span class="status-badge low-stock" title="${this.escapeHtml(row._errors.join('\n'))}">Error</span>`;
            errorCount++;
        } else {
            statusTd.innerHTML = `<span class="status-badge in-stock">OK</span>`;
        }
        tr.appendChild(statusTd);

        headers.forEach(header => {
            const td = document.createElement('td');
            td.textContent = row[header] != null ? String(row[header]) : '';
            td.contentEditable = true;
            td.dataset.header = header; // Store original header for commit
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.previewContainer.appendChild(table);
    
    this.updateCommitButtonState(errorCount);
  },

  updateCommitButtonState(errorCount) {
    const commitBtn = document.getElementById('import-commit-btn');
    if (commitBtn) {
        commitBtn.disabled = errorCount > 0;
        if (errorCount > 0) {
            commitBtn.title = `${errorCount} error(s) must be fixed before importing.`;
        } else {
            commitBtn.title = 'Commit the import';
        }
    }
  },

  renderVariantMatrix(container, variants) {
    const allSizes = [...new Set(variants.map(v => v.size.name))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const variantsByColor = variants.reduce((acc, v) => {
      if (!acc[v.color.name]) acc[v.color.name] = {};
      acc[v.color.name][v.size.name] = { stock: v.opening_stock, threshold: v.threshold, variantId: v.id, unit: v.unit };
      return acc;
    }, {});
    const sizeHeaders = allSizes.map(size => `<th class="size-header">${this.escapeHtml(size)}</th>`).join('');
    const colorRows = Object.entries(variantsByColor).map(([colorName, sizeData]) => {
      const stockCells = allSizes.map(size => {
        const variantInfo = sizeData[size];
        if (variantInfo) {
          const isLowStock = variantInfo.stock <= variantInfo.threshold;
          const statusClass = isLowStock ? 'low-stock' : 'in-stock';
          return `<td class="variant-cell"><div class="variant-cell-compact" data-threshold="Threshold: ${variantInfo.threshold} ${variantInfo.unit || ''}">
            <input type="number" class="stock-input compact" value="${variantInfo.stock}" data-variant-id="${variantInfo.variantId}" min="0" title="Stock">
            <span class="status-badge variant-status ${statusClass}">${isLowStock ? 'LOW' : 'OK'}</span>
          </div></td>`;
        }
        return `<td class="empty-cell">—</td>`;
      }).join('');
      return `<tr><td class="color-cell">${this.escapeHtml(colorName)}</td>${stockCells}</tr>`;
    }).join('');
    container.innerHTML += `<div class="variants-matrix-container"><table class="variants-matrix-table">
      <thead><tr><th class="color-header">Color</th>${sizeHeaders}</tr></thead>
      <tbody>${colorRows}</tbody>
    </table></div>`;
  },

  async handleVariantMatrixActions(e) {
    const input = e.target.closest('.stock-input.compact');
    if (!input) return;

    const variantId = input.dataset.variantId;
    let newStock = input.value.trim();

    if (newStock === '') {
        newStock = 0;
        input.value = 0;
    } else {
        newStock = parseInt(newStock, 10);
    }

    if (isNaN(newStock) || !variantId) {
        console.error('Invalid stock value or variant ID');
        return;
    }

    const originalValue = input.defaultValue;
    input.disabled = true;

    try {
        const result = await this.fetchJson(`${this.apiBase}/variants/${variantId}/stock`, {
            method: 'PUT',
            body: JSON.stringify({ stock: newStock }),
        });

        if (result && result.message) {
            this.showNotification(result.message, 'success');
            const itemRow = input.closest('.variant-details-row').previousElementSibling;
            if (itemRow) {
                // Update total stock directly from the response
                const totalStockCell = itemRow.querySelector('.total-stock-cell');
                if (totalStockCell) totalStockCell.textContent = result.new_total_stock;

                // Update status badge directly from the response
                const statusBadge = itemRow.querySelector('.status-badge');
                if (statusBadge) {
                    statusBadge.textContent = result.item_has_low_stock ? 'Low Stock' : 'In Stock';
                    statusBadge.className = `status-badge ${result.item_has_low_stock ? 'low-stock' : 'in-stock'}`;
                }
            }
            // Also update the individual variant's status badge
            const variantCell = input.closest('.variant-cell-compact');
            if (variantCell && result.updated_variant) {
                const variantStatusBadge = variantCell.querySelector('.variant-status');
                variantStatusBadge.textContent = result.updated_variant.is_low_stock ? 'LOW' : 'OK';
                variantStatusBadge.className = `status-badge variant-status ${result.updated_variant.is_low_stock ? 'low-stock' : 'in-stock'}`;
            }
            input.defaultValue = newStock;
        } else {
            this.showNotification(result?.error || 'Failed to update stock.', 'error');
            input.value = originalValue;
        }
    } catch (error) {
        this.showNotification('An error occurred while updating stock.', 'error');
        input.value = originalValue;
    } finally {
        input.disabled = false;
    }
  },

  async toggleEditForm(itemRow, itemId) {
    const existingEditRow = itemRow.nextElementSibling;
    if (existingEditRow && existingEditRow.classList.contains('edit-form-row')) {
        existingEditRow.remove();
        itemRow.style.display = '';
        return;
    }

    const item = await this.fetchJson(`${this.apiBase}/items/${itemId}`);
    const variants = await this.fetchJson(`${this.apiBase}/items/${itemId}/variants`);
    if (!item || !variants) {
        this.showNotification('Failed to fetch item details.', 'error');
        return;
    }

    const editFormHTML = this.createEditFormHTML(item, variants);
    itemRow.insertAdjacentHTML('afterend', editFormHTML);
    itemRow.style.display = 'none';

    const editRow = itemRow.nextElementSibling;
    const form = editRow.querySelector('.edit-item-form');

    const modelSelect = editRow.querySelector(`#edit-item-model-${item.id}`);
    const variationSelect = editRow.querySelector(`#edit-item-variation-${item.id}`);

    // Fetch and populate models
    const models = await this.fetchJson(`${this.apiBase}/models-by-item?item_name=${encodeURIComponent(item.name)}`);
    if (models) {
      this.models = models; // Store models
      this.populateSelect(modelSelect, models, item.model);
    }

    // Fetch and populate variations
    const variations = await this.fetchJson(`${this.apiBase}/variations-by-item-model?item_name=${encodeURIComponent(item.name)}&model=${encodeURIComponent(item.model)}`);
    if (variations) {
      this.variations = variations; // Store variations
      this.populateSelect(variationSelect, variations, item.variation);
    }

    // Add event listener to update variations when model changes
    $(modelSelect).on('change', async () => {
        const newModel = $(modelSelect).val();
        const newVariations = await this.fetchJson(`${this.apiBase}/variations-by-item-model?item_name=${encodeURIComponent(item.name)}&model=${encodeURIComponent(newModel)}`);
        if (newVariations) {
          this.variations = newVariations; // Update stored variations
          this.populateSelect(variationSelect, newVariations);
        }
    });

    // Initialize Select2 for the new dropdowns
    $(modelSelect).select2({ tags: true, width: '100%' });
    $(variationSelect).select2({ tags: true, width: '100%' });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleUpdateItem(itemId, form, itemRow);
    });

    const cancelButton = editRow.querySelector('.cancel-edit-btn');
    cancelButton.addEventListener('click', () => {
        editRow.remove();
        itemRow.style.display = '';
    });

    const variantsTable = editRow.querySelector('.variants-modal-table tbody');
    variantsTable.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.remove-variant-btn');
        if (deleteBtn) {
            const row = deleteBtn.closest('tr');
            row.remove();
        }
    });

    const addVariantBtn = editRow.querySelector('.add-variant-edit-btn');
    addVariantBtn.addEventListener('click', () => {
        const newRow = variantsTable.insertRow();
        newRow.className = 'variant-edit-row';
        newRow.innerHTML = `
            <td><input type="text" class="variant-color" list="color-datalist" required></td>
            <td><input type="text" class="variant-size" list="size-datalist" required></td>
            <td><input type="number" class="stock-input" value="0" min="0" required></td>
            <td><input type="text" class="variant-unit" value="Pcs" list="unit-datalist"></td>
            <td><input type="number" class="threshold-input" value="5" min="0" required></td>
            <td><button type="button" class="button cancel remove-variant-btn" title="Remove variant">&times;</button></td>
        `;
    });
  },

  createEditFormHTML(item, variants) {
    const variantRows = variants.map(v => `
        <tr class="variant-edit-row" data-variant-id="${v.id || ''}">
            <td><input type="text" class="variant-color" value="${this.escapeHtml(v.color.name)}" list="color-datalist" required></td>
            <td><input type="text" class="variant-size" value="${this.escapeHtml(v.size.name)}" list="size-datalist" required></td>
            <td><input type="number" class="stock-input" value="${v.opening_stock}" min="0" required></td>
            <td><input type="text" class="variant-unit" value="${this.escapeHtml(v.unit || 'Pcs')}" list="unit-datalist"></td>
            <td><input type="number" class="threshold-input" value="${v.threshold}" min="0" required></td>
            <td><button type="button" class="button cancel remove-variant-btn" title="Remove variant">&times;</button></td>
        </tr>
    `).join('');

    return `
        <tr class="edit-form-row">
            <td colspan="9">
                <form class="edit-item-form" data-initial-variants='${JSON.stringify(variants)}'>
                    <h4>Edit ${this.escapeHtml(item.name)}</h4>
                    <div class="form-row">
                        <div class="form-field">
                            <label for="edit-item-name-${item.id}">Item Name</label>
                            <input type="text" id="edit-item-name-${item.id}" value="${this.escapeHtml(item.name)}" required>
                        </div>
                        <div class="form-field">
                            <label for="edit-item-model-${item.id}">Model</label>
                            <div class="input-with-buttons">
                                <select id="edit-item-model-${item.id}" class="editable-select"></select>
                                <button type="button" class="button-icon edit-model-btn" aria-label="Edit model">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
                                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                    </svg>
                                </button>
                                <button type="button" class="button-icon delete-model-btn" aria-label="Delete model">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
                                        <line x1="10" y1="11" x2="10" y2="17"></line>
                                        <line x1="14" y1="11" x2="14" y2="17"></line>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="form-field">
                            <label for="edit-item-variation-${item.id}">Variation</label>
                            <div class="input-with-buttons">
                                <select id="edit-item-variation-${item.id}" class="editable-select"></select>
                                <button type="button" class="button-icon edit-variation-btn" aria-label="Edit variation">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
                                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                    </svg>
                                </button>
                                <button type="button" class="button-icon delete-variation-btn" aria-label="Delete variation">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
                                        <line x1="10" y1="11" x2="10" y2="17"></line>
                                        <line x1="14" y1="11" x2="14" y2="17"></line>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="form-field">
                        <label for="edit-item-description-${item.id}">Description</label>
                        <textarea id="edit-item-description-${item.id}">${this.escapeHtml(item.description || '')}</textarea>
                    </div>
                    <h5>Variants</h5>
                    <table class="variants-modal-table">
                        <thead>
                            <tr>
                                <th>Color</th>
                                <th>Size</th>
                                <th>Stock</th>
                                <th>Unit</th>
                                <th>Threshold</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>${variantRows}</tbody>
                    </table>
                    <button type="button" class="button create add-variant-edit-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        Add Variant
                    </button>
                    <div class="form-actions">
                        <button type="submit" class="button create">Save Changes</button>
                        <button type="button" class="button cancel-edit-btn">Cancel</button>
                    </div>
                </form>
            </td>
        </tr>
    `;
  },

  async handleUpdateItem(itemId, form, itemRow) {
    const saveBtn = form.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const initialVariants = JSON.parse(form.dataset.initialVariants || '[]');
    
    const formData = new FormData();
    formData.append('name', form.querySelector(`#edit-item-name-${itemId}`).value);
    formData.append('model', form.querySelector(`#edit-item-model-${itemId}`).value);
    formData.append('variation', form.querySelector(`#edit-item-variation-${itemId}`).value);
    formData.append('description', form.querySelector(`#edit-item-description-${itemId}`).value);

    const variantRows = form.querySelectorAll('.variant-edit-row');
    const currentVariants = Array.from(variantRows).map(row => ({
        id: row.dataset.variantId || null,
        color: row.querySelector('.variant-color').value,
        size: row.querySelector('.variant-size').value,
        opening_stock: parseInt(row.querySelector('.stock-input').value, 10),
        unit: row.querySelector('.variant-unit').value,
        threshold: parseInt(row.querySelector('.threshold-input').value, 10),
    }));

    const changedVariants = {
        added: [],
        updated: [],
        deleted: []
    };

    const initialVariantMap = new Map(initialVariants.map(v => [v.id.toString(), v]));

    for (const currentVariant of currentVariants) {
        if (!currentVariant.id) {
            changedVariants.added.push(currentVariant);
        } else {
            const initialVariant = initialVariantMap.get(currentVariant.id.toString());
            if (initialVariant) {
                if (
                    initialVariant.color.name !== currentVariant.color ||
                    initialVariant.size.name !== currentVariant.size ||
                    initialVariant.opening_stock !== currentVariant.opening_stock ||
                    initialVariant.unit !== currentVariant.unit ||
                    initialVariant.threshold !== currentVariant.threshold
                ) {
                    changedVariants.updated.push(currentVariant);
                }
                initialVariantMap.delete(currentVariant.id.toString());
            } else {
                // This case can happen if a variant was added and then modified
                // without an intermediate save. Treat it as an added variant.
                changedVariants.added.push(currentVariant);
            }
        }
    }

    changedVariants.deleted = Array.from(initialVariantMap.keys()).map(id => parseInt(id, 10));

    formData.append('variants', JSON.stringify(changedVariants));

    try {
        const result = await this.fetchJson(`${this.apiBase}/items/${itemId}`, {
            method: 'PUT',
            body: formData,
        });

        if (result && result.item) {
            this.showNotification('Item updated successfully.', 'success');
            form.closest('.edit-form-row').remove();
            this.updateItemRow(itemRow, result.item);
            itemRow.style.display = '';
        } else if (result && result.conflict) {
            this.handleConflict(result.original_item_id, result.conflicting_item_id);
        } else {
            this.showNotification(result.error || 'Failed to update item.', 'error');
        }
    } catch (error) {
        this.showNotification('An unexpected error occurred.', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
  },

  async handleConflict(originalItemId, conflictingItemId) {
    const originalItem = await this.fetchJson(`${this.apiBase}/items/${originalItemId}`);
    const conflictingItem = await this.fetchJson(`${this.apiBase}/items/${conflictingItemId}`);

    if (!originalItem || !conflictingItem) {
        this.showNotification('Could not fetch item details for conflict resolution.', 'error');
        return;
    }

    const modal = this.createConflictModal(originalItem, conflictingItem);
    document.body.appendChild(modal);
    modal.classList.add('is-open');

    modal.addEventListener('click', async (e) => {
        if (e.target.classList.contains('keep-btn')) {
            const keepId = e.target.dataset.keep;
            const deleteId = keepId == originalItemId ? conflictingItemId : originalItemId;
            
            const result = await this.fetchJson(`${this.apiBase}/items/${deleteId}`, { method: 'DELETE' });

            if (result) {
                this.showNotification('Item updated and duplicate removed.', 'success');
                this.fetchItems(); // Refresh the list
            } else {
                this.showNotification('Failed to resolve conflict.', 'error');
            }
            modal.remove();
        } else if (e.target.classList.contains('close-modal-btn') || e.target.classList.contains('modal')) {
            modal.remove();
        }
    });
  },

  createConflictModal(originalItem, conflictingItem) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close-modal-btn">&times;</span>
            <h3>Resolve Duplicate Item</h3>
            <p>An item with the same details already exists. Please choose which version to keep.</p>
            <div class="conflict-options">
                <div class="conflict-option">
                    <h4>Original Item</h4>
                    <p><strong>Name:</strong> ${this.escapeHtml(originalItem.name)}</p>
                    <p><strong>Model:</strong> ${this.escapeHtml(originalItem.model)}</p>
                    <p><strong>Variation:</strong> ${this.escapeHtml(originalItem.variation)}</p>
                    <button class="button keep-btn" data-keep="${originalItem.id}">Keep This</button>
                </div>
                <div class="conflict-option">
                    <h4>Existing Item</h4>
                    <p><strong>Name:</strong> ${this.escapeHtml(conflictingItem.name)}</p>
                    <p><strong>Model:</strong> ${this.escapeHtml(conflictingItem.model)}</p>
                    <p><strong>Variation:</strong> ${this.escapeHtml(conflictingItem.variation)}</p>
                    <button class="button keep-btn" data-keep="${conflictingItem.id}">Keep This</button>
                </div>
            </div>
        </div>
    `;
    return modal;
  },

/**
 * ✅ PERFORMANCE: Update item row with batched DOM operations
 * Uses requestAnimationFrame for smooth updates
 */
updateItemRow(row, item) {
    // Update data attributes
    row.dataset.itemName = item.name;
    row.dataset.itemDescription = item.description || '';
    
    const statusClass = item.has_low_stock_variants ? 'low-stock' : 'in-stock';
    const statusText = item.has_low_stock_variants ? 'Low Stock' : 'In Stock';
    
    // Batch all DOM reads first (prevents layout thrashing)
    const elements = {
        nameCell: row.querySelector('.item-name-cell span'),
        modelCell: row.querySelector('[data-label="Model"]'),
        variationCell: row.querySelector('[data-label="Variation"]'),
        variantsCell: row.querySelector('[data-label="Variants"]'),
        stockCell: row.querySelector('.total-stock-cell'),
        statusBadge: row.querySelector('.status-badge'),
        image: row.querySelector('.item-image-thumbnail')
    };
    
    // Batch all DOM writes in single animation frame
    requestAnimationFrame(() => {
        elements.nameCell.textContent = item.name;
        elements.nameCell.title = item.description || 'No description provided.';
        elements.modelCell.textContent = item.model || '--';
        elements.variationCell.textContent = item.variation || '--';
        elements.variantsCell.textContent = item.variant_count;
        elements.stockCell.textContent = item.total_stock;
        
        elements.statusBadge.className = `status-badge ${statusClass}`;
        elements.statusBadge.textContent = statusText;
        
        elements.image.src = `/static/${item.image_path || 'uploads/placeholder.png'}`;
        elements.image.alt = item.name;
    });
},

  renderVariantsInModal(variants) {
    if (!this.variantsContainer) return;
    if (variants.length === 0) {
      this.variantsContainer.innerHTML = `<div class="variants-placeholder"><p>No variants added yet</p><small>Click "Add Variant" to create combinations</small></div>`;
      return;
    }
    const tableHTML = `<div class="variants-table-wrapper"><table class="variants-modal-table">
      <thead><tr><th>Color</th><th>Size</th><th>Stock</th><th>Unit</th><th>Threshold</th><th></th></tr></thead>
      <tbody>${variants.map(v => this.createVariantRowHTML(v)).join('')}</tbody>
    </table></div>`;
    this.variantsContainer.innerHTML = tableHTML;
  },

  addVariantRow() {
    if (!this.variantsContainer) return;
    let tbody = this.variantsContainer.querySelector('tbody');
    if (!tbody) {
      this.variantsContainer.innerHTML = `<div class="variants-table-wrapper"><table class="variants-modal-table">
        <thead><tr><th>Color</th><th>Size</th><th>Stock</th><th>Unit</th><th>Threshold</th><th></th></tr></thead>
        <tbody></tbody></table></div>`;
      tbody = this.variantsContainer.querySelector('tbody');
    }
    tbody.insertAdjacentHTML('beforeend', this.createVariantRowHTML());
    const newRow = tbody.lastElementChild;
    if (newRow) newRow.querySelector('input')?.focus();
  },

  createVariantRowHTML(variant = null) {
    const v = variant || {};
    const colorName = v.color ? this.escapeHtml(v.color.name) : '';
    const sizeName = v.size ? this.escapeHtml(v.size.name) : '';
    return `
      <tr class="variant-modal-row" data-variant-id="${v.id || ''}">
        <td><input type="text" list="color-datalist" class="variant-color" value="${colorName}" placeholder="Color" required></td>
        <td><input type="text" list="size-datalist" class="variant-size" value="${sizeName}" placeholder="Size" required></td>
        <td><input type="number" class="stock-input" value="${v.opening_stock || 0}" min="0" required></td>
        <td><input type="text" list="unit-datalist" class="variant-unit" value="${v.unit || 'Pcs'}" placeholder="Unit" required></td>
        <td><input type="number" class="threshold-input" value="${v.threshold || 5}" min="0" required></td>
        <td><button type="button" class="button cancel remove-variant-btn" title="Remove variant">&times;</button></td>
      </tr>`;
  },

  updateVariantPlaceholder() {
    if (this.variantsContainer && !this.variantsContainer.querySelector('tbody tr')) {
      this.renderVariantsInModal([]);
    }
  },

  async handleItemFormSubmit(e) {
    e.preventDefault();
    
    // Manually trigger browser validation on all required fields
    if (!e.target.checkValidity()) {
        e.target.reportValidity();
        return;
    }

    const saveBtn = e.target.querySelector('.save-item-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        const itemId = document.getElementById('item-id')?.value;
        const isEditing = !!itemId;
        const formData = new FormData();
        ['name', 'model', 'variation', 'description'].forEach(field => {
            formData.append(field, document.getElementById(`item-${field}`)?.value?.trim() || '');
        });
        const imageInput = document.getElementById('item-image');
        if (imageInput && imageInput.files && imageInput.files.length > 0) {
            formData.append('image', imageInput.files[0]);
        }
        const variantRows = this.variantsContainer?.querySelectorAll('tbody tr') || [];
        const variants = Array.from(variantRows).map(row => {
            const color = row.querySelector('.variant-color')?.value?.trim();
            const size = row.querySelector('.variant-size')?.value?.trim();
            if (!color || !size) throw new Error('All variants must have a color and size.');
            return {
                id: row.dataset.variantId,
                color,
                size,
                opening_stock: parseInt(row.querySelector('.stock-input')?.value) || 0,
                unit: row.querySelector('.variant-unit')?.value?.trim() || 'Pcs',
                threshold: parseInt(row.querySelector('.threshold-input')?.value) || 5,
            };
        });
        if (variants.length === 0) {
            this.showNotification('At least one variant is required.', 'error');
            throw new Error('No variants provided.'); // Throw to be caught by the finally block
        }
        formData.append('variants', JSON.stringify(variants));

        const url = isEditing ? `${this.apiBase}/items/${itemId}` : `${this.apiBase}/items`;
        const method = isEditing ? 'PUT' : 'POST';
        const result = await this.fetchJson(url, { method, body: formData });

        if (result) {
            window.location.href = '/inventory';
        } else {
            // If fetchJson returns null (on error), re-enable the button.
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Item';
        }
    } catch (error) {
        // This will catch errors from creating form data (e.g., no variants)
        this.showNotification(error.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Item';
    }
  },

  async deleteItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"? This action cannot be undone.`)) return;
    const result = await this.fetchJson(`${this.apiBase}/items/${itemId}`, { method: 'DELETE' });
    if (result) {
      this.showNotification(`Item "${itemName}" deleted.`, 'success');
      this.fetchItems();
    }
  },

  async fetchMasterData(type) {
    const data = await this.fetchJson(`${this.apiBase}/${type}`);
    if (data) this[type] = data;
    return data;
  },

  populateDatalists() {
    const colorDatalist = document.getElementById('color-datalist');
    if (colorDatalist) {
      colorDatalist.innerHTML = this.colors.map(c => `<option value="${this.escapeHtml(c.name)}"></option>`).join('');
    }
    const sizeDatalist = document.getElementById('size-datalist');
    if (sizeDatalist) {
      sizeDatalist.innerHTML = this.sizes.map(s => `<option value="${this.escapeHtml(s.name)}"></option>`).join('');
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
        <input type="text" class="master-item-input" value="${this.escapeHtml(item.name)}" readonly>
        <div class="master-item-actions">
          <button class="button icon-btn edit-master" title="Edit" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
          <button class="button icon-btn save-master" title="Save" style="display: none;" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
          <button class="button icon-btn danger delete-master" title="Delete" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
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
      return;
    }
    const result = await this.fetchJson(`${this.apiBase}/${type}s`, {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    if (result) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} added.`, 'success');
      input.value = '';
      this.fetchAndRenderMasterData(type);
      this.fetchMasterData(type + 's');
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
      input.dataset.originalValue = input.value;
      editBtn.style.display = 'none';
      saveBtn.style.display = 'flex';
    } else if (button.classList.contains('save-master')) {
      const originalValue = input.dataset.originalValue;
      this.handleMasterUpdate(type, id, input.value.trim(), (success) => {
        input.readOnly = true;
        editBtn.style.display = 'flex';
        saveBtn.style.display = 'none';
        if (!success) {
          input.value = originalValue;
        }
      });
    } else if (button.classList.contains('delete-master')) {
      this.handleMasterDelete(type, id, input.value);
    }
  },

  async handleMasterUpdate(type, id, name, onFinish) {
    if (!name) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} name cannot be empty.`, 'error');
      if (onFinish) onFinish(false);
      return;
    }
    const result = await this.fetchJson(`${this.apiBase}/${type}s/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    if (result) {
      this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} updated.`, 'success');
      this.fetchMasterData(type + 's');
    }
    if (onFinish) onFinish(!!result);
  },

  async handleMasterDelete(type, id, name, onFinish) {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return;
    const result = await this.fetchJson(`${this.apiBase}/${type}s/${id}`, { method: 'DELETE' });
    if (result) {
      this.showNotification(`"${name}" has been deleted.`, 'success');
      if (onFinish) {
        onFinish();
      } else {
        this.fetchAndRenderMasterData(type);
      }
      this.fetchMasterData(type + 's');
    }
  },

  escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    // Use a DOM element to safely encode text content
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // Placeholder to avoid breaking fetchInitialData Promise.all reference
  async fetchItemNames() {
    const itemNameDatalist = document.getElementById('item-name-list');
    if (!itemNameDatalist) return;

    const names = await this.fetchJson(`${this.apiBase}/item-names`);
    if (names) {
      this.populateDatalist(itemNameDatalist, names);
    }
    return names;
  },

  async fetchModels(itemName, currentModel = null) {
    const itemModelSelect = document.getElementById('item-model');
    if (!itemModelSelect) return;

    const models = await this.fetchJson(`${this.apiBase}/models-by-item?item_name=${encodeURIComponent(itemName)}`);
    if (models) {
      this.populateSelect(itemModelSelect, models, currentModel);
    }
    return models;
  },

  async fetchVariations(itemName, model, currentVariation = null) {
    const itemVariationSelect = document.getElementById('item-variation');
    if (!itemVariationSelect) return;

    const variations = await this.fetchJson(`${this.apiBase}/variations-by-item-model?item_name=${encodeURIComponent(itemName)}&model=${encodeURIComponent(model)}`);
    if (variations) {
      this.populateSelect(itemVariationSelect, variations, currentVariation);
    }
    return variations;
  },

  populateDatalist(datalistElement, options) {
    datalistElement.innerHTML = '';
    options.forEach(optionText => {
      const optionElement = document.createElement('option');
      optionElement.value = optionText;
      datalistElement.appendChild(optionElement);
    });
  },

  populateSelect(selectElement, options, currentValue = null) {
    const $select = $(selectElement);
    const isInitialized = $select.hasClass("select2-hidden-accessible");

    // Preserve the current value if it's not in the new options list
    const previousValue = $select.val();

    $select.empty(); // Clear existing options

    // Add a placeholder option if the original element had one.
    if (selectElement.querySelector('option[value=""]')) {
        $select.append(new Option('Choose...', ''));
    }

    // If the current value isn't in the new options, add it.
    // This is important for tags and for preserving state during updates.
    if (currentValue && !options.some(opt => opt.name === currentValue)) {
        options.unshift({ id: null, name: currentValue });
    }

    options.forEach(option => {
        const optionElement = new Option(option.name, option.name);
        if (option.id) {
            optionElement.dataset.id = option.id;
        }
        $select.append(optionElement);
    });

    // Set the value after populating
    $select.val(currentValue || previousValue);

    // Initialize Select2 only if it hasn't been initialized yet.
    if (!isInitialized) {
        $select.select2({
            tags: true,
            width: '100%'
        });
    }
    
    // Trigger a change event to make sure Select2 updates its display.
    $select.trigger('change.select2');
  },

  handleDropdownActions(e, type, action) {
    const button = e.target.closest('button');
    const container = button.closest('.input-with-buttons');
    const selectElement = $(container).find('select');
    const selectedValue = selectElement.val();

    if (!selectedValue) {
        this.showNotification(`Please select a ${type} to ${action}.`, 'error');
        return;
    }

    const optionElement = selectElement.find('option').filter(function() {
        return $(this).val() === selectedValue;
    });
    let id = optionElement.data('id');

    if (!id) {
        const masterList = type === 'model' ? this.models : this.variations;
        const foundItem = masterList ? masterList.find(item => item.name === selectedValue) : undefined;
        if (foundItem) {
            id = foundItem.id;
        }
    }
    
    if (!id) {
        this.showNotification(`Could not find the ID for ${type} "${selectedValue}". It might be a new, unsaved entry.`, 'error');
        return;
    }

    const form = button.closest('form');
    const itemNameInput = $(form).find('input[id^="item-name"], input[id^="edit-item-name-"]');
    const modelSelect = $(form).find('select[id^="item-model"], select[id^="edit-item-model-"]');

    const refreshDropdown = async (isSuccess, newValue) => {
        const itemName = itemNameInput.val();
        const modelName = modelSelect.val();
        const valueToSelect = isSuccess ? newValue : selectedValue;

        if (type === 'model') {
            const models = await this.fetchJson(`${this.apiBase}/models-by-item?item_name=${encodeURIComponent(itemName)}`);
            if (models) {
                this.models = models;
                this.populateSelect(selectElement[0], models, valueToSelect);
            }
        } else if (type === 'variation') {
            const variations = await this.fetchJson(`${this.apiBase}/variations-by-item-model?item_name=${encodeURIComponent(itemName)}&model=${encodeURIComponent(modelName)}`);
            if (variations) {
                this.variations = variations;
                this.populateSelect(selectElement[0], variations, valueToSelect);
            }
        }
    };

    if (action === 'edit') {
        const newText = prompt(`Edit ${type}:`, selectedValue);
        if (newText && newText !== selectedValue) {
            this.handleMasterUpdate(type, id, newText, (success) => {
                refreshDropdown(success, newText);
            });
        }
    } else if (action === 'delete') {
        // This logic is now explicit for both models and variations.
        if (type === 'model') {
            if (confirm(`Are you sure you want to remove the model "${selectedValue}" from this item?`)) {
                // Just clear the value, don't delete from the master list.
                selectElement.val(null).trigger('change');
            }
        } else if (type === 'variation') {
            if (confirm(`Are you sure you want to remove the variation "${selectedValue}" from this item?`)) {
                // Just clear the value, don't delete from the master list.
                selectElement.val(null).trigger('change');
            }
        }
    }
  },

  // Supplier Functions
  async fetchSuppliers() {
    const suppliers = await this.fetchJson(`${this.apiBase}/suppliers`);
    if (suppliers) this.renderSuppliersList(suppliers);
  },

  renderSuppliersList(suppliers) {
    if (!this.suppliersTableBody) return;
    this.suppliersTableBody.innerHTML = suppliers.map(s => `
      <tr data-supplier-id="${s.supplier_id}">
        <td>${this.escapeHtml(s.firm_name)}</td>
        <td>${this.escapeHtml(s.address)}</td>
        <td>${this.escapeHtml(s.gstin)}</td>
        <td class="actions-cell">
          <button class="button edit-supplier">Edit</button>
          <button class="button delete-supplier">Delete</button>
          <button class="button view-ledger">Ledger</button>
          <button class="button view-rates">Rates</button>
        </td>
      </tr>
    `).join('');
  },

  openSupplierModal(supplier = null) {
    this.supplierForm.reset();
    document.getElementById('supplier-id').value = supplier ? supplier.supplier_id : '';
    document.getElementById('supplier-modal-title').textContent = supplier ? 'Edit Supplier' : 'Add Supplier';
    document.getElementById('firm-name').value = supplier ? supplier.firm_name : '';
    document.getElementById('address').value = supplier ? supplier.address : '';
    document.getElementById('gstin').value = supplier ? supplier.gstin : '';
    this.contactsContainer.innerHTML = '';
    if (supplier) {
      this.fetchJson(`${this.apiBase}/suppliers/${supplier.supplier_id}/contacts`).then(contacts => {
        contacts.forEach(c => this.addContactField(c));
      });
    } else {
      this.addContactField();
    }
    this.supplierModal.classList.add('is-open');
  },

  addContactField(contact = null) {
    const div = document.createElement('div');
    div.className = 'contact-field-group';
    div.innerHTML = `
      <input type="text" placeholder="Name" class="contact-name" value="${contact ? this.escapeHtml(contact.contact_name) : ''}" required>
      <input type="text" placeholder="Phone" class="contact-phone" value="${contact ? this.escapeHtml(contact.contact_phone) : ''}">
      <input type="email" placeholder="Email" class="contact-email" value="${contact ? this.escapeHtml(contact.contact_email) : ''}">
      <button type="button" class="button cancel remove-contact-btn">&times;</button>
    `;
    this.contactsContainer.appendChild(div);
    div.querySelector('.remove-contact-btn').addEventListener('click', () => div.remove());
  },

  async handleSupplierFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('supplier-id').value;
    const contacts = Array.from(this.contactsContainer.querySelectorAll('.contact-field-group')).map(row => ({
      name: row.querySelector('.contact-name').value,
      phone: row.querySelector('.contact-phone').value,
      email: row.querySelector('.contact-email').value,
    }));
    const data = {
      firm_name: document.getElementById('firm-name').value,
      address: document.getElementById('address').value,
      gstin: document.getElementById('gstin').value,
      contacts: contacts,
    };
    const url = id ? `${this.apiBase}/suppliers/${id}` : `${this.apiBase}/suppliers`;
    const method = id ? 'PUT' : 'POST';
    const result = await this.fetchJson(url, { method, body: JSON.stringify(data) });
    if (result) {
      this.showNotification(`Supplier ${id ? 'updated' : 'added'}.`, 'success');
      this.supplierModal.classList.remove('is-open');
      this.fetchSuppliers();
    }
  },

  async handleSupplierActions(e) {
    const button = e.target.closest('button');
    if (!button) return;
    const row = button.closest('tr');
    const id = row.dataset.supplierId;
    if (button.classList.contains('edit-supplier')) {
      const supplier = await this.fetchJson(`${this.apiBase}/suppliers/${id}`);
      if (supplier) this.openSupplierModal(supplier);
    } else if (button.classList.contains('delete-supplier')) {
      this.deleteSupplier(id, row.cells[0].textContent);
    } else if (button.classList.contains('view-ledger')) {
      this.openLedgerModal(id);
    } else if (button.classList.contains('view-rates')) {
      this.openRatesModal(id);
    }
  },

  async deleteSupplier(id, name) {
    if (!confirm(`Delete supplier "${name}"?`)) return;
    const result = await this.fetchJson(`${this.apiBase}/suppliers/${id}`, { method: 'DELETE' });
    if (result) {
      this.showNotification('Supplier deleted.', 'success');
      this.fetchSuppliers();
    }
  },

  async openLedgerModal(supplierId) {
    const ledgerBody = document.getElementById('ledger-table-body');
    ledgerBody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
    this.ledgerModal.classList.add('is-open');
    const entries = await this.fetchJson(`${this.apiBase}/suppliers/${supplierId}/ledger`);
    if (entries) {
      ledgerBody.innerHTML = entries.map(e => `
        <tr>
          <td>${new Date(e.entry_date).toLocaleDateString()}</td>
          <td>${this.escapeHtml(e.item_name)}</td>
          <td>${e.quantity_added}</td>
          <td>${e.cost_per_unit}</td>
        </tr>
      `).join('');
    }
  },

  async openRatesModal(supplierId) {
    const ratesBody = document.getElementById('rates-table-body');
    ratesBody.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';
    this.ratesModal.classList.add('is-open');
    const rates = await this.fetchJson(`${this.apiBase}/suppliers/${supplierId}/rates`);
    if (rates) {
      this.renderRatesList(rates);
    }
    // Setup form
    const form = document.getElementById('add-rate-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const itemId = document.getElementById('item-select').value;
      const rate = document.getElementById('rate-input').value;
      const result = await this.fetchJson(`${this.apiBase}/suppliers/${supplierId}/rates`, {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId, rate: rate })
      });
      if (result) {
        this.showNotification('Rate added.', 'success');
        this.openRatesModal(supplierId); // Refresh
      }
    };
  },

  renderRatesList(rates) {
    const ratesBody = document.getElementById('rates-table-body');
    ratesBody.innerHTML = rates.map(r => `
      <tr data-rate-id="${r.rate_id}">
        <td>${this.escapeHtml(r.item_name)}</td>
        <td>${r.rate}</td>
        <td><button class="button cancel delete-rate">&times;</button></td>
      </tr>
    `).join('');
    ratesBody.querySelectorAll('.delete-rate').forEach(btn => {
      btn.onclick = async (e) => {
        const rateId = e.target.closest('tr').dataset.rateId;
        if (confirm('Delete this rate?')) {
          await this.fetchJson(`${this.apiBase}/suppliers/rates/${rateId}`, { method: 'DELETE' });
          e.target.closest('tr').remove();
        }
      };
    });
  },

  // Purchase Order Functions
  async fetchPurchaseOrders() {
    const pos = await this.fetchJson(`${this.apiBase}/purchase-orders`);
    if (pos) this.renderPurchaseOrdersList(pos);
  },

  renderPurchaseOrdersList(pos) {
    if (!this.poTableBody) return;
    this.poTableBody.innerHTML = pos.map(po => `
      <tr data-po-id="${po.po_id}">
        <td>${this.escapeHtml(po.po_number)}</td>
        <td>${this.escapeHtml(po.firm_name)}</td>
        <td>${new Date(po.order_date).toLocaleDateString()}</td>
        <td>${po.total_amount}</td>
        <td>${this.escapeHtml(po.status)}</td>
        <td class="actions-cell">
          <button class="button view-po-details">Details</button>
          <button class="button edit-po">Edit</button>
          <button class="button delete-po" ${po.status !== 'Draft' ? 'disabled' : ''}>Delete</button>
        </td>
      </tr>
    `).join('');
  },

  openPurchaseOrderModal(po = null) {
    this.poForm.reset();
    document.getElementById('po-id').value = po ? po.po_id : '';
    document.getElementById('po-modal-title').textContent = po ? 'Edit Purchase Order' : 'New Purchase Order';
    this.poItemsContainer.innerHTML = `
        <div class="po-items-header">
            <div class="po-header-details">Item Details</div>
            <div class="po-header-quantity">Quantity</div>
            <div class="po-header-rate">Rate</div>
            <div class="po-header-action">Action</div>
        </div>
    `;
    
    // Add the new searchable dropdown container
    const searchContainer = document.createElement('div');
    searchContainer.id = 'po-item-search-container';
    searchContainer.innerHTML = `<select id="po-item-search" class="po-item-search" data-placeholder="Search and add an item..."></select>`;
    this.poItemsContainer.appendChild(searchContainer);

    // Add total amount display
    const totalContainer = document.createElement('div');
    totalContainer.id = 'po-total-container';
    totalContainer.innerHTML = `<strong>Total Amount:</strong> <span id="po-total-amount">0.00</span>`;
    this.poItemsContainer.appendChild(totalContainer);

    // Populate suppliers dropdown
    this.fetchJson(`${this.apiBase}/suppliers`).then(suppliers => {
        const select = document.getElementById('supplier-select');
        select.innerHTML = '<option value="">Select Supplier</option>' + suppliers.map(s => `<option value="${s.supplier_id}">${this.escapeHtml(s.firm_name)}</option>`).join('');
        if (po) select.value = po.supplier_id;
    });

    if (po) {
        po.items.forEach(item => this.addPoItemField(item));
    }

    this.initPurchaseOrderItemSearch();
    this.updatePurchaseOrderTotal();
    this.poModal.classList.add('is-open');
},

addPoItemField(item = null) {
    const div = document.createElement('div');
    div.className = 'po-item-row-detailed';
    div.innerHTML = `
        <div class="po-item-details">
            <div class="po-item-detail-field"><strong>Item:</strong> ${item ? this.escapeHtml(item.item_name) : 'N/A'}</div>
            <div class="po-item-detail-field"><strong>Model:</strong> ${item ? this.escapeHtml(item.model_name) : 'N/A'}</div>
            <div class="po-item-detail-field"><strong>Variation:</strong> ${item ? this.escapeHtml(item.variation_name) : 'N/A'}</div>
            <div class="po-item-detail-field"><strong>Color:</strong> ${item ? this.escapeHtml(item.color_name) : 'N/A'}</div>
            <div class="po-item-detail-field"><strong>Size:</strong> ${item ? this.escapeHtml(item.size_name) : 'N/A'}</div>
        </div>
        <div class="po-item-inputs">
            <input type="number" class="po-quantity" placeholder="Qty" value="${item ? item.quantity : 1}">
            <input type="number" class="po-rate" placeholder="Rate" value="${item ? item.rate : 0}">
        </div>
        <button type="button" class="button cancel remove-po-item-btn">&times;</button>
    `;
    div.dataset.variantId = item ? item.variant_id : '';
    
    // Insert the new item row before the search container
    const searchContainer = this.poItemsContainer.querySelector('#po-item-search-container');
    this.poItemsContainer.insertBefore(div, searchContainer);

    div.querySelector('.remove-po-item-btn').addEventListener('click', () => {
        div.remove();
        this.updatePurchaseOrderTotal();
    });

    // Add event listeners to update total on quantity/rate change
    div.querySelector('.po-quantity').addEventListener('input', () => this.updatePurchaseOrderTotal());
    div.querySelector('.po-rate').addEventListener('input', () => this.updatePurchaseOrderTotal());
    this.updatePurchaseOrderTotal();
},

async initPurchaseOrderItemSearch() {
    if (this.allVariantsForSearch.length === 0) {
        this.allVariantsForSearch = await this.fetchJson(`${this.apiBase}/variants/search`);
    }

    const formatVariant = (variant) => {
        if (!variant.id) {
            return variant.text;
        }
        const parts = [
            variant.item_name,
            variant.model_name,
            variant.variation_name,
            `(${variant.color_name}, ${variant.size_name})`
        ];
        return $(`<span>${parts.filter(p => p).join(' - ')}</span>`);
    };

    $('#po-item-search').select2({
        width: '100%',
        dropdownParent: $('#po-modal'),
        data: this.allVariantsForSearch.map(v => ({
            id: v.variant_id,
            text: `${v.item_name} - ${v.model_name} - ${v.variation_name} (${v.color_name}, ${v.size_name})`,
            ...v
        })),
        templateResult: formatVariant,
        templateSelection: (data) => "Search and add an item...",
    }).on('select2:select', (e) => {
        const variant = e.params.data;
        this.addPoItemField({
            variant_id: variant.variant_id,
            item_name: variant.item_name,
            model_name: variant.model_name,
            variation_name: variant.variation_name,
            color_name: variant.color_name,
            size_name: variant.size_name,
            quantity: 1,
            rate: 0
        });
        // Reset the dropdown for the next selection
        $('#po-item-search').val(null).trigger('change');
    });
},

updatePurchaseOrderTotal() {
    const total = Array.from(this.poItemsContainer.querySelectorAll('.po-item-row-detailed')).reduce((acc, row) => {
        const quantity = parseFloat(row.querySelector('.po-quantity').value) || 0;
        const rate = parseFloat(row.querySelector('.po-rate').value) || 0;
        return acc + (quantity * rate);
    }, 0);
    document.getElementById('po-total-amount').textContent = total.toFixed(2);
},

  renderVariantSearchResults() {
    const searchTerm = this.variantSearchInput.value.toLowerCase();
    const filteredVariants = this.allVariantsForSearch.filter(v => {
        return Object.values(v).some(val => 
            String(val).toLowerCase().includes(searchTerm)
        );
    });

    this.variantSearchResults.innerHTML = filteredVariants.map(v => `
        <tr data-variant-id="${v.variant_id}">
            <td><input type="checkbox" class="po-variant-checkbox" value="${v.variant_id}"></td>
            <td>${this.escapeHtml(v.item_name)}</td>
            <td>${this.escapeHtml(v.model_name)}</td>
            <td>${this.escapeHtml(v.variation_name)}</td>
            <td>${this.escapeHtml(v.color_name)}</td>
            <td>${this.escapeHtml(v.size_name)}</td>
        </tr>
    `).join('');
    this.updateSelectAllCheckboxState();
  },

  addSelectedVariantsToPO() {
    const selectedCheckboxes = this.variantSearchResults.querySelectorAll('input[type="checkbox"]:checked');
    selectedCheckboxes.forEach(checkbox => {
        const variantId = checkbox.value;
        const variant = this.allVariantsForSearch.find(v => v.variant_id == variantId);
        if (variant) {
            this.addPoItemField({
                variant_id: variant.variant_id,
                item_name: variant.item_name,
                model_name: variant.model_name,
                variation_name: variant.variation_name,
                color_name: variant.color_name,
                size_name: variant.size_name,
                quantity: 1,
                rate: 0
            });
        }
    });
    this.variantSearchModal.classList.remove('is-open');
  },

  updateSelectAllCheckboxState() {
    if (!this.selectAllVariantsCheckbox) return;
    const allCheckboxes = this.variantSearchResults.querySelectorAll('input[type="checkbox"]');
    const checkedCheckboxes = this.variantSearchResults.querySelectorAll('input[type="checkbox"]:checked');
    
    if (allCheckboxes.length > 0 && allCheckboxes.length === checkedCheckboxes.length) {
        this.selectAllVariantsCheckbox.checked = true;
        this.selectAllVariantsCheckbox.indeterminate = false;
    } else if (checkedCheckboxes.length > 0) {
        this.selectAllVariantsCheckbox.indeterminate = true;
        this.selectAllVariantsCheckbox.checked = false;
    } else {
        this.selectAllVariantsCheckbox.checked = false;
        this.selectAllVariantsCheckbox.indeterminate = false;
    }
  },

  async handlePurchaseOrderFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('po-id').value;
    const supplierId = document.getElementById('supplier-select').value;
    const items = Array.from(this.poItemsContainer.querySelectorAll('.po-item-row-detailed')).map(row => ({
      variant_id: row.dataset.variantId,
      quantity: row.querySelector('.po-quantity').value,
      rate: row.querySelector('.po-rate').value,
    }));

    if (!supplierId) {
        this.showNotification('Please select a supplier.', 'error');
        return;
    }

    if (items.length === 0) {
        this.showNotification('Please add at least one item to the purchase order.', 'error');
        return;
    }

    const data = {
      supplier_id: supplierId,
      items: items,
      status: 'Draft', // Or get from a field
    };
    const url = id ? `${this.apiBase}/purchase-orders/${id}` : `${this.apiBase}/purchase-orders`;
    const method = id ? 'PUT' : 'POST';
    const result = await this.fetchJson(url, { method, body: JSON.stringify(data) });
    if (result) {
      this.showNotification(`Purchase Order ${id ? 'updated' : 'created'}.`, 'success');
      this.poModal.classList.remove('is-open');
      this.fetchPurchaseOrders();
    }
  },

  async handlePurchaseOrderActions(e) {
    const button = e.target.closest('button');
    if (!button) return;
    const row = button.closest('tr');
    const id = row.dataset.poId;
    if (button.classList.contains('edit-po')) {
      const po = await this.fetchJson(`${this.apiBase}/purchase-orders/${id}`);
      if (po) this.openPurchaseOrderModal(po);
    } else if (button.classList.contains('delete-po')) {
      this.deletePurchaseOrder(id, row.cells[0].textContent);
    } else if (button.classList.contains('view-po-details')) {
      this.openPurchaseOrderDetailsModal(id);
    }
  },

  async deletePurchaseOrder(id, name) {
    if (!confirm(`Delete PO "${name}"?`)) return;
    const result = await this.fetchJson(`${this.apiBase}/purchase-orders/${id}`, { method: 'DELETE' });
    if (result) {
      this.showNotification('Purchase Order deleted.', 'success');
      this.fetchPurchaseOrders();
    }
  },

  async openPurchaseOrderDetailsModal(poId) {
    const detailsBody = document.getElementById('po-details-body');
    detailsBody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
    this.poDetailsModal.classList.add('is-open');
    const po = await this.fetchJson(`${this.apiBase}/purchase-orders/${poId}`);
    if (po && po.items) {
      detailsBody.innerHTML = po.items.map(item => `
        <tr>
          <td>${this.escapeHtml(item.item_name)}</td>
          <td>${item.quantity}</td>
          <td>${item.received_quantity || 0}</td>
          <td>${item.quantity - (item.received_quantity || 0)}</td>
        </tr>
      `).join('');
    }
  },

  // Stock Receiving Functions
  openReceiveStockModal() {
    this.receiveStockForm.reset();
    document.getElementById('receive-items-body').innerHTML = '';
    this.updateReceiveTotals();

    const supplierSelect = document.getElementById('receive-supplier-select');
    this.fetchJson(`${this.apiBase}/suppliers`).then(suppliers => {
      supplierSelect.innerHTML = '<option value="">Select Supplier</option>' + suppliers.map(s => `<option value="${s.supplier_id}">${this.escapeHtml(s.firm_name)}</option>`).join('');
    });

    const fetchPoBtn = document.getElementById('fetch-po-btn');
    fetchPoBtn.addEventListener('click', async () => {
      const poNumber = document.getElementById('receive-po-number').value;
      if (poNumber) {
        const po = await this.fetchJson(`${this.apiBase}/purchase-orders/by-number/${poNumber}`);
        if (po && po.po_id) {
          supplierSelect.value = po.supplier_id;
          const itemsBody = document.getElementById('receive-items-body');
          itemsBody.innerHTML = '';
          po.items.forEach(item => this.addReceiveItemRow(item));
          this.updateReceiveTotals();
          this.receiveStockForm.dataset.poId = po.po_id;
        } else {
          this.showNotification('Purchase Order not found.', 'error');
          delete this.receiveStockForm.dataset.poId;
        }
      }
    });

    this.addReceiveItemRow();
    this.receiveStockModal.classList.add('is-open');
  },

  addReceiveItemRow(item = null) {
    const tbody = document.getElementById('receive-items-body');
    const row = tbody.insertRow();
    row.innerHTML = `
      <td><select class="receive-item-select" style="width: 100%;"></select></td>
      <td><input type="number" class="receive-quantity" value="${item ? item.quantity : 1}" min="1"></td>
      <td><input type="number" class="receive-cost" step="0.01" value="${item ? item.rate : 0}"></td>
      <td class="receive-item-total">0.00</td>
      <td><button type="button" class="button cancel remove-receive-item-btn">&times;</button></td>
    `;

    const itemSelect = row.querySelector('.receive-item-select');
    this.fetchJson(`${this.apiBase}/all-variants`).then(variants => {
      itemSelect.innerHTML = '<option value="">Select Item/Variant</option>' + variants.map(v => `<option value="${v.id}" ${item && v.id == item.variant_id ? 'selected' : ''}>${this.escapeHtml(v.name)}</option>`).join('');
    });

    row.querySelector('.remove-receive-item-btn').addEventListener('click', () => {
      row.remove();
      this.updateReceiveTotals();
    });

    row.querySelectorAll('.receive-quantity, .receive-cost').forEach(input => {
      input.addEventListener('input', () => this.updateReceiveTotals());
    });
    
    document.getElementById('receive-tax-percentage').addEventListener('input', () => this.updateReceiveTotals());
    document.getElementById('receive-discount-percentage').addEventListener('input', () => this.updateReceiveTotals());
  },

  updateReceiveTotals() {
    let totalAmount = 0;
    document.querySelectorAll('#receive-items-body tr').forEach(row => {
      const quantity = parseFloat(row.querySelector('.receive-quantity').value) || 0;
      const cost = parseFloat(row.querySelector('.receive-cost').value) || 0;
      const itemTotal = quantity * cost;
      row.querySelector('.receive-item-total').textContent = itemTotal.toFixed(2);
      totalAmount += itemTotal;
    });

    const taxPercentage = parseFloat(document.getElementById('receive-tax-percentage').value) || 0;
    const discountPercentage = parseFloat(document.getElementById('receive-discount-percentage').value) || 0;
    const taxAmount = totalAmount * (taxPercentage / 100);
    const discountAmount = totalAmount * (discountPercentage / 100);
    const grandTotal = totalAmount + taxAmount - discountAmount;

    document.getElementById('receive-total-amount').textContent = totalAmount.toFixed(2);
    document.getElementById('receive-discount-amount').textContent = discountAmount.toFixed(2);
    document.getElementById('receive-grand-total').textContent = grandTotal.toFixed(2);
  },

  async handleReceiveStockFormSubmit(e) {
    e.preventDefault();
    const items = [];
    document.querySelectorAll('#receive-items-body tr').forEach(row => {
      items.push({
        variant_id: row.querySelector('.receive-item-select').value,
        quantity: row.querySelector('.receive-quantity').value,
        cost: row.querySelector('.receive-cost').value,
      });
    });

    const data = {
      bill_number: document.getElementById('receive-bill-number').value,
      supplier_id: document.getElementById('receive-supplier-select').value,
      tax_percentage: document.getElementById('receive-tax-percentage').value,
      discount_percentage: document.getElementById('receive-discount-percentage').value,
      po_id: this.receiveStockForm.dataset.poId || null,
      items: items,
    };

    const result = await this.fetchJson(`${this.apiBase}/stock-receipts`, {
      method: 'POST',
      body: JSON.stringify(data)
    });

    if (result && result.receipt_id) {
      this.showNotification('Stock received successfully.', 'success');
      this.receiveStockModal.classList.remove('is-open');
      this.fetchItems();
    }
  },
};

App.init();

