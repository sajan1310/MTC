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
  itemForm: null,
  modalTitle: null,
  variantsContainer: null,
  addVariantBtn: null,
  userManagementTableBody: null,
  searchInput: null,
  clearSearchBtn: null,
  addColorForm: null,
  addSizeForm: null,

  init() {
    const onReady = () => {
      this.cacheDOMElements();
      this.bindEventListeners();
      this.initImportModal();
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
      this.inventoryTableBody.addEventListener('click', (e) => this.handleTableActions(e));
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

    document.body.addEventListener('click', (e) => {
        if (e.target.closest('.edit-model-btn')) {
            this.handleDropdownActions('model', 'edit');
        } else if (e.target.closest('.delete-model-btn')) {
            this.handleDropdownActions('model', 'delete');
        } else if (e.target.closest('.edit-variation-btn')) {
            this.handleDropdownActions('variation', 'edit');
        } else if (e.target.closest('.delete-variation-btn')) {
            this.handleDropdownActions('variation', 'delete');
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
      
      const optionElement = selectElement.find('option').filter(function() {
          return $(this).text() === text;
      });
      
      const id = optionElement.data('id');
      const type = originalSelectId.includes('model') ? 'model' : 'variation';

      if (!id) {
        return;
      }

      const newText = prompt(`Edit ${type}:`, text);
      if (newText && newText !== text) {
        this.handleMasterUpdate(type, id, newText, () => {
          if (type === 'model') {
            this.fetchModels($('#item-name').val(), newText);
          } else if (type === 'variation') {
            this.fetchVariations($('#item-name').val(), $('#item-model').val(), newText);
          }
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
  },

  async fetchJson(url, options = {}) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
    const defaultHeaders = {
      'Accept': 'application/json',
      'X-CSRFToken': csrfToken
    };

    // Correctly handle Content-Type for JSON bodies, but not for FormData
    if (options.body && typeof options.body === 'string' && !options.headers?.['Content-Type']) {
        try {
            JSON.parse(options.body); // Check if it's a valid JSON string
            defaultHeaders['Content-Type'] = 'application/json';
        } catch (e) {
            // Not a JSON string, do nothing
        }
    } else if (options.body && !(options.body instanceof FormData) && !options.headers?.['Content-Type']) {
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
        throw new Error(`HTTP ${res.status}: ${errorData.error || errorData.message}`);
      }
      return res.status === 204 ? true : await res.json();
    } catch (err) {
      console.error(`Fetch error for ${url}:`, err);
      if (typeof this.showNotification === 'function') this.showNotification(err.message, 'error');
      return null;
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
    }, 4000);
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
      container.innerHTML = `<div style="padding: 1rem; text-align: center;">Loading...</div>`;
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

 openImportModal() {
  console.log('Opening import modal...');
  if (!this.importModal) return;

  // Clear any old inline style
  this.importModal.style.removeProperty('display');

  // Add the 'is-open' class for transitions, opacity, etc.
  this.importModal.classList.add('is-open');
},



  closeImportModal() {
    if (this.importModal) {
      this.importModal.classList.remove('is-open');
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

      const formData = new FormData();
      formData.append('file', file);

      const response = await this.fetchJson('/api/import/preview', {
        method: 'POST',
        body: formData,
      });

      // Expecting { headers: string[], rows: Array<Record<string,any>> }
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

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleUpdateItem(itemId, form, itemRow);
    });

    const cancelButton = editRow.querySelector('.cancel-edit-btn');
    cancelButton.addEventListener('click', () => {
        editRow.remove();
        itemRow.style.display = '';
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
        </tr>
    `).join('');

    return `
        <tr class="edit-form-row">
            <td colspan="9">
                <form class="edit-item-form">
                    <h4>Edit ${this.escapeHtml(item.name)}</h4>
                    <div class="form-row">
                        <div class="form-field">
                            <label for="edit-item-name-${item.id}">Item Name</label>
                            <input type="text" id="edit-item-name-${item.id}" value="${this.escapeHtml(item.name)}" required>
                        </div>
                        <div class="form-field">
                            <label for="edit-item-model-${item.id}">Model</label>
                            <input type="text" id="edit-item-model-${item.id}" value="${this.escapeHtml(item.model || '')}">
                        </div>
                        <div class="form-field">
                            <label for="edit-item-variation-${item.id}">Variation</label>
                            <input type="text" id="edit-item-variation-${item.id}" value="${this.escapeHtml(item.variation || '')}">
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
                            </tr>
                        </thead>
                        <tbody>${variantRows}</tbody>
                    </table>
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

    const formData = new FormData();
    formData.append('name', form.querySelector(`#edit-item-name-${itemId}`).value);
    formData.append('model', form.querySelector(`#edit-item-model-${itemId}`).value);
    formData.append('variation', form.querySelector(`#edit-item-variation-${itemId}`).value);
    formData.append('description', form.querySelector(`#edit-item-description-${itemId}`).value);

    const variantRows = form.querySelectorAll('.variant-edit-row');
    const variants = Array.from(variantRows).map(row => ({
        id: row.dataset.variantId,
        color: row.querySelector('.variant-color').value,
        size: row.querySelector('.variant-size').value,
        opening_stock: parseInt(row.querySelector('.stock-input').value, 10),
        unit: row.querySelector('.variant-unit').value,
        threshold: parseInt(row.querySelector('.threshold-input').value, 10),
    }));
    formData.append('variants', JSON.stringify(variants));

    const result = await this.fetchJson(`${this.apiBase}/items/${itemId}`, {
        method: 'PUT',
        body: formData,
    });

    if (result) {
        this.showNotification('Item updated successfully.', 'success');
        form.closest('.edit-form-row').remove();
        itemRow.style.display = '';
        this.fetchItems(); // Refresh the entire list to reflect changes
    } else {
        this.showNotification('Failed to update item.', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
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
      this.fetchMasterData(type + 's');
    }
    onFinish();
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
    const placeholder = selectElement.querySelector('option[value=""]');
    selectElement.innerHTML = '';
    if (placeholder) {
        selectElement.appendChild(placeholder);
    }

    if (currentValue && !options.some(opt => opt.name === currentValue)) {
        options.unshift({ id: null, name: currentValue });
    }

    options.forEach(option => {
        const optionElement = document.createElement('option');
        optionElement.value = option.name;
        optionElement.textContent = option.name;
        if(option.id) {
            optionElement.dataset.id = option.id;
        }
        selectElement.appendChild(optionElement);
    });

    if (currentValue) {
        selectElement.value = currentValue;
    }

    $(selectElement).select2({
        tags: true,
        width: '100%'
    });
  },

  handleDropdownActions(type, action) {
    const selectId = `#item-${type}`;
    const selectElement = $(selectId);
    const selectedValue = selectElement.val();

    if (!selectedValue) {
        this.showNotification(`Please select a ${type} to ${action}.`, 'error');
        return;
    }

    const optionElement = selectElement.find('option').filter(function() {
        return $(this).val() === selectedValue;
    });
    const id = optionElement.data('id');

    if (action === 'edit') {
        const newText = prompt(`Edit ${type}:`, selectedValue);
        if (newText && newText !== selectedValue) {
            this.handleMasterUpdate(type, id, newText, () => {
                if (type === 'model') {
                    this.fetchModels($('#item-name').val(), newText);
                } else if (type === 'variation') {
                    this.fetchVariations($('#item-name').val(), $('#item-model').val(), newText);
                }
            });
        }
    } else if (action === 'delete') {
        if (confirm(`Are you sure you want to delete the ${type} "${selectedValue}"?`)) {
            this.handleMasterDelete(type, id, selectedValue, () => {
                if (type === 'model') {
                    this.fetchModels($('#item-name').val());
                } else if (type === 'variation') {
                    this.fetchVariations($('#item-name').val(), $('#item-model').val());
                }
            });
        }
    }
  }
};

App.init();
