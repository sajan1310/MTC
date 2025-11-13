"use strict";

/**
 * @file Core application logic for the GLASS UI dashboard.
 * @description This file initializes the application, handles global errors,
 *              manages shared state, and provides utility functions.
 * @version 2.0.0
 */

// --- Global Error Handling ---
(function () {
  const sanitizeReason = (reason) => {
    if (!reason) return "Unknown error";
    if (typeof reason === "string") return reason;
    if (reason.message) return reason.message;
    return reason.toString ? reason.toString() : "Unknown error";
  };

  const isExtensionError = (text) =>
    /chrome-extension:\/\/|moz-extension:\/\/|safari-extension:\/\/|extension:\/\//i.test(
      text
    );

  window.addEventListener("unhandledrejection", (ev) => {
    const message = sanitizeReason(ev.reason);
    if (
      message.includes("message channel closed") ||
      message.includes("A listener indicated an asynchronous response")
    ) {
      ev.preventDefault();
      return;
    }
    try {
      const stack = ev.reason?.stack || "";
      if (isExtensionError(stack || message)) return;
      console.error("Unhandled Rejection:", {
        reason: message,
        stack,
        page: location.href,
      });
    } catch (e) {
      console.error("Error reporting unhandled rejection:", e);
    }
  });

  window.addEventListener("error", (ev) => {
    const message = ev.message || "";
    if (
      message.includes("message channel closed") ||
      message.includes("A listener indicated an asynchronous response")
    ) {
      ev.preventDefault();
      return;
    }
    try {
      const originText = (ev.filename || "") + (ev.error?.stack || "");
      if (isExtensionError(originText)) return;
      console.error("Window Error:", {
        message,
        filename: ev.filename,
        lineno: ev.lineno,
        colno: ev.colno,
        error: ev.error?.stack || ev.error?.toString(),
        page: location.href,
      });
    } catch (e) {
      console.error("Error reporting window error:", e);
    }
  });
})();

// --- Core Utilities ---
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

/**
 * Main Application Module
 * @namespace App
 */
const App = {
  // --- State ---
  config: {
    apiBase: "/api", // Use relative path
    pagination: {
      per_page: 50,
    },
  },
  state: {
    // Shared state can be added here if needed
  },
  // --- DOM Element Cache ---
  elements: {},

  /**
   * Initializes the core application.
   */
  init() {
    const onReady = () => {
      this.cacheDOMElements();
      this.bindGlobalEventListeners();
      this.initializeTheme();
      this.setActiveNavItem();
      // Keep aria-hidden in sync for any modal that toggles its visibility via class changes
      try {
        const modalClassObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'class') {
              const target = m.target;
              if (target && target.classList && target.classList.contains('modal')) {
                try {
                  if (target.classList.contains('is-open')) target.setAttribute('aria-hidden', 'false');
                  else target.setAttribute('aria-hidden', 'true');
                } catch (e) {}
              }
            }
          }
        });
        modalClassObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
      } catch (e) {
        // MutationObserver not available or failed, fallback: nothing
        console.warn('Modal aria-hidden sync disabled:', e);
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }
  },

  /**
   * Caches frequently accessed global DOM elements.
   */
  cacheDOMElements() {
    this.elements.sidebarToggle = document.getElementById("sidebar-toggle");
    this.elements.darkModeToggle = document.getElementById("dark-mode-toggle");
  },

  /**
   * Binds global event listeners for the application.
   */
  bindGlobalEventListeners() {
    this.elements.sidebarToggle?.addEventListener("click", () => this.toggleSidebar());
    this.elements.darkModeToggle?.addEventListener("click", () => this.toggleDarkMode());

    // Generic delegated click handler for small, common UI actions.
    // Handles:
    // - .close-modal-btn and .modal-close: close nearest modal (uses shared Modal if available)
    // - .flash-close: remove flash notification
    // - [data-href]: open provided href in a new tab (useful for replacing inline onclicks that call window.open)
    document.body.addEventListener("click", (e) => {
      try {
        const modalClose = e.target.closest('.close-modal-btn, .modal-close');
        if (modalClose) {
          const modal = modalClose.closest('.modal') || document.getElementById(modalClose.getAttribute('data-target'));
          if (modal) {
            try {
              if (window.Modal && typeof window.Modal.close === 'function') {
                window.Modal.close(modal);
              } else {
                modal.classList.remove('is-open');
                try { modal.setAttribute('aria-hidden', 'true'); } catch (err) {}
              }
            } catch (err) {
              try { modal.classList.remove('is-open'); } catch (e) {}
            }
            return;
          }
        }

        const flashClose = e.target.closest('.flash-close');
        if (flashClose) {
          const flash = flashClose.closest('.flash');
          if (flash) flash.remove();
          return;
        }

        const openEl = e.target.closest('[data-href]');
        if (openEl) {
          const href = openEl.getAttribute('data-href');
          if (href) {
            // Open in new tab similar to original inline onclick behavior
            window.open(href, '_blank');
          }
          return;
        }
      } catch (err) {
        // swallow to avoid breaking other click handlers
        console.error('Delegated click handler error', err);
      }
    });
  },

  /**
   * Initializes theme from localStorage.
   */
  initializeTheme() {
    if (localStorage.getItem("theme") === "dark") {
      document.body.classList.add("dark-mode");
    }
    if (localStorage.getItem("sidebarCollapsed") === "true") {
      document.body.classList.add("sidebar-collapsed");
    }
  },

  /**
   * Sets the active navigation item based on the current URL.
   */
  setActiveNavItem() {
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll(".sidebar-nav .nav-item, .sidebar-footer .nav-item");
    let bestMatch = null;

    navLinks.forEach((link) => {
      const href = link.getAttribute("href");
      if (href && currentPath.startsWith(href)) {
        if (!bestMatch || href.length > bestMatch.getAttribute("href").length) {
          bestMatch = link;
        }
      }
    });

    navLinks.forEach((link) => link.classList.remove("active"));
    bestMatch?.classList.add("active");
  },

  // --- UI Actions ---
  toggleSidebar() {
    requestAnimationFrame(() => {
      const isCollapsed = document.body.classList.toggle("sidebar-collapsed");
      localStorage.setItem("sidebarCollapsed", isCollapsed);
    });
  },

  toggleDarkMode() {
    const isDarkMode = document.body.classList.toggle("dark-mode");
    localStorage.setItem("theme", isDarkMode ? "dark" : "light");
  },

  // --- API & Data Fetching ---
  async fetchJson(url, options = {}) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
    if (!csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method?.toUpperCase())) {
      console.warn('⚠️ CSRF token not found - request may fail');
    }

    const headers = {
      Accept: "application/json",
      "X-CSRFToken": csrfToken,
      ...options.headers,
    };

    if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.error('Authentication required - redirecting to login');
          window.location.href = '/login';
          return null;
        }
        const errorData = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(errorData.error || errorData.message);
      }
      return res.status === 204 ? { success: true } : await res.json();
    } catch (err) {
      console.error(`Fetch error for ${url}:`, err);
      this.showNotification(err.message, "error");
      return null;
    }
  },

  // --- Utility Functions ---
  escapeHtml(text) {
    if (text === null || text === undefined) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },

  showNotification(message, type = "success") {
    const container = document.querySelector(".container") || document.body;
    const notification = document.createElement("div");
    notification.className = `flash ${type}`;
    notification.textContent = message;
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.className = "ml-auto p-2";
    closeBtn.onclick = () => notification.remove();
    notification.prepend(closeBtn);
    container.prepend(notification);
    setTimeout(() => notification.remove(), 5000);
  },
};

