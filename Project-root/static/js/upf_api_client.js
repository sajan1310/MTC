/**
 * Universal Process Framework API Client
 * Centralized API layer with caching, deduplication, and event-driven updates
 * 
 * Features:
 * - Request deduplication (prevents multiple simultaneous requests)
 * - Response caching with TTL
 * - Event-driven updates (notify all components of changes)
 * - Optimistic updates
 * - Error handling and retry logic
 */

class UPFApiClient {
    constructor() {
        this.cache = new Map();
        this.pendingRequests = new Map();
        this.cacheConfig = {
            processes: { ttl: 60000 },      // 1 minute
            subprocesses: { ttl: 300000 },   // 5 minutes
            metadata: { ttl: 3600000 },      // 1 hour
            productionLots: { ttl: 30000 }   // 30 seconds
        };
        this.eventBus = new EventTarget();
    }

    /**
     * Normalize and build query string for API calls.
     * Ensures `perPage` (camelCase) is mapped to `per_page` (snake_case)
     * and prevents duplicate keys when spreading `params`.
     */
    _buildQueryString(params = {}, defaults = { per_page: 1000, page: 1 }) {
        const p = { ...params };

        // Prefer explicit camelCase `perPage` mapping to snake_case `per_page`
        if (p.perPage !== undefined) {
            p.per_page = p.perPage;
            delete p.perPage;
        }

        // Apply defaults only when not present
        for (const [k, v] of Object.entries(defaults)) {
            if (p[k] === undefined || p[k] === null || p[k] === "") p[k] = v;
        }

        return new URLSearchParams(p).toString();
    }
    /**
     * Generic fetch with caching and deduplication
     */
    async fetch(url, options = {}, cacheKey = null, ttl = 60000) {
        // Check cache first
        if (cacheKey && !options.skipCache) {
            const cached = this.getFromCache(cacheKey);
            if (cached) {
                console.log(`[UPF API] Cache hit: ${cacheKey}`);
                return cached;
            }
        }

        // Check for pending request (deduplication)
        const requestKey = cacheKey || url;
        if (this.pendingRequests.has(requestKey)) {
            console.log(`[UPF API] Request in flight, waiting: ${requestKey}`);
            return this.pendingRequests.get(requestKey);
        }

        // Make the request
        const requestPromise = this._makeRequest(url, options);
        this.pendingRequests.set(requestKey, requestPromise);

        try {
            const data = await requestPromise;
            
            // Cache the result
            if (cacheKey && !options.skipCache) {
                this.setInCache(cacheKey, data, ttl);
            }

            return data;
        } finally {
            this.pendingRequests.delete(requestKey);
        }
    }

