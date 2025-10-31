"use strict";

const Inventory = {
  state: {
    currentPage: 1,
    totalPages: 1,
    totalItems: 0,
    isLoading: false,
    selectedItems: new Set(),
    allItems: [],
  },
  elements: {},

  init() {
    if (!document.getElementById("inventory-table-body")) return;

    this.cacheDOMElements();
    this.bindEventListeners();
    this.fetchItems();
    this.setupSearchFunctionality();
  },

  cacheDOMElements() {
    const ids = [
      "inventory-table-body",
      "add-item-btn",
      "inventory-search",
      "low-stock-filter",
      "item-form",
      "variants-list-container",
      "add-variant-btn",
      "export-csv-btn",
      "import-data-btn",
    ];
    ids.forEach((id) => {
      const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
      this.elements[camelCaseId] = document.getElementById(id);
    });
    this.elements.clearSearchBtn = document.querySelector(".clear-search-btn");
  },

  bindEventListeners() {
    this.elements.addItemBtn?.addEventListener("click", () => (window.location.href = "/add_item"));
    this.elements.exportCsvBtn?.addEventListener("click", () => this.exportInventoryToCSV());
    document.getElementById("low-stock-report-btn")?.addEventListener("click", () => this.showLowStockReport());
    
    if (this.elements.inventorySearch) {
      const debouncedSearch = debounce((value) => this.handleSearch(value), 300);
      this.elements.inventorySearch.addEventListener("input", (e) => debouncedSearch(e.target.value));
      this.elements.inventorySearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.target.value = "";
          this.handleSearch("");
          e.target.blur();
        }
      });
    }

    this.elements.clearSearchBtn?.addEventListener("click", () => this.clearSearch());
    this.elements.lowStockFilter?.addEventListener("change", () => this.fetchItems());
    this.elements.inventoryTableBody?.addEventListener("click", (e) => {
        this.handleTableActions(e);
        this.handleVariantMatrixActions(e);
    });
    this.elements.inventoryTableBody?.addEventListener("change", (e) => {
      if (e.target.classList.contains("item-checkbox")) {
        this.updateBulkActionsVisibility();
      }
    });

    const selectAllCheckbox = document.getElementById("select-all-items");
    selectAllCheckbox?.addEventListener("change", (e) => this.toggleSelectAll(e.target.checked));
    document.getElementById("bulk-delete-btn")?.addEventListener("click", () => this.handleBulkDelete());

    this.elements.itemForm?.addEventListener("submit", (e) => this.handleItemFormSubmit(e));
    this.elements.addVariantBtn?.addEventListener("click", () => this.addVariantRow());
    this.elements.variantsListContainer?.addEventListener("click", (e) => {
      if (e.target.closest(".remove-variant-btn")) {
        e.target.closest("tr")?.remove();
        this.updateVariantPlaceholder();
      }
    });

    window.addEventListener("scroll", () => this.handleScroll());
  },

  setupSearchFunctionality() {
    if (this.elements.inventorySearch && this.elements.clearSearchBtn) {
      const toggleClearButton = () => {
        this.elements.clearSearchBtn.style.display = this.elements.inventorySearch.value ? "block" : "none";
      };
      this.elements.inventorySearch.addEventListener("input", toggleClearButton);
      toggleClearButton();
    }
  },

  /**
   * Fetches inventory items from the backend with pagination and filters
   * Handles loading states and error recovery
   */
  async fetchItems() {
    const lowStockOnly = this.elements.lowStockFilter?.checked || false;
    const searchTerm = this.elements.inventorySearch?.value || "";
    const url = new URL(`${App.config.apiBase}/items`, window.location.origin);
    url.searchParams.append("page", this.state.currentPage);
    url.searchParams.append("per_page", App.config.pagination.per_page);
    if (lowStockOnly) url.searchParams.append("low_stock", "true");
    if (searchTerm) url.searchParams.append("search", searchTerm);

    this.state.isLoading = true;
    
    try {
      const data = await App.fetchJson(url.toString());
      if (data?.items) {
        this.state.allItems = this.state.currentPage === 1 ? data.items : [...this.state.allItems, ...data.items];
        this.state.totalPages = data.total_pages || 1;
        this.state.totalItems = data.total_items || 0;
        this.renderItemsList(data.items, this.state.currentPage > 1);
        this.updateResultCount();
      } else {
        // Handle empty response or error
        if (this.state.currentPage === 1) {
          this.renderItemsList([], false);
        }
        App.showNotification('Failed to load inventory items. Please try again.', 'error');
      }
    } catch (error) {
      console.error('Error fetching items:', error);
      App.showNotification('Network error loading inventory. Please check your connection.', 'error');
      if (this.state.currentPage === 1) {
        this.renderItemsList([], false);
      }
    } finally {
      this.state.isLoading = false;
    }
  },

  renderItemsList(items, append = false) {
    if (!this.elements.inventoryTableBody) return;

    this.elements.inventoryTableBody.querySelector(".loading-row")?.remove();

    if (!append && items.length === 0) {
      const message = this.state.totalItems > 0 ? "No items match your search." : 'No items found. Click "Add New Item" to get started!';
      this.elements.inventoryTableBody.innerHTML = `<tr><td colspan="10" class="text-center p-8">${message}</td></tr>`;
      return;
    }

    const itemsHtml = items.map((item) => this.createItemRowHtml(item)).join("");
    if (append) {
      this.elements.inventoryTableBody.insertAdjacentHTML("beforeend", itemsHtml);
    } else {
      this.elements.inventoryTableBody.innerHTML = itemsHtml;
    }
  },

  createItemRowHtml(item) {
    const isChecked = this.state.selectedItems.has(item.id.toString());
    const statusClass = item.has_low_stock_variants ? "low-stock" : "in-stock";
    const statusText = item.has_low_stock_variants ? "Low Stock" : "In Stock";
    return `
      <tr class="item-row" data-item-id="${item.id}" data-item-name="${App.escapeHtml(item.name)}" data-item-description="${App.escapeHtml(item.description || "")}">
        <td><input type="checkbox" class="item-checkbox" data-item-id="${item.id}" ${isChecked ? "checked" : ""}></td>
        <td><button class="expand-btn" title="View Variants" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"></polyline></svg></button></td>
        <td><img src="/static/${item.image_path || "uploads/placeholder.png"}" alt="${App.escapeHtml(item.name)}" class="item-image-thumbnail"></td>
        <td data-label="Item Name" class="item-name-cell"><span title="${App.escapeHtml(item.description || "No description")}">${App.escapeHtml(item.name)}</span></td>
        <td data-label="Model">${App.escapeHtml(item.model || "--")}</td>
        <td data-label="Variation">${App.escapeHtml(item.variation || "--")}</td>
        <td data-label="Variants">${item.variant_count}</td>
        <td data-label="Total Stock" class="total-stock-cell">${item.total_stock}</td>
        <td data-label="Status" class="status-col"><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td data-label="Actions" class="actions-cell">
          <button class="button create edit-item" title="Edit Item">Edit</button>
          <button class="button cancel delete-item" title="Delete Item">Delete</button>
        </td>
      </tr>
      <tr class="variant-details-row" style="display: none;"><td colspan="10" class="variant-details-container"></td></tr>
    `;
  },

  updateResultCount() {
    const resultCountEl = document.getElementById("search-result-count");
    if (resultCountEl) {
      resultCountEl.textContent = `Showing ${this.state.allItems.length} of ${this.state.totalItems} items`;
    }
  },

  handleScroll() {
    if (this.state.isLoading || this.state.currentPage >= this.state.totalPages) return;
    const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      this.state.currentPage++;
      this.fetchItems();
    }
  },

  handleSearch(searchTerm) {
    this.state.currentPage = 1;
    this.elements.inventoryTableBody.innerHTML = ""; // Clear existing items
    this.fetchItems();
  },

  clearSearch() {
    this.elements.inventorySearch.value = "";
    this.handleSearch("");
    this.elements.inventorySearch.focus();
  },

  /**
   * Handles click actions on item table rows (expand, edit, delete)
   * @param {Event} e - Click event
   */
  async handleTableActions(e) {
    const button = e.target.closest("button");
    if (!button) return;
    
    const row = button.closest(".item-row");
    if (!row) return;
    
    // Fixed: Use 'row' instead of undefined 'itemRow'
    const itemId = row.dataset.itemId;
    const itemName = row.dataset.itemName;

    if (button.classList.contains("expand-btn")) {
      await this.toggleVariantDetails(row, button, itemId);
    } else if (button.classList.contains("edit-item")) {
      window.location.href = `/edit_item/${itemId}`;
    } else if (button.classList.contains("delete-item")) {
      this.deleteItem(itemId, itemName);
    }
  },

  async handleVariantMatrixActions(e) {
    const button = e.target.closest("button");
    if (!button) return;

    const variantRow = button.closest("tr[data-variant-id]");
    if (!variantRow) return; // Exit if not a variant action

    const variantId = variantRow.dataset.variantId;

    if (button.classList.contains("update-variant")) {
      const stockInput = variantRow.querySelector(".stock-input");
      const thresholdInput = variantRow.querySelector(".threshold-input");
      await this.handleVariantUpdate(variantId, stockInput.value, thresholdInput.value);
    } else if (button.classList.contains("delete-variant")) {
      await this.handleVariantDelete(variantId, variantRow);
    }
  },

  /**
   * Updates variant stock and threshold values
   * Calls both endpoints in parallel for efficiency
   * @param {string|number} variantId - The variant ID
   * @param {string|number} stock - The new stock value
   * @param {string|number} threshold - The new threshold value
   */
  async handleVariantUpdate(variantId, stock, threshold) {
    // Validate inputs
    const stockValue = parseInt(stock, 10);
    const thresholdValue = parseInt(threshold, 10);
    
    if (isNaN(stockValue) || stockValue < 0) {
      App.showNotification("Invalid stock value. Must be a positive number.", "error");
      return;
    }
    
    if (isNaN(thresholdValue) || thresholdValue < 0) {
      App.showNotification("Invalid threshold value. Must be a positive number.", "error");
      return;
    }

    try {
      // Call both endpoints in parallel for better performance
      const stockUpdatePromise = App.fetchJson(`${App.config.apiBase}/variants/${variantId}/stock`, {
        method: "PUT",
        body: JSON.stringify({ stock: stockValue }),
      });
      const thresholdUpdatePromise = App.fetchJson(`${App.config.apiBase}/variants/${variantId}/threshold`, {
        method: "PUT",
        body: JSON.stringify({ threshold: thresholdValue }),
      });

      const [stockResult, thresholdResult] = await Promise.all([stockUpdatePromise, thresholdUpdatePromise]);

      if (stockResult && thresholdResult) {
        App.showNotification("Variant updated successfully.", "success");
        
        // Update the total stock in the parent item row without full page refresh
        if (stockResult.new_total_stock !== undefined) {
          const itemRow = document.querySelector(`.item-row[data-item-id="${stockResult.item_id}"]`);
          if (itemRow) {
            const totalStockCell = itemRow.querySelector('.total-stock-cell');
            if (totalStockCell) {
              totalStockCell.textContent = stockResult.new_total_stock;
            }
          }
        }
      } else {
        App.showNotification("Failed to update variant. Please try again.", "error");
      }
    } catch (error) {
      console.error('Error updating variant:', error);
      App.showNotification("Network error updating variant.", "error");
    }
  },

  async handleVariantDelete(variantId, variantRow) {
    if (!confirm("Are you sure you want to delete this variant? This action cannot be undone.")) {
      return;
    }

    const result = await App.fetchJson(`${App.config.apiBase}/variants/${variantId}`, {
      method: "DELETE",
    });

    if (result) {
      variantRow.remove();
      App.showNotification("Variant deleted successfully.", "success");
    } else {
      App.showNotification("Failed to delete variant. It might be in use.", "error");
    }
  },

  /**
   * Toggles the visibility of variant details for an item
   * Fetches and displays variant matrix on first expand
   * @param {HTMLElement} itemRow - The item row element
   * @param {HTMLElement} expandBtn - The expand button
   * @param {string|number} itemId - The item ID
   */
  async toggleVariantDetails(itemRow, expandBtn, itemId) {
    const detailsRow = itemRow.nextElementSibling;
    const isVisible = detailsRow.style.display !== "none";

    // Collapse if already visible
    if (isVisible) {
      detailsRow.style.display = "none";
      expandBtn.classList.remove("expanded");
      expandBtn.setAttribute("aria-expanded", "false");
      return;
    }

    // Show loading state
    const container = detailsRow.querySelector(".variant-details-container");
    container.innerHTML = `<div class="p-4 text-center loading-spinner">
      <div class="spinner"></div>
      <span>Loading variants...</span>
    </div>`;
    detailsRow.style.display = "table-row";
    expandBtn.classList.add("expanded");
    expandBtn.setAttribute("aria-expanded", "true");

    // Fetch variants with error handling
    try {
      const variants = await App.fetchJson(`${App.config.apiBase}/items/${itemId}/variants`);
      
      requestAnimationFrame(() => {
        container.innerHTML = "";
        
        // Display item description if available
        if (itemRow.dataset.itemDescription) {
          container.innerHTML += `<div class="item-description-detail"><strong>Description:</strong> ${App.escapeHtml(itemRow.dataset.itemDescription)}</div>`;
        }
        
        // Render variants or show empty state
        if (variants && variants.length > 0) {
          this.renderVariantMatrix(container, variants);
        } else if (variants) {
          container.innerHTML += `<p class="p-4 text-center">No variants found for this item.</p>`;
        } else {
          // Error case
          container.innerHTML += `<p class="p-4 text-center" style="color: var(--danger-color);">Failed to load variants. Please try again.</p>`;
        }
      });
    } catch (error) {
      console.error('Error loading variants:', error);
      container.innerHTML = `<p class="p-4 text-center" style="color: var(--danger-color);">Network error loading variants.</p>`;
    }
  },

  renderVariantMatrix(container, variants) {
    const table = document.createElement("table");
    table.className = "variant-matrix-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Color</th>
          <th>Size</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Unit</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${variants
          .map(
            (v) => `
          <tr data-variant-id="${v.id}">
            <td>${App.escapeHtml(v.color.name)}</td>
            <td>${App.escapeHtml(v.size.name)}</td>
            <td><input type="number" class="stock-input" value="${
              v.opening_stock
            }" min="0"></td>
            <td><input type="number" class="threshold-input" value="${
              v.threshold
            }" min="0"></td>
            <td>${App.escapeHtml(v.unit || "N/A")}</td>
            <td class="actions-cell">
              <button class="button-icon update-variant" title="Save Changes"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
              <button class="button-icon delete-variant" title="Delete Variant"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    `;
    container.appendChild(table);
  },

  updateBulkActionsVisibility() {
    const bulkActionsBar = document.getElementById("bulk-actions-bar");
    const selectedCount = document.getElementById("selected-item-count");
    if (!bulkActionsBar || !selectedCount) return;

    const count = this.state.selectedItems.size;
    if (count > 0) {
      bulkActionsBar.classList.add("visible");
      selectedCount.textContent = `${count} item${count > 1 ? 's' : ''} selected`;
    } else {
      bulkActionsBar.classList.remove("visible");
    }
  },

  toggleSelectAll(isChecked) {
    const checkboxes = this.elements.inventoryTableBody.querySelectorAll(".item-checkbox");
    checkboxes.forEach(checkbox => {
      checkbox.checked = isChecked;
      const itemId = checkbox.dataset.itemId;
      if (isChecked) {
        this.state.selectedItems.add(itemId);
      } else {
        this.state.selectedItems.delete(itemId);
      }
    });
    this.updateBulkActionsVisibility();
  },

  async handleBulkDelete() {
    const count = this.state.selectedItems.size;
    if (count === 0) return;

    if (!confirm(`Are you sure you want to delete ${count} selected item(s)? This action cannot be undone.`)) {
      return;
    }

    const itemIds = Array.from(this.state.selectedItems);
    const result = await App.fetchJson(`${App.config.apiBase}/items/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ item_ids: itemIds }),
    });

    if (result) {
      itemIds.forEach(id => {
        const row = document.querySelector(`.item-row[data-item-id="${id}"]`);
        if (row) {
          row.nextElementSibling?.remove();
          row.remove();
        }
      });
      this.state.selectedItems.clear();
      this.updateBulkActionsVisibility();
      App.showNotification(result.message || "Items deleted successfully.", "success");
    } else {
      App.showNotification("Failed to delete some items. They may be in use.", "error");
    }
  },

  async handleItemFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const itemId = form.dataset.itemId;
    const url = itemId ? `${App.config.apiBase}/items/${itemId}` : `${App.config.apiBase}/items`;
    const method = itemId ? "PUT" : "POST";

    const formData = new FormData(form);
    const variants = [];
    this.elements.variantsListContainer.querySelectorAll("tr").forEach(row => {
        variants.push({
            id: row.dataset.variantId || null,
            color: row.querySelector('input[name="color"]').value,
            size: row.querySelector('input[name="size"]').value,
            opening_stock: row.querySelector('input[name="opening_stock"]').value || 0,
            threshold: row.querySelector('input[name="threshold"]').value || 5,
            unit: row.querySelector('input[name="unit"]').value || 'Pcs',
        });
    });

    formData.append("variants", JSON.stringify(variants));
    
    // For PUT requests, FormData doesn't work as expected with Flask/Werkzeug for file uploads + other data.
    // A common workaround is to use POST and add a method override field, but the backend is already set up for PUT.
    // The backend handles multipart form data correctly on PUT, so we can proceed.

    const response = await App.fetchJson(url, {
      method: method,
      body: formData,
      headers: {
        // Let the browser set the Content-Type for FormData
      },
    });

    if (response) {
      App.showNotification(`Item ${itemId ? 'updated' : 'added'} successfully!`, "success");
      window.location.href = "/inventory";
    } else {
      App.showNotification("Failed to save item.", "error");
    }
  },
  addVariantRow(variant = {}) {
    const newRow = document.createElement("tr");
    if(variant.id) {
        newRow.dataset.variantId = variant.id;
    }
    newRow.innerHTML = `
      <td><input type="text" name="color" class="form-control" value="${App.escapeHtml(variant.color?.name || '')}" required></td>
      <td><input type="text" name="size" class="form-control" value="${App.escapeHtml(variant.size?.name || '')}" required></td>
      <td><input type="number" name="opening_stock" class="form-control" value="${variant.opening_stock || 0}" min="0"></td>
      <td><input type="number" name="threshold" class="form-control" value="${variant.threshold || 5}" min="0"></td>
      <td><input type="text" name="unit" class="form-control" value="${App.escapeHtml(variant.unit || 'Pcs')}"></td>
      <td><button type="button" class="button cancel small remove-variant-btn">Remove</button></td>
    `;
    this.elements.variantsListContainer.appendChild(newRow);
    this.updateVariantPlaceholder();
  },
  updateVariantPlaceholder() {
    const placeholder = document.getElementById("variants-placeholder");
    if (placeholder) {
      placeholder.style.display = this.elements.variantsListContainer.children.length > 0 ? "none" : "table-row";
    }
  },
  async deleteItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"? This will also delete all its variants and cannot be undone.`)) {
      return;
    }

    const result = await App.fetchJson(`${App.config.apiBase}/items/${itemId}`, {
      method: "DELETE",
    });

    if (result) {
      const row = document.querySelector(`.item-row[data-item-id="${itemId}"]`);
      if (row) {
        row.nextElementSibling.remove(); // Remove variant details row
        row.remove(); // Remove item row
      }
      App.showNotification("Item deleted successfully.", "success");
    } else {
      App.showNotification("Failed to delete item. It might be associated with purchase orders or stock entries.", "error");
    }
  },

  async showLowStockReport() {
    const reportModal = document.getElementById("low-stock-report-modal");
    const reportBody = document.getElementById("low-stock-report-body");
    if (!reportModal || !reportBody) return;

    reportBody.innerHTML = '<tr><td colspan="5" class="text-center">Loading report...</td></tr>';
    reportModal.classList.add("is-open");

    const data = await App.fetchJson(`${App.config.apiBase}/low-stock-report`);
    if (data) {
      if (data.length === 0) {
        reportBody.innerHTML = '<tr><td colspan="5" class="text-center">No items are low on stock.</td></tr>';
        return;
      }
      reportBody.innerHTML = data.map(item => `
        <tr>
          <td>${App.escapeHtml(item.item_name)}</td>
          <td>${App.escapeHtml(item.model_name || '--')} / ${App.escapeHtml(item.variation_name || '--')}</td>
          <td>${App.escapeHtml(item.color_name)} / ${App.escapeHtml(item.size_name)}</td>
          <td>${item.opening_stock}</td>
          <td>${item.threshold}</td>
        </tr>
      `).join('');
    } else {
      reportBody.innerHTML = '<tr><td colspan="5" class="text-center">Failed to load report.</td></tr>';
    }
  },

  exportInventoryToCSV() {
    window.location.href = `${App.config.apiBase}/inventory/export/csv`;
  },
};

document.addEventListener("DOMContentLoaded", () => Inventory.init());
