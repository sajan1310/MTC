// Production Lot Detail - Refactored Version (Fixed Element Selectors)
// Enhanced architecture with state management, better error handling, and performance optimizations

(function () {
    'use strict';

    // =========================
    // Configuration & Constants
    // =========================
    const CONFIG = {
        TOAST_DURATION: 4000,
        SPINNER_SIZE: '14px',
        DEBUG: true, // ENABLED for debugging
        RETRY_ATTEMPTS: 2,
        RETRY_DELAY: 1000,
        INIT_RETRY_DELAY: 500,
        MAX_INIT_RETRIES: 5
    };

    const API_PATHS = {
        lot: (id) => `/api/upf/production-lots/${id}`,
        lotDelete: (id) => `/api/upf/production-lots/${id}`,
        lotFinalize: (id) => `/api/upf/production-lots/${id}/finalize`,
        lotRecalc: (id) => `/api/upf/production-lots/${id}/recalculate`,
        subprocesses: (lotId) => `/api/upf/production-lots/${lotId}/subprocesses`,
        // Prefer lot-scoped available subprocesses; fallback remains global list
        availableSubprocesses: (lotId) => `/api/upf/production-lots/${lotId}/available-subprocesses`,
        availableAllSubprocesses: () => `/api/upf/subprocesses?per_page=1000`,
        subprocessVariants: (subprocessId, lotId) => `/api/upf/production-lots/${lotId}/subprocesses/${subprocessId}/variants`,
        // Backend exposes compatibility routes: singular `/subprocess/<id>/variant-options`
        // and legacy `/subprocesses/<id>/variant_options` (underscore). Use the
        // singular hyphenated route to match the Flask blueprint and avoid 404s.
        variantOptions: (subprocessId) => `/api/upf/subprocess/${subprocessId}/variant-options`,
        // Lot-scoped variant/options (returns subprocesses array for a lot)
        lotVariantOptions: (lotId) => `/api/upf/production-lots/${lotId}/variant-options`,
        alerts: (lotId) => `/api/upf/inventory-alerts/lot/${lotId}`,
        alertAck: (alertId) => `/api/upf/inventory-alerts/${alertId}/acknowledge`,
        alertBulkAck: () => `/api/upf/inventory-alerts/bulk-acknowledge`
    };

    // Element selector mapping - MATCHED TO YOUR HTML TEMPLATE
    const SELECTORS = {
        // Lot detail elements - matched to actual HTML IDs
        lotDetailsContent: '#lot-details-content',
        lotStatusBadge: '#lot-status-badge',
        summaryContent: '#summary-content',
        pageTitle: '#page-title',
        
        // Buttons - matched to actual HTML IDs
        editLotBtn: '#edit-lot-btn',
        deleteLotBtn: '#delete-lot-btn',
        finalizeLotBtn: '#finalize-btn',
        refreshVariantOptions: '#refresh-variant-options',
        
        // Modal elements - matched to actual HTML structure
        modalOverlay: '#modal-overlay',
        editLotForm: '#edit-lot-form',
        modalQuantity: '#modal-quantity',
        modalStatus: '#modal-status',
        modalNotes: '#modal-notes',
        modalClose: '#modal-close',
        modalCancel: '#modal-cancel',
        
        // Variant modal - matched to actual HTML
        variantModalOverlay: '#variant-modal-overlay',
        variantModalClose: '#variant-modal-close',
        variantModalCancel: '#variant-modal-cancel',
        addVariantForm: '#add-variant-form',
        variantGroupSelect: '#variant-group-select',
        variantSelect: '#variant-select',
        variantQty: '#variant-qty',
        variantSearch: '#variant-search',
        
        // Edit subprocess modal - matched to actual HTML
        editSubprocessModalOverlay: '#edit-subprocess-modal-overlay',
        editSubprocessModalClose: '#edit-subprocess-modal-close',
        editSubprocessBody: '#edit-subprocess-body',
        editSubprocessCancel: '#edit-subprocess-cancel',
        editSubprocessSave: '#edit-subprocess-save',
        // Recalculate cost button
        recalcCostBtn: '#recalc-cost-btn, .recalc-cost-btn, [data-action="recalc-cost"]',
        
        // Content containers - matched to actual HTML
        subprocessesContent: '#subprocesses-content, .subprocesses-content',
        variantsContent: '#variants-content, .variants-content',
        subprocessSelectForAdd: '#subprocess-select-for-add, #subprocess-select, .subprocess-select, [name="subprocess_id"]',
        headerAddVariantBtn: '#header-add-variant-btn',
        // Add subprocess button (new) - try ID, class, data-action
        addSubprocessBtn: '#add-subprocess-btn, .add-subprocess-btn, [data-action="add-subprocess"]',
        
        // Alert elements - matched to actual HTML
        alertsContent: '#alerts-content, .alerts-content',
        alertsTableContainer: '#alerts-table-container, .alerts-table-container',
        alertsTable: '#alerts-table, .alerts-table',
        alertsTableBody: '#alerts-table-body, tbody.alerts',
        selectAllAlerts: '#select-all-alerts, .select-all-alerts, [data-action="select-all-alerts"]',
        bulkAcknowledgeBtn: '#bulk-acknowledge-btn, .bulk-acknowledge-btn, [data-action="bulk-ack"]',
        alertsCountBadge: '#alerts-count-badge',
        criticalAlertBanner: '#critical-alert-banner',
        // Aliases / additional selectors used by functions
        editSubprocessVariantsModal: '#edit-subprocess-modal-overlay',
        saveSubprocessVariantsBtn: '#edit-subprocess-save',
        variantSelectionContainer: '#edit-subprocess-body',
        bulkAckBtn: '#bulk-acknowledge-btn',
        selectAllAlertsCheckbox: '#select-all-alerts, .select-all-alerts, [data-action="select-all-alerts"]',

        // Lot totals
        lotTotalCost: '#lot-total-cost',
        
        // Procurement panel
        procurementPanel: '#procurement-panel',
        recommendationsContent: '#recommendations-content'
    };

    // Status configuration
    const STATUS_CONFIG = {
        'draft': { label: 'Draft', class: 'status--info' },
        'in_progress': { label: 'In Progress', class: 'status--warning' },
        'completed': { label: 'Completed', class: 'status--success' },
        'cancelled': { label: 'Cancelled', class: 'status--error' }
    };

    const SEVERITY_CONFIG = {
        'CRITICAL': { class: 'status--error' },
        'WARNING': { class: 'status--warning' }
    };

    // =========================
    // Utility Functions
    // =========================

    /**
     * Logger with conditional output
     */
    const logger = {
        debug: (...args) => CONFIG.DEBUG && console.debug('[DEBUG]', ...args),
        info: (...args) => console.info('[INFO]', ...args),
        warn: (...args) => console.warn('[WARN]', ...args),
        error: (...args) => console.error('[ERROR]', ...args)
    };

    /**
     * Find element using multiple selectors
     * @param {string} selectorString - Comma-separated selectors
     * @returns {HTMLElement|null}
     */
    function findElement(selectorString) {
        const selectors = selectorString.split(',').map(s => s.trim());
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                logger.debug(`✅ Found element with selector: ${selector}`);
                return el;
            }
        }
        return null;
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Debounce function calls
     * @param {Function} func
     * @param {number} wait
     * @returns {Function}
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Sleep utility for retries
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // =========================
    // API Service Layer
    // =========================

    class ApiService {
        constructor() {
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
            this.defaultOptions = {
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                }
            };
        }

        /**
         * Enhanced fetch with retry logic and error handling
         * @param {string} url
         * @param {RequestInit} options
         * @param {number} retries
         * @returns {Promise<any>}
         */
        async fetchWithRetry(url, options = {}, retries = CONFIG.RETRY_ATTEMPTS) {
            const mergedOptions = { ...this.defaultOptions, ...options };
            
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    logger.debug(`🌐 API Request [Attempt ${attempt + 1}/${retries + 1}]:`, url);
                    
                    const res = await fetch(url, mergedOptions);

                    logger.debug(`📥 Response status: ${res.status} ${res.statusText}`);

                    // Handle authentication
                    if (res.status === 401) {
                        logger.warn('⚠️ Unauthorized - redirecting to login');
                        window.location.href = '/auth/login';
                        throw new Error('Unauthorized - redirecting to login');
                    }

                    // Handle response
                    if (!res.ok) {
                            // Try to parse JSON error body, otherwise fall back to text
                            let errorBody = null;
                            try {
                                errorBody = await res.json();
                            } catch (jsonErr) {
                                try {
                                    errorBody = await res.text();
                                } catch (txtErr) {
                                    errorBody = '';
                                }
                            }

                            const message = (errorBody && (errorBody.message || typeof errorBody === 'string'))
                                ? (errorBody.message || errorBody)
                                : res.statusText;

                            logger.error(`❌ HTTP Error ${res.status}:`, message, errorBody);

                            const err = new Error(`HTTP ${res.status}: ${message}`);
                            err.status = res.status;
                            err.responseData = errorBody;
                            throw err;
                    }

                    // Parse JSON
                    const contentType = res.headers.get('content-type');
                    
                    if (contentType && contentType.includes('application/json')) {
                        const data = await res.json();
                        logger.debug('✅ API Response data:', data);
                        return data;
                    }

                    const textData = await res.text();
                    logger.debug('✅ API Response (text):', textData);
                    return textData;

                } catch (error) {
                    logger.warn(`⚠️ API attempt ${attempt + 1} failed:`, error.message);
                    
                    // Don't retry on auth errors
                    if (error.message.includes('Unauthorized')) {
                        throw error;
                    }

                    // Retry on network errors or 5xx
                    if (attempt < retries) {
                        const delay = CONFIG.RETRY_DELAY * (attempt + 1);
                        logger.debug(`⏳ Retrying in ${delay}ms...`);
                        await sleep(delay);
                        continue;
                    }

                    logger.error('❌ All retry attempts exhausted');
                    throw error;
                }
            }
        }

        /**
         * GET request
         */
        async get(url) {
            logger.info('GET:', url);
            return this.fetchWithRetry(url, { method: 'GET' });
        }

        /**
         * POST request
         */
        async post(url, body = null) {
            logger.info('POST:', url, body);
            return this.fetchWithRetry(url, {
                method: 'POST',
                body: body ? JSON.stringify(body) : null
            });
        }

        /**
         * PUT request
         */
        async put(url, body = null) {
            logger.info('PUT:', url, body);
            return this.fetchWithRetry(url, {
                method: 'PUT',
                body: body ? JSON.stringify(body) : null
            });
        }

        /**
         * DELETE request
         */
        async delete(url) {
            logger.info('DELETE:', url);
            return this.fetchWithRetry(url, { method: 'DELETE' });
        }
    }

    // =========================
    // State Management
    // =========================

    class StateManager {
        constructor() {
            this.state = {
                lotId: null,
                lot: null,
                subprocesses: [],
                alerts: [],
                variantOptionsCache: {},
                ui: {
                    loading: false,
                    error: null,
                    editingLot: false,
                    editingSubprocess: null
                }
            };
            this.listeners = [];
        }

        /**
         * Get current state
         */
        getState() {
            return { ...this.state };
        }

        /**
         * Update state and notify listeners
         * @param {Object} updates
         */
        setState(updates) {
            const prevState = this.getState();
            this.state = this._deepMerge(this.state, updates);
            
            logger.debug('🔄 State updated:', updates);
            
            // Notify all listeners
            this.listeners.forEach(listener => {
                listener(this.state, prevState);
            });
        }

        /**
         * Subscribe to state changes
         * @param {Function} listener
         * @returns {Function} unsubscribe function
         */
        subscribe(listener) {
            this.listeners.push(listener);
            return () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            };
        }

        /**
         * Deep merge objects
         */
        _deepMerge(target, source) {
            const output = { ...target };
            
            if (this._isObject(target) && this._isObject(source)) {
                Object.keys(source).forEach(key => {
                    if (this._isObject(source[key])) {
                        if (!(key in target)) {
                            Object.assign(output, { [key]: source[key] });
                        } else {
                            output[key] = this._deepMerge(target[key], source[key]);
                        }
                    } else {
                        Object.assign(output, { [key]: source[key] });
                    }
                });
            }
            
            return output;
        }

        _isObject(item) {
            return item && typeof item === 'object' && !Array.isArray(item);
        }
    }

    // =========================
    // Toast Notification Service
    // =========================

    class ToastService {
        /**
         * Show toast notification
         * @param {string} message
         * @param {string} type - 'success' | 'error' | 'info' | 'warning'
         */
        show(message, type = 'info') {
            logger.debug(`🔔 Toast [${type}]:`, message);
            
            const toast = document.createElement('div');
            toast.className = `toast toast--${type}`;
            toast.textContent = message;
            toast.setAttribute('role', 'alert');
            toast.setAttribute('aria-live', 'polite');

            // Add basic inline styles if CSS not loaded
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 20px;
                background: ${type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#0891b2'};
                color: white;
                border-radius: 8px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                z-index: 10000;
                opacity: 0;
                transition: opacity 0.3s;
                max-width: 400px;
                font-size: 14px;
            `;

            document.body.appendChild(toast);

            // Trigger reflow for animation
            void toast.offsetWidth;
            toast.style.opacity = '1';

            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 300);
            }, CONFIG.TOAST_DURATION);
        }

        success(message) {
            this.show(message, 'success');
        }

        error(message) {
            this.show(message, 'error');
        }

        info(message) {
            this.show(message, 'info');
        }

        warning(message) {
            this.show(message, 'warning');
        }
    }

    // =========================
    // Modal Service
    // =========================

    class ModalService {
        constructor() {
            this.activeModal = null;
            this.setupKeyboardHandler();
        }

        /**
         * Setup global keyboard handler for ESC key
         */
        setupKeyboardHandler() {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.activeModal) {
                    logger.debug('⌨️ ESC pressed - closing modal:', this.activeModal);
                    this.close(this.activeModal);
                }
            });
        }

        /**
         * Open modal by selector
         * @param {string} selectorString
         */
        open(selectorString) {
            logger.info('🔓 Opening modal:', selectorString);
            const modalOverlay = findElement(selectorString);
            if (!modalOverlay) {
                logger.error('❌ Modal overlay element not found:', selectorString);
                return;
            }

            logger.debug('📦 Modal overlay found:', modalOverlay);
            logger.debug('📏 Modal overlay current display:', modalOverlay.style.display);

            // Set overlay to flex
            modalOverlay.style.display = 'flex';
            modalOverlay.classList.add('modal--show');
            modalOverlay.setAttribute('aria-hidden', 'false');
            
            // CRITICAL: Also set the inner .modal div to display:flex
            // because base CSS has .modal { display: none }
            const innerModal = modalOverlay.querySelector('.modal');
            if (innerModal) {
                logger.debug('📦 Inner modal found, setting display:flex');
                innerModal.style.display = 'flex';
                innerModal.style.flexDirection = 'column';
            } else {
                logger.warn('⚠️ No inner .modal element found inside overlay');
            }
            
            this.activeModal = selectorString;
            
            logger.debug('✅ Modal opened - overlay display now:', modalOverlay.style.display);

            // Focus first focusable element
            const focusable = modalOverlay.querySelector('input, button, select, textarea');
            if (focusable) {
                setTimeout(() => focusable.focus(), 100);
            }
        }

        /**
         * Close modal
         * @param {string} selectorString
         */
        close(selectorString) {
            logger.debug('🔒 Closing modal:', selectorString);
            const modalOverlay = findElement(selectorString);
            if (!modalOverlay) return;

            // Remove display and overlay classes
            modalOverlay.style.display = 'none';
            modalOverlay.classList.remove('modal--show');
            modalOverlay.setAttribute('aria-hidden', 'true');
            
            // Also hide inner modal
            const innerModal = modalOverlay.querySelector('.modal');
            if (innerModal) {
                innerModal.style.display = 'none';
            }
            
            if (this.activeModal === selectorString) {
                this.activeModal = null;
            }
        }
    }

    // =========================
    // Spinner Service
    // =========================

    class SpinnerService {
        /**
         * Create spinner element
         * @param {string} size
         * @returns {HTMLElement}
         */
        create(size = CONFIG.SPINNER_SIZE) {
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            spinner.style.cssText = `
                display: inline-block;
                width: ${size};
                height: ${size};
                border: 2px solid rgba(0,0,0,0.1);
                border-top: 2px solid #3498db;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            `;
            spinner.setAttribute('role', 'status');
            spinner.setAttribute('aria-label', 'Loading');
            
            return spinner;
        }

        /**
         * Show spinner in button
         * @param {HTMLButtonElement} button
         */
        showInButton(button) {
            if (!button) {
                logger.warn('⚠️ showInButton: button is null');
                return;
            }
            
            logger.debug('⏳ Showing spinner in button');
            button.disabled = true;
            button.dataset.originalContent = button.innerHTML;
            button.innerHTML = '';
            button.appendChild(this.create());
        }

        /**
         * Hide spinner and restore button
         * @param {HTMLButtonElement} button
         */
        hideInButton(button) {
            if (!button || !button.dataset.originalContent) {
                logger.warn('⚠️ hideInButton: button is null or no original content');
                return;
            }
            
            logger.debug('✅ Hiding spinner in button');
            button.innerHTML = button.dataset.originalContent;
            delete button.dataset.originalContent;
            button.disabled = false;
        }
    }

    // =========================
    // Main Application Controller
    // =========================

    class ProductionLotDetailController {
        constructor() {
            this.api = new ApiService();
            this.state = new StateManager();
            this.toast = new ToastService();
            this.modal = new ModalService();
            this.spinner = new SpinnerService();
            
            this.abortController = null;
            this.eventHandlers = new Map();
        }

        /**
         * Initialize the application with retry logic
         */
        async init() {
            logger.info('🚀 ProductionLotDetailController.init - starting');
            logger.debug('📍 Current URL:', window.location.href);
            logger.debug('🔍 window.LOT_ID:', window.LOT_ID);

            // Wait for DOM to be fully ready
            await this._waitForDOM();

            try {
                // Get lot ID from multiple sources
                const lotId = this._getLotId();
                logger.debug('🆔 Resolved lot ID:', lotId);
                
                if (!lotId) {
                    throw new Error('Production lot ID not found. Please ensure LOT_ID is set in the page.');
                }

                this.state.setState({ lotId });

                // Load available subprocess options (populates subprocess select)
                await this._loadAvailableSubprocesses();

                // Setup event listeners
                this._setupEventListeners();

                // Load initial data
                await this._loadAllData();

                logger.info('✅ ProductionLotDetailController initialized successfully');

            } catch (error) {
                logger.error('❌ Initialization error:', error);
                this.toast.error(`Failed to initialize: ${error.message}`);
                this.state.setState({ 
                    ui: { error: error.message, loading: false } 
                });
            }
        }

        /**
         * Wait for DOM to be fully loaded
         */
        async _waitForDOM() {
            if (document.readyState === 'complete') {
                logger.debug('✅ DOM already complete');
                return;
            }

            logger.debug('⏳ Waiting for DOM to be ready...');
            
            return new Promise((resolve) => {
                if (document.readyState === 'complete') {
                    resolve();
                } else {
                    window.addEventListener('load', resolve, { once: true });
                }
            });
        }

        /**
         * Get lot ID from multiple sources
         */
        _getLotId() {
            const sources = {
                'window.LOT_ID': window.LOT_ID,
                'URL query param': new URLSearchParams(window.location.search).get('id'),
                'body data attribute': document.body.dataset.lotId,
                'URL path segment': this._extractLotIdFromPath()
            };
            
            logger.debug('🔍 Checking lot ID sources:', sources);
            
            // Try each source in priority order
            return sources['window.LOT_ID'] 
                || sources['URL query param']
                || sources['body data attribute']
                || sources['URL path segment']
                || null;
        }

        /**
         * Extract lot ID from URL path
         */
        _extractLotIdFromPath() {
            const pathParts = window.location.pathname.split('/').filter(Boolean);
            // Look for numeric ID after 'production-lots' or similar
            const lotIndex = pathParts.findIndex(part => 
                part.includes('lot') || part.includes('production')
            );
            
            if (lotIndex !== -1 && pathParts[lotIndex + 1]) {
                const potentialId = pathParts[lotIndex + 1];
                return /^\d+$/.test(potentialId) ? potentialId : null;
            }
            
            // Fallback: return last numeric segment
            const lastNumeric = pathParts.reverse().find(part => /^\d+$/.test(part));
            return lastNumeric || null;
        }

        /**
         * Load all data for the page
         */
        async _loadAllData() {
            logger.info('📥 Loading all data...');
            this.state.setState({ ui: { loading: true, error: null } });

            try {
                const { lotId } = this.state.getState();
                logger.debug('🆔 Loading data for lot ID:', lotId);

                const lotUrl = API_PATHS.lot(lotId);
                const alertsUrl = API_PATHS.alerts(lotId);
                
                logger.debug('🌐 Fetching from URLs:', { lotUrl, alertsUrl });

                // Load data in parallel
                const [lotData, alertsData] = await Promise.all([
                    this.api.get(lotUrl),
                    this.api.get(alertsUrl).catch(err => {
                        logger.warn('⚠️ Failed to load alerts (non-critical):', err.message);
                        return { alert_details: [] };
                    })
                ]);

                logger.debug('📦 Raw lot data:', lotData);
                logger.debug('📦 Raw alerts data:', alertsData);

                // Extract data from response envelopes
                const lot = lotData.data || lotData;
                
                // Initialize subprocesses array if not present
                if (!lot.subprocesses) {
                    lot.subprocesses = [];
                }

                // Load lot-linked subprocesses (new endpoint)
                try {
                    const subsResp = await this.api.get(API_PATHS.subprocesses(lotId));
                    logger.debug('📦 Raw subprocesses response:', subsResp);
                    const subsBody = (subsResp && (subsResp.data || subsResp)) || subsResp || {};
                    const subsList = subsBody.subprocesses || (Array.isArray(subsBody) ? subsBody : []);
                    logger.debug('📋 Parsed subprocesses list:', subsList);
                    if (Array.isArray(subsList) && subsList.length) {
                        lot.subprocesses = subsList;
                        logger.info(`✅ Loaded ${subsList.length} subprocesses from API`);
                    } else {
                        logger.debug('ℹ️ No subprocesses returned from API');
                    }
                } catch (subsErr) {
                    logger.warn('⚠️ Failed to load lot subprocesses:', subsErr.message || subsErr);
                }
                // Attempt to load lot-scoped subprocesses (variant-options) so we can render subprocess cards
                try {
                    const vo = await this.api.get(API_PATHS.lotVariantOptions(lotId));
                    logger.debug('📦 Raw variant-options response:', vo);
                    const voBody = (vo && (vo.data || vo)) || vo || {};
                    const voSubs = Array.isArray(voBody?.subprocesses) ? voBody.subprocesses : [];
                    logger.debug('📋 Parsed variant-options subprocesses:', voSubs);

                    // If the lot payload is missing quantity, backfill from variant-options response or default to 1
                    if (lot.quantity == null || lot.quantity === '') {
                        lot.quantity = voBody.quantity ?? 1;
                    }

                    // Prime the variant options cache so Edit Variants does not refetch
                    const { variantOptionsCache } = this.state.getState();
                    const cacheUpdates = {};

                    // Helper: flatten grouped/standalone variants into a single list with quantity/sku/name
                    const flattenVariants = (vsp) => {
                        const items = [];
                        const grouped = vsp.grouped_variants || {};
                        Object.keys(grouped).forEach(gid => {
                            const arr = grouped[gid] || [];
                            arr.forEach(v => items.push({ ...v }));
                        });
                        (vsp.standalone_variants || []).forEach(v => items.push({ ...v }));
                        return items.map(v => ({
                            variant_id: v.variant_id,
                            variant_name: v.variant_name || v.item_number || v.description || v.full_name || `Variant #${v.variant_id || ''}`,
                            variant_sku: v.variant_sku || v.sku || '',
                            quantity: v.quantity ?? v.variant_quantity ?? v.qty ?? null
                        }));
                    };

                    if (voSubs.length) {
                        // Merge variant-option details into existing subprocesses when possible
                        const subsById = (lot.subprocesses || []).reduce((acc, sp) => {
                            const key = sp.process_subprocess_id || sp.id || sp.subprocess_id;
                            if (key != null) acc[key] = sp;
                            return acc;
                        }, {});

                        voSubs.forEach(vsp => {
                            const key = vsp.process_subprocess_id || vsp.subprocess_id;
                            if (key == null) return;

                            // Cache variant options for this subprocess
                            cacheUpdates[key] = vsp;

                            // If we already have a subprocess entry, enrich it; otherwise add it
                            const existing = subsById[key];
                            if (existing) {
                                if (!existing.variants || !existing.variants.length) {
                                    const flattened = flattenVariants(vsp);
                                    if (flattened.length) {
                                        existing.variants = flattened;
                                    }
                                }
                                // Preserve status/notes from existing; attach option metadata for later use
                                existing.variant_options = vsp;
                            } else {
                                const flattened = flattenVariants(vsp);
                                lot.subprocesses = Array.isArray(lot.subprocesses) ? lot.subprocesses : [];
                                lot.subprocesses.push({
                                    ...vsp,
                                    variants: flattenVariants(vsp)
                                });
                            }
                        });

                        logger.info(`✅ After variant merge: ${lot.subprocesses.length} subprocesses`);
                        
                        // Apply cache updates in state
                        this.state.setState({
                            variantOptionsCache: {
                                ...variantOptionsCache,
                                ...cacheUpdates
                            }
                        });
                    }
                } catch (voErr) {
                    logger.warn('⚠️ Failed to load lot-scoped variant options:', voErr.message || voErr);
                }
                // Map 'selections' to 'subprocesses' for compatibility
                if (lot.selections && (!lot.subprocesses || lot.subprocesses.length === 0)) {
                    lot.subprocesses = lot.selections;
                    logger.debug('ℹ️ Mapped selections to subprocesses for compatibility');
                }
                
                // Log final subprocess count before rendering
                logger.info(`📊 Final subprocess count: ${lot.subprocesses?.length || 0}`);
                
                const alerts = alertsData.data || alertsData.alert_details || alertsData || [];

                logger.debug('✅ Processed lot:', lot);
                logger.debug('✅ Processed alerts:', alerts);

                // Update state
                this.state.setState({
                    lot,
                    alerts: Array.isArray(alerts) ? alerts : [],
                    ui: { loading: false }
                });

                // Render UI
                logger.debug('🎨 Rendering UI components...');
                this._renderLotDetails();
                this._renderSubprocesses();
                this._renderAlerts();
                
                // Re-setup delegated handlers after content is rendered
                // This ensures buttons in dynamically rendered content have handlers
                this._setupDelegatedHandlersForDynamicContent();

                logger.info('✅ All data loaded and rendered successfully');

            } catch (error) {
                logger.error('❌ Error loading data:', error);
                logger.error('Error stack:', error.stack);
                this.toast.error('Failed to load production lot details');
                this.state.setState({ 
                    ui: { loading: false, error: error.message } 
                });
            }
        }

        /**
         * Setup all event listeners with cleanup
         */
        _setupEventListeners() {
            logger.debug('🎧 Setting up event listeners...');
            
            // Cleanup existing listeners
            this._cleanupEventListeners();

            // Create new AbortController
            this.abortController = new AbortController();
            const signal = this.abortController.signal;

            // Lot actions
            this._addEventHandler(SELECTORS.editLotBtn, 'click', () => this._handleEditLot(), signal);
            this._addEventHandler(SELECTORS.deleteLotBtn, 'click', () => this._handleDeleteLot(), signal);
            this._addEventHandler(SELECTORS.finalizeLotBtn, 'click', () => this._handleFinalizeLot(), signal);
            this._addEventHandler(SELECTORS.refreshVariantOptions, 'click', () => this._loadAllData(), signal);
            // Add subprocess to lot
            this._addEventHandler(SELECTORS.addSubprocessBtn, 'click', () => this._handleAddSubprocess(), signal);
            // Recalculate cost
            this._addEventHandler(SELECTORS.recalcCostBtn, 'click', () => this._handleRecalculateCost(), signal);

            // Modal actions - using actual HTML IDs
            const modalForm = findElement(SELECTORS.editLotForm);
            if (modalForm) {
                modalForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this._handleSaveEditLot();
                }, { signal });
            }
            
            this._addEventHandler(SELECTORS.modalClose, 'click', () => this.modal.close(SELECTORS.modalOverlay), signal);
            this._addEventHandler(SELECTORS.modalCancel, 'click', () => this.modal.close(SELECTORS.modalOverlay), signal);

            // Variant modal close/cancel handlers
            this._addEventHandler(SELECTORS.variantModalClose, 'click', () => this.modal.close(SELECTORS.variantModalOverlay), signal);
            this._addEventHandler(SELECTORS.variantModalCancel, 'click', () => this.modal.close(SELECTORS.variantModalOverlay), signal);

            // Subprocess actions (delegated)
            // Ensure delegated handler forwards both event and resolved target
            this._addDelegatedHandler(SELECTORS.subprocessesContent, 'click', '[data-action="edit-variants"]', 
                (e, target) => this._handleEditSubprocessVariants(e, target), signal);

            // Alert actions (delegated)
            // Forward resolved target to acknowledge handler
            this._addDelegatedHandler(SELECTORS.alertsTableBody, 'click', '[data-action="ack-alert"]',
                (e, target) => this._handleAcknowledgeAlert(e, target), signal);
            
            this._addEventHandler(SELECTORS.selectAllAlerts, 'change', 
                (e) => this._handleSelectAllAlerts(e), signal);
            
            this._addEventHandler(SELECTORS.bulkAcknowledgeBtn, 'click', 
                () => this._handleBulkAcknowledge(), signal);

            // Edit subprocess modal actions
            this._addEventHandler(SELECTORS.editSubprocessModalClose, 'click', 
                () => this.modal.close(SELECTORS.editSubprocessModalOverlay), signal);
            
            this._addEventHandler(SELECTORS.editSubprocessCancel, 'click', 
                () => this.modal.close(SELECTORS.editSubprocessModalOverlay), signal);
            
            this._addEventHandler(SELECTORS.editSubprocessSave, 'click', 
                () => this._handleSaveSubprocessVariants(), signal);

            logger.debug('✅ Event listeners setup complete');
        }

        /**
         * Add event handler with cleanup tracking
         */
        _addEventHandler(selectorString, event, handler, signal, retries = 2) {
            if (!selectorString) {
                logger.warn('⚠️ _addEventHandler: selectorString is null/undefined');
                return;
            }
            
            const element = findElement(selectorString);
            if (!element) {
                logger.debug(`ℹ️ Element not yet available: ${selectorString.split(',')[0]}`);
                if (retries > 0) {
                    // Retry shortly in case the DOM node is injected later
                    setTimeout(() => this._addEventHandler(selectorString, event, handler, signal, retries - 1), 200);
                }
                return;
            }

            element.addEventListener(event, handler, { signal });
            
            const key = `${selectorString.split(',')[0]}-${event}`;
            this.eventHandlers.set(key, { element, event, handler });
            logger.debug(`✅ Added event handler: ${key}`);
        }

        /**
         * Add delegated event handler
         */
        _addDelegatedHandler(parentSelectorString, event, childSelector, handler, signal, retries = 3) {
            const parent = findElement(parentSelectorString);
            if (!parent) {
                logger.debug(`ℹ️ Parent element not yet available: ${parentSelectorString.split(',')[0]}`);
                if (retries > 0) {
                    // Retry shortly in case the DOM node is injected later
                    setTimeout(() => this._addDelegatedHandler(parentSelectorString, event, childSelector, handler, signal, retries - 1), 200);
                } else {
                    logger.warn(`⚠️ Parent element never found after retries: ${parentSelectorString.split(',')[0]}`);
                }
                return;
            }

            const delegatedHandler = (e) => {
                const target = e.target.closest(childSelector);
                if (target) {
                    logger.debug(`🎯 Delegated event triggered: ${childSelector}`, target);
                    handler.call(this, e, target);
                }
            };

            parent.addEventListener(event, delegatedHandler, { signal });
            logger.debug(`✅ Delegated handler setup: ${parentSelectorString.split(',')[0]} > ${childSelector}`);
            
            const key = `${parentSelectorString.split(',')[0]}-${event}-${childSelector}`;
            this.eventHandlers.set(key, { element: parent, event, handler: delegatedHandler });
            logger.debug(`✅ Added delegated handler: ${key}`);
        }

        /**
         * Cleanup all event listeners
         */
        _cleanupEventListeners() {
            if (this.abortController) {
                logger.debug('🧹 Cleaning up event listeners');
                this.abortController.abort();
            }
            this.eventHandlers.clear();
        }

        /**
         * Setup delegated handlers for dynamically rendered content
         * Called after rendering to ensure buttons have handlers
         */
        _setupDelegatedHandlersForDynamicContent() {
            logger.debug('🔄 Setting up delegated handlers for dynamic content...');
            
            // Use the existing AbortController signal if available
            const signal = this.abortController?.signal;
            
            // Re-setup subprocess edit-variants handler
            const subprocessContainer = findElement(SELECTORS.subprocessesContent);
            if (subprocessContainer) {
                // Check if handler already exists to avoid duplicates
                const key = `${SELECTORS.subprocessesContent.split(',')[0]}-click-[data-action="edit-variants"]`;
                if (!this.eventHandlers.has(key)) {
                    this._addDelegatedHandler(SELECTORS.subprocessesContent, 'click', '[data-action="edit-variants"]', 
                        (e, target) => this._handleEditSubprocessVariants(e, target), signal);
                }
            }
            
            // Re-setup alert acknowledge handler
            const alertsContainer = findElement(SELECTORS.alertsTableBody);
            if (alertsContainer) {
                const key = `${SELECTORS.alertsTableBody.split(',')[0]}-click-[data-action="ack-alert"]`;
                if (!this.eventHandlers.has(key)) {
                    this._addDelegatedHandler(SELECTORS.alertsTableBody, 'click', '[data-action="ack-alert"]',
                        (e, target) => this._handleAcknowledgeAlert(e, target), signal);
                }
            }
            
            logger.debug('✅ Delegated handlers for dynamic content setup complete');
        }

        // =========================
        // Lot Detail Rendering
        // =========================

        /**
         * Render lot details section
         */
        _renderLotDetails() {
            logger.debug('🎨 Rendering lot details...');
            const { lot } = this.state.getState();
            
            if (!lot) {
                logger.warn('⚠️ No lot data to render');
                const detailsContent = findElement(SELECTORS.lotDetailsContent);
                if (detailsContent) {
                    detailsContent.innerHTML = '<p class="empty-state">No lot data available</p>';
                }
                return;
            }

            logger.debug('📊 Rendering lot:', lot);

            // Update page title
            const pageTitle = findElement(SELECTORS.pageTitle);
            if (pageTitle) {
                pageTitle.textContent = `🏭 Production Lot: ${escapeHtml(lot.lot_number || 'N/A')}`;
            }

            // Update status badge
            const statusBadge = findElement(SELECTORS.lotStatusBadge);
            if (statusBadge) {
                const statusConfig = STATUS_CONFIG[lot.status] || STATUS_CONFIG.draft;
                statusBadge.innerHTML = `<span class="status ${statusConfig.class}">${statusConfig.label}</span>`;
                logger.debug('✅ Updated status badge:', lot.status);
            }

            // Render lot details content
            const detailsContent = findElement(SELECTORS.lotDetailsContent);
            if (detailsContent) {
                const cost = lot.total_cost ?? lot.worst_case_estimated_cost ?? 0;
                detailsContent.innerHTML = `
                    <div class="detail-row">
                        <span class="detail-label">Process:</span>
                        <span class="detail-value">${escapeHtml(lot.process_name || 'N/A')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Lot Number:</span>
                        <span class="detail-value">${escapeHtml(lot.lot_number || 'N/A')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Lot Quantity:</span>
                        <span class="detail-value">${escapeHtml(lot.quantity != null && lot.quantity !== '' ? String(lot.quantity) : '1')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Status:</span>
                        <span class="detail-value">${escapeHtml(lot.status || 'N/A')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Notes:</span>
                        <span class="detail-value">${escapeHtml(lot.notes || 'No notes')}</span>
                    </div>
                `;
                detailsContent.classList.remove('loading-state');
            }

            // Render summary content
            const summaryContent = findElement(SELECTORS.summaryContent);
            if (summaryContent) {
                const cost = lot.total_cost ?? lot.worst_case_estimated_cost ?? 0;
                const subprocessCount = lot.subprocesses?.length || 0;
                const qty = lot.quantity != null && lot.quantity !== '' ? String(lot.quantity) : '1';
                summaryContent.innerHTML = `
                    <div class="detail-row">
                        <span class="detail-label">Total Cost:</span>
                        <span class="detail-value">₹${Number(cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Lot Quantity:</span>
                        <span class="detail-value">${escapeHtml(qty)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Subprocesses:</span>
                        <span class="detail-value">${subprocessCount}</span>
                    </div>
                `;
                summaryContent.classList.remove('loading-state');
            }

            // Update finalize button state based on critical alerts
            this._updateFinalizeButton();
            
            logger.debug('✅ Lot details rendered successfully');
        }

        /**
         * Update element text content
         */
        _updateElementText(selectorString, text) {
            const el = findElement(selectorString);
            if (el) {
                el.textContent = text;
            }
        }

        /**
         * Update finalize button based on critical alerts
         */
        _updateFinalizeButton() {
            const { alerts } = this.state.getState();
            const hasCritical = alerts.some(a => a.severity === 'CRITICAL' && a.status !== 'ACKNOWLEDGED');

            logger.debug('🚨 Has critical unacknowledged alerts:', hasCritical);

            const finalizeBtn = findElement(SELECTORS.finalizeLotBtn);
            const alertBanner = findElement(SELECTORS.criticalAlertBanner);

            if (finalizeBtn) {
                finalizeBtn.disabled = hasCritical;
                finalizeBtn.title = hasCritical ? 'Cannot finalize: Critical alerts must be acknowledged' : 'Finalize this production lot';
            }

            if (alertBanner) {
                alertBanner.style.display = hasCritical ? 'block' : 'none';
            }
        }

        // =========================
        // Lot Actions
        // =========================

        /**
         * Handle edit lot button
         */
        _handleEditLot() {
            try {
                logger.info('📝 Handle edit lot clicked');
                const { lot } = this.state.getState();
                logger.debug('📦 Current lot state:', lot);
                
                if (!lot) {
                    logger.warn('⚠️ No lot data available - cannot open edit modal');
                    this.toast.error('Lot data not loaded yet. Please wait and try again.');
                    return;
                }

                // Populate form
                const quantityInput = findElement(SELECTORS.modalQuantity);
                const statusInput = findElement(SELECTORS.modalStatus);
                const notesInput = findElement(SELECTORS.modalNotes);

                logger.debug('📋 Form elements found:', {
                    quantityInput: !!quantityInput,
                    statusInput: !!statusInput,
                    notesInput: !!notesInput
                });

                if (quantityInput) quantityInput.value = lot.quantity || '1';
                if (statusInput) statusInput.value = lot.status || 'Planning';
                if (notesInput) notesInput.value = lot.notes || '';

                logger.debug('🔓 Opening modal:', SELECTORS.modalOverlay);
                this.modal.open(SELECTORS.modalOverlay);
                logger.info('✅ Edit modal opened successfully');
            } catch (error) {
                logger.error('❌ Error opening edit modal:', error);
                this.toast.error('Failed to open edit modal');
            }
        }

        /**
         * Handle save edited lot
         */
        async _handleSaveEditLot() {
            logger.debug('💾 Handle save edit lot');

            try {
                const { lotId } = this.state.getState();

                const quantityInput = findElement(SELECTORS.modalQuantity);
                const statusInput = findElement(SELECTORS.modalStatus);
                const notesInput = findElement(SELECTORS.modalNotes);

                const updates = {
                    quantity: parseInt(quantityInput?.value || '0', 10),
                    status: statusInput?.value || 'Planning',
                    notes: notesInput?.value || ''
                };

                logger.debug('📤 Updating lot with:', updates);

                await this.api.put(API_PATHS.lot(lotId), updates);

                this.toast.success('Production lot updated successfully');
                this.modal.close(SELECTORS.modalOverlay);

                // Reload data
                await this._loadAllData();

            } catch (error) {
                logger.error('❌ Error updating lot:', error);
                this.toast.error('Failed to update production lot');
            }
        }

        /**
         * Handle delete lot
         */
        async _handleDeleteLot() {
            if (!confirm('Are you sure you want to delete this production lot? This action cannot be undone.')) {
                return;
            }

            logger.debug('🗑️ Handle delete lot');
            const deleteBtn = findElement(SELECTORS.deleteLotBtn);
            this.spinner.showInButton(deleteBtn);

            try {
                const { lotId } = this.state.getState();
                const response = await this.api.delete(API_PATHS.lotDelete(lotId));

                this.toast.success('Production lot deleted successfully');
                
                // Redirect to production lots list
                setTimeout(() => {
                    window.location.href = '/upf/processes?tab=production#production';
                }, 1000);

            } catch (error) {
                logger.error('❌ Error deleting lot:', error);
                
                // Extract specific error message from response
                let errorMsg = 'Failed to delete production lot';
                
                if (error.response && error.response.error) {
                    const errData = error.response.error;
                    if (errData.code === 'conflict') {
                        errorMsg = errData.message || 'Cannot delete: Lot has active subprocesses';
                    } else if (errData.message) {
                        errorMsg = errData.message;
                    }
                } else if (error.message) {
                    errorMsg = error.message;
                }
                
                this.toast.error(errorMsg);
                this.spinner.hideInButton(deleteBtn);
            }
        }

        /**
         * Handle finalize lot
         */
        async _handleFinalizeLot() {
            const { lot } = this.state.getState();
            
            // Validate lot has subprocesses
            if (!lot || !lot.subprocesses || lot.subprocesses.length === 0) {
                this.toast.error('Cannot finalize: Production lot has no subprocesses. Add at least one subprocess before finalizing.');
                return;
            }
            
            if (!confirm('Are you sure you want to finalize this production lot? Status will change to "Ready" and all changes will be locked.')) {
                return;
            }

            logger.debug('🔒 Handle finalize lot');
            const finalizeBtn = findElement(SELECTORS.finalizeLotBtn);
            this.spinner.showInButton(finalizeBtn);

            try {
                const { lotId } = this.state.getState();
                const response = await this.api.post(API_PATHS.lotFinalize(lotId));

                const resultData = response.data || response;
                this.toast.success('Production lot finalized successfully! Status changed to "Ready"');
                
                // Reload data to reflect status change
                await this._loadAllData();

            } catch (error) {
                logger.error('❌ Error finalizing lot:', error);
                
                // Extract specific error message
                let errorMsg = 'Failed to finalize production lot';
                
                if (error.response && error.response.error) {
                    const errData = error.response.error;
                    if (errData.message) {
                        errorMsg = errData.message;
                    }
                } else if (error.message) {
                    errorMsg = error.message;
                }
                
                this.toast.error(errorMsg);
            } finally {
                this.spinner.hideInButton(finalizeBtn);
            }
        }

        /**
         * Handle recalculate cost
         */
        async _handleRecalculateCost() {
            logger.debug('💰 Handle recalculate cost');
            const recalcBtn = findElement(SELECTORS.recalcCostBtn);
            this.spinner.showInButton(recalcBtn);

            try {
                const { lotId } = this.state.getState();
                const response = await this.api.post(API_PATHS.lotRecalc(lotId));

                const data = response.data || response;
                const newCost = data.total_cost ?? data.worst_case_estimated_cost ?? 0;

                logger.debug('💵 New cost:', newCost);

                // Update state
                this.state.setState({
                    lot: {
                        ...this.state.getState().lot,
                        total_cost: newCost
                    }
                });

                // Update UI
                this._updateElementText(SELECTORS.lotTotalCost, 
                    `₹${Number(newCost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

                this.toast.success('Cost recalculated successfully');

            } catch (error) {
                logger.error('❌ Error recalculating cost:', error);
                this.toast.error('Failed to recalculate cost');
            } finally {
                this.spinner.hideInButton(recalcBtn);
            }
        }

        /**
         * Handle adding a subprocess to the production lot
         */
        async _handleAddSubprocess() {
            logger.debug('➕ Handle add subprocess');

            const addBtn = findElement(SELECTORS.addSubprocessBtn);
            const selectEl = findElement(SELECTORS.subprocessSelectForAdd);
            const selected = selectEl?.value;

            // Clear any previous form errors
            this._displayFormErrors(SELECTORS.subprocessSelectForAdd, []);

            if (!selected) {
                this.toast.warning('Please select a subprocess to add');
                return;
            }

            this.spinner.showInButton(addBtn);

            try {
                const { lotId } = this.state.getState();
                logger.debug('📤 Adding subprocess to lot:', selected, 'lotId:', lotId);

                await this.api.post(API_PATHS.subprocesses(lotId), { subprocess_id: parseInt(selected, 10) });

                this.toast.success('Subprocess added to production lot');

                // Reload data to reflect new subprocess
                await this._loadAllData();

                // Refresh available subprocess select (removes the one just added from options if backend filters)
                await this._loadAvailableSubprocesses();

            } catch (error) {
                logger.error('❌ Error adding subprocess:', error);

                // If server returned structured validation errors, display them
                const resp = error.responseData;
                if (resp) {
                    const messages = [];

                    if (Array.isArray(resp.errors)) {
                        resp.errors.forEach(err => messages.push(err.message || JSON.stringify(err)));
                    } else if (typeof resp === 'object') {
                        // Common shapes: { field: ["err"] } or { message: '...' }
                        if (resp.message) messages.push(resp.message);
                        Object.keys(resp).forEach(k => {
                            if (k === 'message' || k === 'errors') return;
                            const v = resp[k];
                            if (Array.isArray(v)) v.forEach(i => messages.push(`${k}: ${i}`));
                            else messages.push(`${k}: ${JSON.stringify(v)}`);
                        });
                    } else if (typeof resp === 'string') {
                        messages.push(resp);
                    }

                    if (messages.length) {
                        this._displayFormErrors(SELECTORS.subprocessSelectForAdd, messages);
                        this.toast.error(messages.join('; '));
                    } else {
                        this.toast.error('Failed to add subprocess to production lot');
                    }

                } else {
                    this.toast.error('Failed to add subprocess to production lot');
                }

            } finally {
                this.spinner.hideInButton(addBtn);
            }
        }

        // =========================
        // Subprocess Rendering
        // =========================

        /**
         * Render subprocesses list
         */
        _renderSubprocesses() {
            logger.debug('🎨 Rendering subprocesses...');
            const { lot } = this.state.getState();
            
            const container = findElement(SELECTORS.subprocessesContent);
            if (!container) {
                logger.warn('⚠️ Subprocess container not found - selector:', SELECTORS.subprocessesContent);
                return;
            }

            if (!lot || !lot.subprocesses) {
                logger.debug('ℹ️ No subprocess data to render - lot:', lot);
                container.innerHTML = '<p class="empty-state">No subprocess data available</p>';
                container.classList.remove('loading-state');
                return;
            }

            if (!lot.subprocesses.length) {
                container.innerHTML = '<p class="empty-state">No subprocesses defined for this lot</p>';
                container.classList.remove('loading-state');
                logger.debug('ℹ️ No subprocesses to display');
                return;
            }

            logger.debug(`📋 Rendering ${lot.subprocesses.length} subprocesses:`, lot.subprocesses);
            const html = lot.subprocesses.map(sp => this._renderSubprocessCard(sp)).join('');
            container.innerHTML = html;
            container.classList.remove('loading-state');
            logger.debug(`✅ Rendered ${lot.subprocesses.length} subprocesses - HTML length: ${html.length} chars`);
        }

        /**
         * Render single subprocess card
         */
        _renderSubprocessCard(subprocess) {
            // Build a detailed variants block (name, sku, qty if present)
            let variantsHtml = '';
            const variants = Array.isArray(subprocess.variants) ? subprocess.variants : [];

            if (variants.length === 0) {
                variantsHtml = '<div class="muted">No variants selected</div>';
            } else {
                variantsHtml = '<ul class="variant-list" style="margin:6px 0 0;padding-left:18px">';
                variants.forEach(v => {
                    const name = escapeHtml(v.variant_name || v.name || v.full_name || `Variant #${v.variant_id || ''}`);
                    const sku = v.variant_sku || v.sku || '';
                    const qty = v.quantity ?? v.qty ?? v.variant_quantity ?? null;
                    const qtyText = qty != null ? ` &times; ${escapeHtml(String(qty))}` : '';
                    const skuText = sku ? ` <span class="text-secondary">(${escapeHtml(sku)})</span>` : '';
                    variantsHtml += `<li>${name}${skuText}${qtyText}</li>`;
                });
                variantsHtml += '</ul>';
            }

            // Use process_subprocess_id (the linkage ID) instead of subprocess_id (library ID)
            const psId = subprocess.process_subprocess_id || subprocess.id || subprocess.subprocess_id;
            
            return `
                <div class="card subprocess-card" data-subprocess-id="${psId}">
                    <div class="card__body">
                        <div class="flex justify-between items-center">
                            <div style="flex:1;min-width:0;">
                                <h3 style="margin:0 0 6px">${escapeHtml(subprocess.subprocess_name)}</h3>
                                <p class="text-secondary" style="margin:0 0 8px">${escapeHtml(subprocess.subprocess_description || '')}</p>
                                <div><strong>Variants:</strong>${variantsHtml}</div>
                            </div>
                            <button 
                                class="btn btn--secondary btn--sm" 
                                data-action="edit-variants"
                                data-subprocess-id="${psId}"
                                data-subprocess-name="${escapeHtml(subprocess.subprocess_name)}">
                                Edit Variants
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Handle edit subprocess variants
         */
        async _handleEditSubprocessVariants(e, target) {
            logger.debug('🔍 _handleEditSubprocessVariants called', { hasEvent: !!e, hasTarget: !!target });
            
            // Defensive: resolve target if not provided (caller may pass only event)
            if (!target && e && e.target) {
                target = e.target.closest('[data-action="edit-variants"]');
                logger.debug('🔍 Resolved target from event:', target);
            }

            if (!target) {
                logger.warn('⚠️ _handleEditSubprocessVariants called without a target');
                return;
            }

            const subprocessId = target.dataset.subprocessId;
            const subprocessName = target.dataset.subprocessName;

            logger.debug('✏️ Handle edit variants for subprocess:', { subprocessId, subprocessName, dataset: target.dataset });

            if (!subprocessId) {
                logger.warn('⚠️ No subprocess ID found');
                return;
            }

            this.state.setState({
                ui: { editingSubprocess: subprocessId }
            });

            try {
                // Load variant options if not cached
                await this._loadVariantOptions(subprocessId);

                // Populate modal
                await this._populateVariantModal(subprocessId, subprocessName);

                // Open modal
                logger.debug('🔓 Opening edit subprocess modal');
                this.modal.open(SELECTORS.editSubprocessVariantsModal);
                
                logger.debug('✅ Edit variants modal opened successfully');

            } catch (error) {
                logger.error('❌ Error loading variant options:', error);
                logger.error('Error stack:', error.stack);
                this.toast.error(`Failed to load variant options: ${error.message}`);
            }
        }

        /**
         * Load variant options for subprocess
         */
        async _loadVariantOptions(subprocessId) {
            logger.debug('📥 Loading variant options for subprocess:', subprocessId);
            const { variantOptionsCache } = this.state.getState();

            // Return cached if available
            if (variantOptionsCache[subprocessId]) {
                logger.debug('✅ Using cached variant options');
                return variantOptionsCache[subprocessId];
            }

            // Fetch from API with 5-second timeout
            const url = API_PATHS.variantOptions(subprocessId);
            logger.debug('🌐 Fetching variant options from:', url);
            
            try {
                // Create a timeout promise that rejects after 5 seconds
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('Variant loading timeout: Request took longer than 5 seconds'));
                    }, 5000);
                });
                
                // Race between the API call and timeout
                const response = await Promise.race([
                    this.api.get(url),
                    timeoutPromise
                ]);
                
                let rawData = response.data || response;
                logger.debug('✅ Raw variant options response:', rawData);

                // Backend returns { subprocesses: [...] } - extract the first subprocess data
                // to normalize: { or_groups, grouped_variants, standalone_variants }
                let options = {};
                if (rawData.subprocesses && Array.isArray(rawData.subprocesses) && rawData.subprocesses.length > 0) {
                    const sp = rawData.subprocesses[0];
                    options = {
                        or_groups: sp.or_groups || [],
                        grouped_variants: sp.grouped_variants || {},
                        standalone_variants: sp.standalone_variants || [],
                        cost_items: sp.cost_items || [],
                        subprocess_name: sp.subprocess_name || ''
                    };
                } else {
                    // Fallback if data is already in expected format
                    options = {
                        or_groups: rawData.or_groups || [],
                        grouped_variants: rawData.grouped_variants || {},
                        standalone_variants: rawData.standalone_variants || [],
                        cost_items: rawData.cost_items || [],
                        subprocess_name: rawData.subprocess_name || ''
                    };
                }
                
                logger.debug('✅ Normalized variant options:', options);

                // Cache the result
                this.state.setState({
                    variantOptionsCache: {
                        ...variantOptionsCache,
                        [subprocessId]: options
                    }
                });

                return options;
            } catch (error) {
                logger.warn('⚠️ Failed to load variant options:', error.message);
                
                // Return empty options to prevent the component from hanging
                const emptyOptions = {
                    or_groups: [],
                    grouped_variants: {},
                    standalone_variants: [],
                    error: error.message
                };
                
                // Cache the error result
                this.state.setState({
                    variantOptionsCache: {
                        ...variantOptionsCache,
                        [subprocessId]: emptyOptions
                    }
                });
                
                throw error;
            }
        }

        /**
         * Normalize variant data to include all detail fields
         */
        _normalizeVariantData(v) {
            // Build a detailed display name from item + model + variation + color + size
            const itemName = v.item_number || v.item_name || '';
            const modelName = v.model_name || '';
            const variationName = v.variation_name || '';
            const colorName = v.color_name || '';
            const sizeName = v.size_name || '';
            
            // Create display name with all parts
            const nameParts = [itemName, modelName, variationName, colorName, sizeName].filter(Boolean);
            const displayName = nameParts.join(' - ') || v.variant_name || v.name || `Variant #${v.variant_id || ''}`;
            
            return {
                usage_id: v.usage_id,
                variant_id: v.variant_id,
                variant_name: displayName,
                // Keep individual fields for detailed display
                item_name: itemName,
                model_name: modelName,
                variation_name: variationName,
                color_name: colorName,
                size_name: sizeName,
                description: v.description || '',
                variant_sku: v.variant_sku || v.sku || '',
                quantity: v.quantity || 1,
                unit: v.unit || 'pcs',
                unit_price: v.unit_price || 0,
                opening_stock: v.opening_stock || 0
            };
        }

        /**
         * Build HTML for variant details display
         */
        _buildVariantDetailsHtml(v) {
            const details = [];
            if (v.item_name) details.push(`<span class="detail-item"><strong>Item:</strong> ${escapeHtml(v.item_name)}</span>`);
            if (v.model_name) details.push(`<span class="detail-model"><strong>Model:</strong> ${escapeHtml(v.model_name)}</span>`);
            if (v.variation_name) details.push(`<span class="detail-variation"><strong>Variation:</strong> ${escapeHtml(v.variation_name)}</span>`);
            if (v.color_name) details.push(`<span class="detail-color"><strong>Color:</strong> ${escapeHtml(v.color_name)}</span>`);
            if (v.size_name) details.push(`<span class="detail-size"><strong>Size:</strong> ${escapeHtml(v.size_name)}</span>`);
            
            if (details.length === 0) {
                return `<span class="variant-name">${escapeHtml(v.variant_name || `Variant #${v.variant_id}`)}</span>`;
            }
            
            return `
                <div class="variant-details">
                    ${details.join('')}
                </div>
            `;
        }

        /**
         * Populate variant selection modal with full edit capabilities
         */
        async _populateVariantModal(subprocessId, subprocessName) {
            logger.debug('🎨 Populating variant modal for subprocess:', subprocessId, subprocessName);
            const { lot, variantOptionsCache } = this.state.getState();
            
            // Update modal title (use h3 as per template)
            const modal = findElement(SELECTORS.editSubprocessVariantsModal);
            const modalTitle = modal?.querySelector('h3');
            if (modalTitle) {
                modalTitle.textContent = `Edit Variants - ${subprocessName}`;
            }

            // Get current subprocess data - try process_subprocess_id first, then id, then subprocess_id
            const parsedId = parseInt(subprocessId);
            const subprocess = lot.subprocesses.find(sp => 
                sp.process_subprocess_id === parsedId || 
                sp.id === parsedId || 
                sp.subprocess_id === parsedId
            );
            
            logger.debug('📊 Found subprocess:', subprocess);
            
            // Get current variant selections with their details
            const currentVariants = subprocess?.variants || [];
            
            logger.debug('📊 Current variants:', currentVariants);

            // Get variant options and normalize
            const options = variantOptionsCache[subprocessId] || {};

            // Normalize grouped variants
            let variantGroups = [];
            if (Array.isArray(options.variant_groups) && options.variant_groups.length > 0) {
                variantGroups = options.variant_groups;
            } else if (Array.isArray(options.or_groups) && options.grouped_variants) {
                const grouped = options.grouped_variants || {};
                variantGroups = options.or_groups.map(g => ({
                    group_id: g.group_id || g.id,
                    group_name: g.group_name || g.name || '',
                    description: g.description || '',
                    variants: (grouped[g.group_id] || grouped[g.id] || []).map(v => this._normalizeVariantData(v))
                }));
            }

            // Normalize standalone variants
            const standaloneVariantsRaw = options.standalone_variants || [];
            const standaloneVariants = standaloneVariantsRaw.map(v => this._normalizeVariantData(v));

            // Build all available variants for the "Add New" dropdown
            const allAvailableVariants = [];
            variantGroups.forEach(g => g.variants.forEach(v => allAvailableVariants.push({...v, group_name: g.group_name})));
            standaloneVariants.forEach(v => allAvailableVariants.push({...v, group_name: 'Standalone'}));

            logger.debug('📋 Variant groups:', variantGroups);
            logger.debug('📋 Standalone variants:', standaloneVariants);
            logger.debug('📋 All available variants:', allAvailableVariants);

            const container = findElement(SELECTORS.variantSelectionContainer);
            if (!container) {
                logger.warn('⚠️ Variant selection container not found');
                return;
            }

            // Build map of variant_id -> variant data for lookups
            const variantMap = new Map();
            allAvailableVariants.forEach(v => {
                if (v.usage_id) variantMap.set(v.usage_id, v);
            });

            // Build current selections with full details
            const currentSelections = currentVariants.map(cv => {
                const availableData = allAvailableVariants.find(av => av.variant_id === cv.variant_id) || {};
                return {
                    usage_id: availableData.usage_id || cv.usage_id,
                    variant_id: cv.variant_id,
                    variant_name: cv.variant_name || availableData.variant_name || `Variant #${cv.variant_id}`,
                    // Detail fields
                    item_name: cv.item_name || availableData.item_name || '',
                    model_name: cv.model_name || availableData.model_name || '',
                    variation_name: cv.variation_name || availableData.variation_name || '',
                    color_name: cv.color_name || availableData.color_name || '',
                    size_name: cv.size_name || availableData.size_name || '',
                    description: cv.description || availableData.description || '',
                    quantity: cv.quantity || availableData.quantity || 1,
                    notes: cv.notes || '',
                    unit: cv.unit || availableData.unit || 'pcs',
                    unit_price: cv.unit_price || availableData.unit_price || 0,
                    opening_stock: cv.opening_stock || availableData.opening_stock || 0
                };
            });

            // Get set of already selected usage_ids
            const selectedUsageIds = new Set(currentSelections.map(s => s.usage_id).filter(Boolean));

            let html = '';

            // Section 1: Current Selections (with edit/delete)
            html += `
                <div class="variant-section">
                    <h4 class="section-title">Current Selections</h4>
                    <div id="current-variant-selections">
            `;

            if (currentSelections.length > 0) {
                currentSelections.forEach((sel, index) => {
                    html += `
                        <div class="variant-selection-row" data-usage-id="${sel.usage_id}" data-variant-id="${sel.variant_id}">
                            <div class="variant-info">
                                ${this._buildVariantDetailsHtml(sel)}
                                ${sel.opening_stock !== undefined ? `<span class="stock-info">Stock: ${sel.opening_stock} ${escapeHtml(sel.unit)}</span>` : ''}
                            </div>
                            <div class="variant-inputs">
                                <div class="input-group">
                                    <label>Qty:</label>
                                    <input type="number" 
                                           class="form-control variant-quantity" 
                                           value="${sel.quantity}" 
                                           min="0.01" 
                                           step="0.01"
                                           data-usage-id="${sel.usage_id}">
                                    <span class="unit-label">${escapeHtml(sel.unit)}</span>
                                </div>
                                <div class="input-group notes-group">
                                    <label>Notes:</label>
                                    <input type="text" 
                                           class="form-control variant-notes" 
                                           value="${escapeHtml(sel.notes || '')}" 
                                           placeholder="Optional notes"
                                           data-usage-id="${sel.usage_id}">
                                </div>
                            </div>
                            <button type="button" class="btn-remove-variant" data-usage-id="${sel.usage_id}" title="Remove variant">
                                <span>&times;</span>
                            </button>
                        </div>
                    `;
                });
            } else {
                html += `<p class="empty-state">No variants selected yet</p>`;
            }

            html += `
                    </div>
                </div>
            `;

            // Section 2: Add New Variant
            // Filter out already selected variants
            const availableToAdd = allAvailableVariants.filter(v => v.usage_id && !selectedUsageIds.has(v.usage_id));

            html += `
                <div class="variant-section add-variant-section">
                    <h4 class="section-title">Add Variant</h4>
                    <div class="add-variant-row">
                        <select id="add-variant-select" class="form-control">
                            <option value="">-- Select variant to add --</option>
                            ${availableToAdd.map(v => `
                                <option value="${v.usage_id}" data-variant-id="${v.variant_id}">
                                    ${escapeHtml(v.variant_name)}${v.group_name ? ` (${escapeHtml(v.group_name)})` : ''}
                                </option>
                            `).join('')}
                        </select>
                        <div class="add-variant-inputs">
                            <input type="number" 
                                   id="add-variant-quantity" 
                                   class="form-control" 
                                   value="1" 
                                   min="0.01" 
                                   step="0.01" 
                                   placeholder="Qty">
                            <input type="text" 
                                   id="add-variant-notes" 
                                   class="form-control" 
                                   placeholder="Notes (optional)">
                        </div>
                        <button type="button" id="btn-add-variant" class="button secondary">
                            + Add
                        </button>
                    </div>
                </div>
            `;

            // Section 3: OR Groups (select one from each group)
            if (variantGroups.length > 0) {
                html += `
                    <div class="variant-section or-groups-section">
                        <h4 class="section-title">OR Groups (Select One Per Group)</h4>
                `;
                variantGroups.forEach(group => {
                    const selectedInGroup = group.variants.find(v => selectedUsageIds.has(v.usage_id));
                    html += `
                        <div class="form-group">
                            <label class="form-label">${escapeHtml(group.group_name)}</label>
                            <select class="form-control variant-select or-group-select" 
                                    data-group-id="${group.group_id}">
                                <option value="">-- Select ${escapeHtml(group.group_name)} --</option>
                                ${group.variants.map(v => `
                                    <option value="${v.usage_id}" 
                                            data-variant-id="${v.variant_id}"
                                            ${selectedInGroup && selectedInGroup.usage_id === v.usage_id ? 'selected' : ''}>
                                        ${escapeHtml(v.variant_name)}${v.variant_sku ? ` (${escapeHtml(v.variant_sku)})` : ''}
                                    </option>
                                `).join('')}
                            </select>
                        </div>
                    `;
                });
                html += `</div>`;
            }

            if (!html || html.trim() === '') {
                html = '<p class="empty-state">No variant options available for this subprocess</p>';
            }

            container.innerHTML = html;

            // Attach event listeners for the add/remove functionality
            this._attachVariantModalEventListeners(container, allAvailableVariants);
            
            logger.debug('✅ Variant modal populated with full edit capabilities');
        }

        /**
         * Attach event listeners for variant modal interactions
         */
        _attachVariantModalEventListeners(container, allAvailableVariants) {
            // Add variant button
            const addBtn = container.querySelector('#btn-add-variant');
            if (addBtn) {
                addBtn.addEventListener('click', () => this._handleAddVariantToList(container, allAvailableVariants));
            }

            // Remove variant buttons
            container.querySelectorAll('.btn-remove-variant').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const usageId = btn.dataset.usageId;
                    this._handleRemoveVariantFromList(container, usageId, allAvailableVariants);
                });
            });

            // OR group select changes - update current selections
            container.querySelectorAll('.or-group-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    this._handleOrGroupChange(container, select, allAvailableVariants);
                });
            });
        }

        /**
         * Handle adding a variant to the current selections list
         */
        _handleAddVariantToList(container, allAvailableVariants) {
            const select = container.querySelector('#add-variant-select');
            const qtyInput = container.querySelector('#add-variant-quantity');
            const notesInput = container.querySelector('#add-variant-notes');

            if (!select || !select.value) {
                this.toast.warning('Please select a variant to add');
                return;
            }

            const usageId = parseInt(select.value);
            const quantity = parseFloat(qtyInput?.value) || 1;
            const notes = notesInput?.value || '';

            // Find the variant data
            const variantData = allAvailableVariants.find(v => v.usage_id === usageId);
            if (!variantData) {
                this.toast.error('Variant not found');
                return;
            }

            // Add to the current selections list
            const selectionsContainer = container.querySelector('#current-variant-selections');
            const emptyState = selectionsContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const newRow = document.createElement('div');
            newRow.className = 'variant-selection-row';
            newRow.dataset.usageId = usageId;
            newRow.dataset.variantId = variantData.variant_id;
            newRow.innerHTML = `
                <div class="variant-info">
                    ${this._buildVariantDetailsHtml(variantData)}
                    ${variantData.opening_stock !== undefined ? `<span class="stock-info">Stock: ${variantData.opening_stock} ${escapeHtml(variantData.unit || 'pcs')}</span>` : ''}
                </div>
                <div class="variant-inputs">
                    <div class="input-group">
                        <label>Qty:</label>
                        <input type="number" 
                               class="form-control variant-quantity" 
                               value="${quantity}" 
                               min="0.01" 
                               step="0.01"
                               data-usage-id="${usageId}">
                        <span class="unit-label">${escapeHtml(variantData.unit || 'pcs')}</span>
                    </div>
                    <div class="input-group notes-group">
                        <label>Notes:</label>
                        <input type="text" 
                               class="form-control variant-notes" 
                               value="${escapeHtml(notes)}" 
                               placeholder="Optional notes"
                               data-usage-id="${usageId}">
                    </div>
                </div>
                <button type="button" class="btn-remove-variant" data-usage-id="${usageId}" title="Remove variant">
                    <span>&times;</span>
                </button>
            `;

            selectionsContainer.appendChild(newRow);

            // Add remove handler
            newRow.querySelector('.btn-remove-variant').addEventListener('click', () => {
                this._handleRemoveVariantFromList(container, usageId, allAvailableVariants);
            });

            // Remove from the add dropdown
            const optionToRemove = select.querySelector(`option[value="${usageId}"]`);
            if (optionToRemove) optionToRemove.remove();

            // Reset inputs
            select.value = '';
            if (qtyInput) qtyInput.value = '1';
            if (notesInput) notesInput.value = '';

            this.toast.success('Variant added');
        }

        /**
         * Handle removing a variant from the current selections list
         */
        _handleRemoveVariantFromList(container, usageId, allAvailableVariants) {
            const row = container.querySelector(`.variant-selection-row[data-usage-id="${usageId}"]`);
            if (row) {
                row.remove();

                // Check if list is now empty
                const selectionsContainer = container.querySelector('#current-variant-selections');
                if (selectionsContainer && !selectionsContainer.querySelector('.variant-selection-row')) {
                    selectionsContainer.innerHTML = '<p class="empty-state">No variants selected yet</p>';
                }

                // Add back to the add dropdown
                const variantData = allAvailableVariants.find(v => v.usage_id === parseInt(usageId));
                if (variantData) {
                    const addSelect = container.querySelector('#add-variant-select');
                    if (addSelect) {
                        const option = document.createElement('option');
                        option.value = variantData.usage_id;
                        option.dataset.variantId = variantData.variant_id;
                        option.textContent = `${variantData.variant_name}${variantData.group_name ? ` (${variantData.group_name})` : ''}`;
                        addSelect.appendChild(option);
                    }
                }
            }
        }

        /**
         * Handle OR group selection change
         */
        _handleOrGroupChange(container, select, allAvailableVariants) {
            const groupId = select.dataset.groupId;
            const newUsageId = select.value ? parseInt(select.value) : null;

            // Find previously selected variant from this group
            const selectionsContainer = container.querySelector('#current-variant-selections');
            const groupVariants = allAvailableVariants.filter(v => {
                // Check if this variant belongs to the same group by finding it in select options
                const option = select.querySelector(`option[value="${v.usage_id}"]`);
                return option !== null;
            });

            // Remove any existing selection from this group
            groupVariants.forEach(gv => {
                const existingRow = container.querySelector(`.variant-selection-row[data-usage-id="${gv.usage_id}"]`);
                if (existingRow) existingRow.remove();
            });

            // Add the newly selected variant
            if (newUsageId) {
                const variantData = allAvailableVariants.find(v => v.usage_id === newUsageId);
                if (variantData) {
                    const emptyState = selectionsContainer?.querySelector('.empty-state');
                    if (emptyState) emptyState.remove();

                    const newRow = document.createElement('div');
                    newRow.className = 'variant-selection-row';
                    newRow.dataset.usageId = newUsageId;
                    newRow.dataset.variantId = variantData.variant_id;
                    newRow.innerHTML = `
                        <div class="variant-info">
                            ${this._buildVariantDetailsHtml(variantData)}
                            <span class="variant-group-badge">${escapeHtml(variantData.group_name || '')}</span>
                            ${variantData.opening_stock !== undefined ? `<span class="stock-info">Stock: ${variantData.opening_stock} ${escapeHtml(variantData.unit || 'pcs')}</span>` : ''}
                        </div>
                        <div class="variant-inputs">
                            <div class="input-group">
                                <label>Qty:</label>
                                <input type="number" 
                                       class="form-control variant-quantity" 
                                       value="${variantData.quantity || 1}" 
                                       min="0.01" 
                                       step="0.01"
                                       data-usage-id="${newUsageId}">
                                <span class="unit-label">${escapeHtml(variantData.unit || 'pcs')}</span>
                            </div>
                            <div class="input-group notes-group">
                                <label>Notes:</label>
                                <input type="text" 
                                       class="form-control variant-notes" 
                                       value="" 
                                       placeholder="Optional notes"
                                       data-usage-id="${newUsageId}">
                            </div>
                        </div>
                        <button type="button" class="btn-remove-variant" data-usage-id="${newUsageId}" title="Remove variant">
                            <span>&times;</span>
                        </button>
                    `;

                    selectionsContainer.appendChild(newRow);

                    // Add remove handler (which also clears the OR group select)
                    newRow.querySelector('.btn-remove-variant').addEventListener('click', () => {
                        this._handleRemoveVariantFromList(container, newUsageId, allAvailableVariants);
                        select.value = '';
                    });
                }
            }

            // Check if list is now empty
            if (selectionsContainer && !selectionsContainer.querySelector('.variant-selection-row')) {
                selectionsContainer.innerHTML = '<p class="empty-state">No variants selected yet</p>';
            }
        }

        /**
         * Handle save subprocess variants
         */
        async _handleSaveSubprocessVariants() {
            logger.debug('💾 Handle save subprocess variants');
            const { lotId, ui } = this.state.getState();
            const subprocessId = ui.editingSubprocess;

            if (!subprocessId) {
                logger.warn('⚠️ No subprocess ID in editing state');
                return;
            }

            const saveBtn = findElement(SELECTORS.saveSubprocessVariantsBtn);
            this.spinner.showInButton(saveBtn);

            try {
                // Collect selected variants in format: [{ variant_usage_id, quantity, notes }]
                const selectedVariants = this._collectSelectedVariants();
                logger.debug('📤 Saving selected variants:', selectedVariants);

                if (selectedVariants.length === 0) {
                    this.toast.warning('Please select at least one variant before saving');
                    this.spinner.hideInButton(saveBtn);
                    return;
                }

                // Log what's being saved for debugging
                logger.info(`💾 Saving ${selectedVariants.length} variant(s) for subprocess ${subprocessId}`);
                // Send to API with correct payload format
                await this.api.post(
                    API_PATHS.subprocessVariants(subprocessId, lotId),
                    { selected_variants: selectedVariants }
                );

                this.toast.success('Variants updated successfully');
                this.modal.close(SELECTORS.editSubprocessVariantsModal);

                // Clear editing state
                this.state.setState({
                    ui: { editingSubprocess: null }
                });

                // Reload data
                await this._loadAllData();

            } catch (error) {
                logger.error('❌ Error saving variants:', error);
                this.toast.error('Failed to update variants');
            } finally {
                this.spinner.hideInButton(saveBtn);
            }
        }

        /**
         * Collect selected variant usage IDs from modal
         * Returns array of objects in format: [{ variant_usage_id: number, quantity: number, notes: string }]
         */
        _collectSelectedVariants() {
            const container = findElement(SELECTORS.variantSelectionContainer);
            if (!container) return [];

            const selections = [];
            const addedUsageIds = new Set();

            // Collect from the current selections list (primary source)
            container.querySelectorAll('.variant-selection-row').forEach(row => {
                const usageId = parseInt(row.dataset.usageId);
                if (!usageId || addedUsageIds.has(usageId)) return;

                const quantityInput = row.querySelector('.variant-quantity');
                const notesInput = row.querySelector('.variant-notes');

                const quantity = parseFloat(quantityInput?.value) || 1;
                const notes = notesInput?.value || '';

                selections.push({
                    variant_usage_id: usageId,
                    quantity: quantity,
                    notes: notes
                });
                addedUsageIds.add(usageId);
            });

            // Also collect from OR group dropdowns that might not be in the selections list
            container.querySelectorAll('.or-group-select').forEach(select => {
                const value = select.value;
                if (value) {
                    const usageId = parseInt(value);
                    if (!addedUsageIds.has(usageId)) {
                        selections.push({
                            variant_usage_id: usageId,
                            quantity: 1,
                            notes: ''
                        });
                        addedUsageIds.add(usageId);
                    }
                }
            });

            // Collect from standalone checkboxes (legacy fallback)
            container.querySelectorAll('.variant-checkbox:checked').forEach(checkbox => {
                const usageId = parseInt(checkbox.dataset.usageId);
                if (usageId && !addedUsageIds.has(usageId)) {
                    selections.push({
                        variant_usage_id: usageId,
                        quantity: 1,
                        notes: ''
                    });
                    addedUsageIds.add(usageId);
                }
            });

            logger.debug('📋 Collected selected variants:', selections);
            return selections;
        }

        /**
         * Load available subprocesses (lot-scoped then fallback to global)
         */
        async _loadAvailableSubprocesses() {
            logger.debug('📥 Loading available subprocesses for select');
            const { lotId } = this.state.getState();

            let options = [];

            // Try canonical subprocess listing endpoint. Normalize response shapes:
            // - API returns APIResponse.success({ subprocesses: [...], pagination: {...} })
            // - Some endpoints may return raw arrays (older stubs)
            try {
                const resp = await this.api.get(API_PATHS.availableSubprocesses(lotId));
                const body = (resp && (resp.data || resp)) || resp || {};
                if (body && Array.isArray(body.subprocesses)) {
                    options = body.subprocesses;
                } else if (Array.isArray(body)) {
                    options = body;
                } else if (Array.isArray(resp)) {
                    options = resp;
                } else {
                    options = [];
                }
            } catch (err) {
                logger.info('ℹ️ Failed to load subprocesses from canonical endpoint, falling back to global list');
                try {
                    const resp2 = await this.api.get(API_PATHS.availableAllSubprocesses());
                    const body2 = (resp2 && (resp2.data || resp2)) || resp2 || {};
                    if (body2 && Array.isArray(body2.subprocesses)) {
                        options = body2.subprocesses;
                    } else if (Array.isArray(body2)) {
                        options = body2;
                    } else if (Array.isArray(resp2)) {
                        options = resp2;
                    } else {
                        options = [];
                    }
                } catch (err2) {
                    logger.warn('⚠️ Failed to load subprocess list:', err2);
                    options = [];
                }
            }

            // Populate select
            this._populateSubprocessSelect(options);
        }

        /**
         * Populate subprocess select element
         * @param {Array} options
         */
        _populateSubprocessSelect(options = []) {
            const select = findElement(SELECTORS.subprocessSelectForAdd);
            if (!select) {
                logger.debug('ℹ️ Subprocess select element not found for population');
                return;
            }

            const defaultOption = '<option value="">-- Select subprocess --</option>';
            const opts = Array.isArray(options) ? options.map(o => {
                const id = o.subprocess_id || o.id || o.value;
                const name = o.subprocess_name || o.name || o.label || `Subprocess ${id}`;
                return `<option value="${id}">${escapeHtml(name)}</option>`;
            }).join('') : '';

            select.innerHTML = defaultOption + opts;
        }

        /**
         * Display form-level or field-level errors next to an input/select
         * @param {string} selectorString
         * @param {Array|string} errors
         */
        _displayFormErrors(selectorString, errors) {
            const el = findElement(selectorString);
            if (!el) return;

            // Normalize errors to array
            const arr = Array.isArray(errors) ? errors : (errors ? [errors] : []);

            // Find or create error container immediately after the element
            let errEl = el.nextElementSibling;
            if (!errEl || !errEl.classList || !errEl.classList.contains('form-error')) {
                errEl = document.createElement('div');
                errEl.className = 'form-error';
                errEl.style.color = '#dc2626';
                errEl.style.marginTop = '6px';
                if (el.parentNode) el.parentNode.insertBefore(errEl, el.nextSibling);
            }

            if (arr.length === 0) {
                errEl.innerHTML = '';
                errEl.style.display = 'none';
            } else {
                errEl.innerHTML = arr.map(e => `<div>${escapeHtml(String(e))}</div>`).join('');
                errEl.style.display = 'block';
            }
        }

        // =========================
        // Alerts Rendering
        // =========================

        /**
         * Render inventory alerts
         */
        _renderAlerts() {
            logger.debug('🎨 Rendering alerts...');
            const { alerts } = this.state.getState();
            
            const alertsContent = findElement(SELECTORS.alertsContent);
            const alertsTableContainer = findElement(SELECTORS.alertsTableContainer);
            const tbody = findElement(SELECTORS.alertsTableBody);
            const selectAllCheckbox = findElement(SELECTORS.selectAllAlerts);
            const bulkAckBtn = findElement(SELECTORS.bulkAcknowledgeBtn);
            const alertsCountBadge = findElement(SELECTORS.alertsCountBadge);

            if (!tbody) {
                logger.debug('ℹ️ Alert table body not found');
                return;
            }

            // Update count badge
            if (alertsCountBadge) {
                alertsCountBadge.textContent = alerts.length ? `${alerts.length} Alert${alerts.length !== 1 ? 's' : ''}` : '';
            }

            if (!alerts || alerts.length === 0) {
                if (alertsContent) {
                    alertsContent.innerHTML = '<p class="empty-state">No inventory alerts</p>';
                    alertsContent.classList.remove('loading-state');
                }
                if (alertsTableContainer) alertsTableContainer.style.display = 'none';
                if (selectAllCheckbox) selectAllCheckbox.checked = false;
                if (bulkAckBtn) bulkAckBtn.disabled = true;
                logger.debug('ℹ️ No alerts to display');
                return;
            }

            // Show table container and hide loading state
            if (alertsContent) alertsContent.style.display = 'none';
            if (alertsTableContainer) alertsTableContainer.style.display = 'block';

            const html = alerts.map(alert => this._renderAlertRow(alert)).join('');
            tbody.innerHTML = html;

            // Update select-all state
            this._updateSelectAllState();
            
            logger.debug(`✅ Rendered ${alerts.length} alerts`);
        }

        /**
         * Render single alert row
         */
        _renderAlertRow(alert) {
            const isAcked = alert.status === 'ACKNOWLEDGED';
            const severityConfig = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.WARNING;

            return `
                <tr data-alert-id="${alert.alert_id}">
                    <td>
                        <input type="checkbox" 
                               class="alert-checkbox" 
                               data-alert-id="${alert.alert_id}"
                               ${isAcked ? 'disabled' : ''}>
                    </td>
                    <td><span class="status ${severityConfig.class}">${escapeHtml(alert.severity)}</span></td>
                    <td>${escapeHtml(alert.variant_name || 'N/A')}</td>
                    <td>${escapeHtml(alert.variant_sku || 'N/A')}</td>
                    <td>${alert.current_stock ?? 'N/A'}</td>
                    <td>${alert.required_quantity ?? 'N/A'}</td>
                    <td>${alert.shortfall ?? 'N/A'}</td>
                    <td>${alert.suggested_procurement ?? 'N/A'}</td>
                    <td>
                        ${isAcked 
                            ? '<span class="status status--success">Acknowledged</span>'
                            : `<button class="btn btn--secondary btn--sm" 
                                       data-action="ack-alert" 
                                       data-alert-id="${alert.alert_id}">
                                    Acknowledge
                                </button>`
                        }
                    </td>
                </tr>
            `;
        }

        /**
         * Handle select all alerts checkbox
         */
        _handleSelectAllAlerts(e) {
            logger.debug('☑️ Handle select all alerts:', e.target.checked);
            const checked = e.target.checked;
            const checkboxes = document.querySelectorAll('.alert-checkbox:not(:disabled)');
            
            checkboxes.forEach(cb => {
                cb.checked = checked;
            });

            this._updateBulkAckButton();
        }

        /**
         * Update select-all checkbox state
         */
        _updateSelectAllState() {
            const selectAllCheckbox = findElement(SELECTORS.selectAllAlertsCheckbox);
            if (!selectAllCheckbox) return;

            const checkboxes = Array.from(document.querySelectorAll('.alert-checkbox:not(:disabled)'));
            if (checkboxes.length === 0) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = false;
                return;
            }

            const checkedCount = checkboxes.filter(cb => cb.checked).length;

            if (checkedCount === 0) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = false;
            } else if (checkedCount === checkboxes.length) {
                selectAllCheckbox.checked = true;
                selectAllCheckbox.indeterminate = false;
            } else {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = true;
            }

            this._updateBulkAckButton();
        }

        /**
         * Update bulk acknowledge button state
         */
        _updateBulkAckButton() {
            const bulkAckBtn = findElement(SELECTORS.bulkAckBtn);
            if (!bulkAckBtn) return;

            const checkedCount = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)').length;
            bulkAckBtn.disabled = checkedCount === 0;
        }

        /**
         * Handle acknowledge single alert
         */
        async _handleAcknowledgeAlert(e, target) {
            // Defensive: resolve target if not provided
            if (!target && e && e.target) {
                target = e.target.closest('[data-action="ack-alert"]');
            }

            if (!target) return;

            const alertId = target.dataset.alertId;
            logger.debug('✅ Handle acknowledge alert:', alertId);
            
            if (!alertId) return;

            this.spinner.showInButton(target);

            try {
                await this.api.post(API_PATHS.alertAck(alertId));

                this.toast.success('Alert acknowledged');

                // Update state
                const { alerts } = this.state.getState();
                const updatedAlerts = alerts.map(alert => 
                    alert.alert_id === parseInt(alertId)
                        ? { ...alert, status: 'ACKNOWLEDGED' }
                        : alert
                );

                this.state.setState({ alerts: updatedAlerts });

                // Re-render
                this._renderAlerts();
                this._updateFinalizeButton();

            } catch (error) {
                logger.error('❌ Error acknowledging alert:', error);
                this.toast.error('Failed to acknowledge alert');
                this.spinner.hideInButton(target);
            }
        }

        /**
         * Handle bulk acknowledge alerts
         */
        async _handleBulkAcknowledge() {
            logger.debug('✅ Handle bulk acknowledge');
            const checkedBoxes = Array.from(
                document.querySelectorAll('.alert-checkbox:checked:not(:disabled)')
            );

            if (checkedBoxes.length === 0) return;

            const bulkAckBtn = findElement(SELECTORS.bulkAckBtn);
            this.spinner.showInButton(bulkAckBtn);

            try {
                const alertIds = checkedBoxes.map(cb => parseInt(cb.dataset.alertId));
                logger.debug('📤 Bulk acknowledging alerts:', alertIds);

                await this.api.post(API_PATHS.alertBulkAck(), { alert_ids: alertIds });

                this.toast.success(`${alertIds.length} alert(s) acknowledged`);

                // Update state
                const { alerts } = this.state.getState();
                const alertIdSet = new Set(alertIds);
                const updatedAlerts = alerts.map(alert =>
                    alertIdSet.has(alert.alert_id)
                        ? { ...alert, status: 'ACKNOWLEDGED' }
                        : alert
                );

                this.state.setState({ alerts: updatedAlerts });

                // Re-render
                this._renderAlerts();
                this._updateFinalizeButton();

            } catch (error) {
                logger.error('❌ Error bulk acknowledging alerts:', error);
                this.toast.error('Failed to acknowledge alerts');
            } finally {
                this.spinner.hideInButton(bulkAckBtn);
            }
        }

        // =========================
        // Public API
        // =========================

        /**
         * Refresh all data
         */
        async refresh() {
            logger.info('🔄 Refreshing all data');
            await this._loadAllData();
        }

        /**
         * Update total cost (for external use)
         */
        updateTotalCost(newCost) {
            logger.debug('💰 Updating total cost:', newCost);
            this.state.setState({
                lot: {
                    ...this.state.getState().lot,
                    total_cost: newCost
                }
            });
            this._renderLotDetails();
        }

        /**
         * Cleanup on destroy
         */
        destroy() {
            logger.info('🧹 Destroying controller');
            this._cleanupEventListeners();
            this.state.listeners = [];
        }
    }

    // =========================
    // Auto-initialize on DOM ready
    // =========================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            logger.info('📄 DOM loaded - initializing controller');
            window.lotDetailController = new ProductionLotDetailController();
            window.lotDetailController.init();
        });
    } else {
        logger.info('📄 DOM already loaded - initializing controller immediately');
        window.lotDetailController = new ProductionLotDetailController();
        window.lotDetailController.init();
    }

    // Add spinner animation CSS if not present
    if (!document.getElementById('spinner-animation')) {
        const style = document.createElement('style');
        style.id = 'spinner-animation';
        style.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

})();