// --- App Initialization ---
App.init();

// Tab handling: use data-tab attributes instead of inline onclicks.
// Elements: <button class="tab-link" data-tab="TabId">Label</button>
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  const tabName = btn.getAttribute('data-tab');
  if (!tabName) return;
  e.preventDefault();

  // Hide all tab content
  document.querySelectorAll('.tab-content').forEach((c) => {
    try { c.style.display = 'none'; } catch (err) {}
  });

  // Remove active from all tab-link
  document.querySelectorAll('.tab-link').forEach((l) => l.classList.remove('active'));

  // Show the requested tab
  const el = document.getElementById(tabName);
  if (el) try { el.style.display = 'block'; } catch (err) {}

  // Mark clicked button active
  try { btn.classList.add('active'); } catch (err) {}
});

/*
 * Shared Modal helper
 * Usage: Modal.open(domElement)  Modal.close(domElement)
 * Handles aria-hidden, focus restore and a basic focus-trap + Escape close.
 */
window.Modal = (function () {
  const lastFocused = {};

  function findFocusable(modal) {
    return Array.from(
      modal.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(el => !el.hasAttribute('disabled'));
  }

  function keydownHandler(e) {
    const modal = e.currentTarget;
    if (e.key === 'Escape') {
      e.preventDefault();
      try { Modal.close(modal); } catch (err) {}
      return;
    }

    if (e.key === 'Tab') {
      const focusable = findFocusable(modal);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  const Modal = {
    open(modal) {
      if (!modal) return;
      if (!modal.id) modal.id = `modal-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      try { lastFocused[modal.id] = document.activeElement; } catch (e) {}

      modal.classList.add('is-open');
      try { modal.setAttribute('aria-hidden', 'false'); } catch (e) {}

      // attach keydown handler on the modal to trap focus and handle Escape
      modal._modalKeydown = keydownHandler.bind(modal);
      modal.addEventListener('keydown', modal._modalKeydown);

      // focus first focusable element
      requestAnimationFrame(() => {
        try {
          const focusable = findFocusable(modal);
          if (focusable.length) focusable[0].focus();
        } catch (e) {}
      });
    },

    close(modal) {
      if (!modal) return;
      // Remove keydown handler first
      try {
        if (modal._modalKeydown) modal.removeEventListener('keydown', modal._modalKeydown);
        delete modal._modalKeydown;
      } catch (e) {}

      // Try to restore focus to the element that opened the modal BEFORE hiding it.
      try {
        const prev = modal.id ? lastFocused[modal.id] : null;
        if (prev && typeof prev.focus === 'function') prev.focus();
      } catch (e) {}

      // Now hide the modal and mark it as hidden for assistive tech
      try { modal.classList.remove('is-open'); } catch (e) {}
      try { modal.setAttribute('aria-hidden', 'true'); } catch (e) {}

      if (modal.id) delete lastFocused[modal.id];
    }
  };

  return Modal;
})();
