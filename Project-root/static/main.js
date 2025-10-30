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

    // Generic Modal Close
    document.body.addEventListener("click", (e) => {
      if (e.target.matches(".close-modal-btn")) {
        e.target.closest(".modal")?.classList.remove("is-open");
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
