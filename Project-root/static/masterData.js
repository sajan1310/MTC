"use strict";

const MasterData = {
  state: {
    colors: [],
    sizes: [],
    models: [],
    variations: [],
  },
  elements: {},

  init() {
    if (!document.querySelector(".master-data-grid")) return;
    console.log("MasterData module initialized.");

    this.cacheDOMElements();
    this.bindEventListeners();
    this.fetchAllMasterData();
  },

  cacheDOMElements() {
    this.elements.colorList = document.getElementById("color-list");
    this.elements.sizeList = document.getElementById("size-list");
    this.elements.modelList = document.getElementById("model-list");
    this.elements.variationList = document.getElementById("variation-list");

    this.elements.addColorForm = document.getElementById("add-color-form");
    this.elements.addSizeForm = document.getElementById("add-size-form");
    this.elements.addModelForm = document.getElementById("add-model-form");
    this.elements.addVariationForm = document.getElementById("add-variation-form");
  },

  bindEventListeners() {
    const forms = [
      { form: this.elements.addColorForm, type: "color" },
      { form: this.elements.addSizeForm, type: "size" },
      { form: this.elements.addModelForm, type: "model" },
      { form: this.elements.addVariationForm, type: "variation" },
    ];
    forms.forEach(({ form, type }) => {
      form?.addEventListener("submit", (e) => this.handleMasterAdd(e, type));
    });

    const lists = [
      { list: this.elements.colorList, type: "color" },
      { list: this.elements.sizeList, type: "size" },
      { list: this.elements.modelList, type: "model" },
      { list: this.elements.variationList, type: "variation" },
    ];
    lists.forEach(({ list, type }) => {
      list?.addEventListener("click", (e) => this.handleMasterActions(e, type));
    });
  },

  /**
   * Fetches all master data (colors, sizes, models, variations) in parallel
   * Handles errors gracefully for each data type
   */
  async fetchAllMasterData() {
    const types = ["colors", "sizes", "models", "variations"];
    
    try {
      const promises = types.map(type => 
        App.fetchJson(`${App.config.apiBase}/${type}`)
          .then(data => ({ type, data, error: null }))
          .catch(error => ({ type, data: null, error }))
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(({ type, data, error }) => {
        if (data && Array.isArray(data)) {
          this.state[type] = data;
          this.renderList(type.slice(0, -1)); // 'colors' -> 'color'
        } else {
          // Initialize empty array on error
          this.state[type] = [];
          this.renderList(type.slice(0, -1));
          
          if (error) {
            console.error(`Error fetching ${type}:`, error);
          }
        }
      });
      
      // Check if all requests failed
      const allFailed = results.every(r => !r.data);
      if (allFailed) {
        App.showNotification('Failed to load master data. Please refresh the page.', 'error');
      }
    } catch (error) {
      console.error('Critical error fetching master data:', error);
      App.showNotification('Network error loading master data.', 'error');
    }
  },

  /**
   * Renders a master data list (colors, sizes, models, or variations)
   * Shows appropriate empty state when list has no items
   * @param {string} type - The type of master data ('color', 'size', 'model', or 'variation')
   */
  renderList(type) {
    const listEl = this.elements[`${type}List`];
    const data = this.state[`${type}s`];
    
    if (!listEl) {
      console.warn(`List element for ${type} not found`);
      return;
    }

    if (!data || data.length === 0) {
      listEl.innerHTML = `
        <li class="empty-state">
          <span style="color: var(--subtle-text-color);">No ${type}s added yet. Add one using the form above.</span>
        </li>
      `;
      return;
    }

    listEl.innerHTML = data.map(item => `
      <li data-id="${item.id}" data-name="${App.escapeHtml(item.name)}">
        <span>${App.escapeHtml(item.name)}</span>
        <div class="actions">
          <button class="button-icon edit-btn" title="Edit ${type}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
          <button class="button-icon delete-btn" title="Delete ${type}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
        </div>
      </li>
    `).join("");
  },

  async handleMasterAdd(e, type) {
    e.preventDefault();
    const form = e.target;
    const input = form.querySelector('input[type="text"]');
    const name = input.value.trim();
    if (!name) return;

    const result = await App.fetchJson(`${App.config.apiBase}/${type}s`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });

    if (result) {
      this.state[`${type}s`].push(result);
      this.renderList(type);
      input.value = "";
      App.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} added.`, "success");
    }
  },

  handleMasterActions(e, type) {
    const button = e.target.closest("button");
    if (!button) return;

    const li = button.closest("li");
    const id = li.dataset.id;
    const name = li.dataset.name;

    if (button.classList.contains("edit-btn")) {
      this.handleMasterEdit(li, id, name, type);
    } else if (button.classList.contains("delete-btn")) {
      this.handleMasterDelete(id, name, type);
    }
  },

  handleMasterEdit(li, id, currentName, type) {
    const newName = prompt(`Edit ${type} name:`, currentName);
    if (newName && newName.trim() !== currentName) {
      this.updateMasterItem(id, newName.trim(), type);
    }
  },

  async updateMasterItem(id, name, type) {
    const result = await App.fetchJson(`${App.config.apiBase}/${type}s/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });

    if (result) {
      const itemIndex = this.state[`${type}s`].findIndex(item => item.id == id);
      if (itemIndex > -1) {
        this.state[`${type}s`][itemIndex].name = name;
      }
      this.renderList(type);
      App.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} updated.`, "success");
    }
  },

  /**
   * Handles deletion of a master data item
   * Checks for dependencies before allowing deletion
   * @param {string|number} id - The item ID
   * @param {string} name - The item name (for confirmation)
   * @param {string} type - The data type ('color', 'size', 'model', or 'variation')
   */
  async handleMasterDelete(id, name, type) {
    try {
      // Check for dependencies before deleting
      const dependencyResult = await App.fetchJson(`${App.config.apiBase}/${type}s/${id}/dependencies`);
      
      if (dependencyResult && dependencyResult.count > 0) {
        App.showNotification(
          `Cannot delete "${name}" because it is currently used by ${dependencyResult.count} item(s).`,
          'error'
        );
        return;
      }

      // Confirm deletion
      if (!confirm(`Are you sure you want to delete "${name}"? This action cannot be undone.`)) {
        return;
      }

      // Perform deletion
      const result = await App.fetchJson(`${App.config.apiBase}/${type}s/${id}`, {
        method: "DELETE",
      });

      if (result) {
        // Remove from state and re-render
        this.state[`${type}s`] = this.state[`${type}s`].filter(item => item.id != id);
        this.renderList(type);
        App.showNotification(
          `${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully.`, 
          "success"
        );
      } else {
        App.showNotification(
          `Failed to delete ${type}. It may be in use or the server encountered an error.`,
          'error'
        );
      }
    } catch (error) {
      console.error(`Error deleting ${type}:`, error);
      App.showNotification(`Network error deleting ${type}.`, 'error');
    }
  },
};

document.addEventListener("DOMContentLoaded", () => MasterData.init());