    /**
     * Internal request handler
     */
    async _makeRequest(url, options = {}) {
        const defaultOptions = {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const finalOptions = { ...defaultOptions, ...options };
        if (finalOptions.body && typeof finalOptions.body === 'object') {
            finalOptions.body = JSON.stringify(finalOptions.body);
        }

        console.log(`[UPF API] ${finalOptions.method} ${url}`);
        const response = await fetch(url, finalOptions);

        if (response.status === 401) {
            window.location.href = '/auth/login';
            throw new Error('Unauthorized');
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
    }

    /**
     * Cache management
     */
    getFromCache(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        return item.data;
    }

    setInCache(key, data, ttl) {
        this.cache.set(key, {
            data,
            expires: Date.now() + ttl
        });
    }

    invalidateCache(pattern) {
        if (pattern === '*') {
            this.cache.clear();
            console.log('[UPF API] Cache cleared');
        } else {
            const keysToDelete = [];
            for (const key of this.cache.keys()) {
                if (key.includes(pattern)) {
                    keysToDelete.push(key);
                }
            }
            keysToDelete.forEach(k => this.cache.delete(k));
            console.log(`[UPF API] Invalidated ${keysToDelete.length} cache entries matching: ${pattern}`);
        }
    }

    /**
     * Event bus for cross-component communication
     */
    on(eventName, callback) {
        this.eventBus.addEventListener(eventName, callback);
    }

    off(eventName, callback) {
        this.eventBus.removeEventListener(eventName, callback);
    }

    emit(eventName, detail = {}) {
        console.log(`[UPF API Event] ${eventName}`, detail);
        this.eventBus.dispatchEvent(new CustomEvent(eventName, { detail }));
    }

    // ============================================
    // PROCESSES API
    // ============================================

    async getProcesses(params = {}) {
        const queryString = this._buildQueryString(params, { per_page: 1000, page: 1 });

        const url = `/api/upf/processes?${queryString}`;
        const cacheKey = `processes:${queryString}`;

        const data = await this.fetch(url, {}, cacheKey, this.cacheConfig.processes.ttl);
        return data.data?.processes || data.processes || [];
    }

    async getProcess(id) {
        const url = `/api/upf/processes/${id}`;
        const cacheKey = `process:${id}`;
        
        return this.fetch(url, {}, cacheKey, this.cacheConfig.processes.ttl);
    }

    async createProcess(processData) {
        const data = await this.fetch('/api/upf/processes', {
            method: 'POST',
            body: processData,
            skipCache: true
        });
        
        this.invalidateCache('processes:');
        this.emit('process:created', { process: data });
        return data;
    }

    async updateProcess(id, processData) {
        const data = await this.fetch(`/api/upf/processes/${id}`, {
            method: 'PUT',
            body: processData,
            skipCache: true
        });
        
        this.invalidateCache('processes:');
        this.invalidateCache(`process:${id}`);
        this.emit('process:updated', { process: data, id });
        return data;
    }

    async deleteProcess(id) {
        const data = await this.fetch(`/api/upf/processes/${id}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.invalidateCache('processes:');
        this.invalidateCache(`process:${id}`);
        this.emit('process:deleted', { id });
        return data;
    }

    async getProcessMetadata() {
        const cacheKey = 'metadata:processes';
        return this.fetch('/api/upf/processes/metadata', {}, cacheKey, this.cacheConfig.metadata.ttl);
    }

    // ============================================
    // SUBPROCESSES API
    // ============================================

    async getSubprocesses(params = {}) {
        const queryString = this._buildQueryString(params, { per_page: 1000, page: 1 });

        const url = `/api/upf/subprocesses?${queryString}`;
        const cacheKey = `subprocesses:${queryString}`;

        const data = await this.fetch(url, {}, cacheKey, this.cacheConfig.subprocesses.ttl);
        return data.data?.subprocesses || data.subprocesses || [];
    }

    async getSubprocess(id) {
        const url = `/api/upf/subprocesses/${id}`;
        const cacheKey = `subprocess:${id}`;
        
        return this.fetch(url, {}, cacheKey, this.cacheConfig.subprocesses.ttl);
    }

    async createSubprocess(subprocessData) {
        const data = await this.fetch('/api/upf/subprocesses', {
            method: 'POST',
            body: subprocessData,
            skipCache: true
        });
        
        this.invalidateCache('subprocesses:');
        this.emit('subprocess:created', { subprocess: data });
        return data;
    }

    async updateSubprocess(id, subprocessData) {
        const data = await this.fetch(`/api/upf/subprocesses/${id}`, {
            method: 'PUT',
            body: subprocessData,
            skipCache: true
        });
        
        this.invalidateCache('subprocesses:');
        this.invalidateCache(`subprocess:${id}`);
        this.emit('subprocess:updated', { subprocess: data, id });
        return data;
    }

    async deleteSubprocess(id) {
        const data = await this.fetch(`/api/upf/subprocesses/${id}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.invalidateCache('subprocesses:');
        this.invalidateCache(`subprocess:${id}`);
        this.emit('subprocess:deleted', { id });
        return data;
    }

    async getSubprocessMetadata() {
        const cacheKey = 'metadata:subprocesses';
        return this.fetch('/api/upf/subprocesses/metadata', {}, cacheKey, this.cacheConfig.metadata.ttl);
    }

    // ============================================
    // PRODUCTION LOTS API
    // ============================================

    async getProductionLots(params = {}) {
        const queryString = this._buildQueryString(params, { per_page: 1000, page: 1 });

        const url = `/api/upf/production-lots?${queryString}`;
        const cacheKey = `production-lots:${queryString}`;

        const data = await this.fetch(url, {}, cacheKey, this.cacheConfig.productionLots.ttl);
        return data.data?.production_lots || data.production_lots || [];
    }

    async getProductionLot(id) {
        const url = `/api/upf/production-lots/${id}`;
        const cacheKey = `production-lot:${id}`;
        
        return this.fetch(url, {}, cacheKey, this.cacheConfig.productionLots.ttl);
    }

    async createProductionLot(lotData) {
        const data = await this.fetch('/api/upf/production-lots', {
            method: 'POST',
            body: lotData,
            skipCache: true
        });
        
        this.invalidateCache('production-lots:');
        this.emit('production-lot:created', { lot: data });
        return data;
    }

    async updateProductionLot(id, lotData) {
        const data = await this.fetch(`/api/upf/production-lots/${id}`, {
            method: 'PUT',
            body: lotData,
            skipCache: true
        });
        
        this.invalidateCache('production-lots:');
        this.invalidateCache(`production-lot:${id}`);
        this.emit('production-lot:updated', { lot: data, id });
        return data;
    }

    async deleteProductionLot(id) {
        const data = await this.fetch(`/api/upf/production-lots/${id}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.invalidateCache('production-lots:');
        this.invalidateCache(`production-lot:${id}`);
        this.emit('production-lot:deleted', { id });
        return data;
    }

    // ============================================
    // PROCESS-SUBPROCESS ASSOCIATIONS
    // ============================================

    async addSubprocessToProcess(processId, data) {
        const result = await this.fetch(`/api/upf/processes/${processId}/subprocesses`, {
            method: 'POST',
            body: data,
            skipCache: true
        });
        
        this.invalidateCache(`process:${processId}`);
        this.emit('process:subprocess-added', { processId, subprocess: result });
        return result;
    }

    async removeSubprocessFromProcess(processId, processSubprocessId) {
        const result = await this.fetch(`/api/upf/processes/${processId}/subprocesses/${processSubprocessId}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.invalidateCache(`process:${processId}`);
        this.emit('process:subprocess-removed', { processId, processSubprocessId });
        return result;
    }

    // ============================================
    // VARIANTS API
    // ============================================

    async addVariantToSubprocess(processSubprocessId, data) {
        const result = await this.fetch(`/api/upf/variant_usage`, {
            method: 'POST',
            body: { ...data, process_subprocess_id: processSubprocessId },
            skipCache: true
        });
        
        this.emit('subprocess:variant-added', { processSubprocessId, variant: result });
        return result;
    }

    async updateVariantUsage(variantUsageId, data) {
        const result = await this.fetch(`/api/upf/variant_usage/${variantUsageId}`, {
            method: 'PUT',
            body: data,
            skipCache: true
        });
        
        this.emit('subprocess:variant-updated', { variantUsageId, variant: result });
        return result;
    }

    async deleteVariantUsage(variantUsageId) {
        const result = await this.fetch(`/api/upf/variant_usage/${variantUsageId}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.emit('subprocess:variant-deleted', { variantUsageId });
        return result;
    }

    // ============================================
    // COST ITEMS API
    // ============================================

    async createCostItem(data) {
        const result = await this.fetch('/api/upf/cost_item', {
            method: 'POST',
            body: data,
            skipCache: true
        });
        
        this.emit('subprocess:cost-item-created', { costItem: result });
        return result;
    }

    async updateCostItem(costItemId, data) {
        const result = await this.fetch(`/api/upf/cost_item/${costItemId}`, {
            method: 'PUT',
            body: data,
            skipCache: true
        });
        
        this.emit('subprocess:cost-item-updated', { costItemId, costItem: result });
        return result;
    }

    async deleteCostItem(costItemId) {
        const result = await this.fetch(`/api/upf/cost_item/${costItemId}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.emit('subprocess:cost-item-deleted', { costItemId });
        return result;
    }

    // ============================================
    // SUBSTITUTE GROUPS API
    // ============================================

    async createSubstituteGroup(data) {
        const result = await this.fetch('/api/upf/substitute_group', {
            method: 'POST',
            body: data,
            skipCache: true
        });
        
        this.emit('subprocess:substitute-group-created', { group: result });
        return result;
    }

    async deleteSubstituteGroup(groupId) {
        const result = await this.fetch(`/api/upf/substitute_group/${groupId}`, {
            method: 'DELETE',
            skipCache: true
        });
        
        this.emit('subprocess:substitute-group-deleted', { groupId });
        return result;
    }
}

// Create global singleton instance
window.upfApi = new UPFApiClient();

console.log('[UPF API] Client initialized with caching, deduplication, and events');
