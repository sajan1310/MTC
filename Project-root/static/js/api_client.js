/**
 * Unified API Client with Standardized Error Handling
 * 
 * This is an OPTIONAL enhancement. The current implementation with direct fetch calls
 * works fine. This utility provides:
 * - Centralized error handling
 * - Automatic retry logic
 * - Standardized request formatting
 * - Loading state management
 * 
 * Usage:
 * import APIClient from './api_client.js';
 * 
 * const data = await APIClient.get('/processes/123');
 * const created = await APIClient.post('/processes', { name: 'New Process' });
 */

class APIClient {
    static BASE_URL = '/api/upf';
    
    /**
     * Make API request with standardized error handling
     * 
     * @param {string} path - API endpoint path (e.g., '/processes/123')
     * @param {Object} options - Request options
     * @param {string} options.method - HTTP method (GET, POST, PUT, DELETE)
     * @param {Object|FormData} options.body - Request body
     * @param {Object} options.headers - Additional headers
     * @param {Function} options.onError - Custom error handler (msg, errorCode, status)
     * @param {Function} options.onLoading - Loading state callback (isLoading: boolean)
     * @param {boolean} options.showError - Show error modal (default: true)
     * @param {number} options.retryCount - Number of retry attempts (default: 0)
     * @returns {Promise<any>} Response data or null on error
     */
    static async request(path, options = {}) {
        const {
            method = 'GET',
            body = null,
            headers = {},
            onError = null,
            onLoading = null,
            showError = true,
            retryCount = 0
        } = options;

        // Show loading indicator
        if (onLoading) onLoading(true);

        try {
            const url = path.startsWith('http') ? path : `${this.BASE_URL}${path}`;
            
            const fetchOptions = {
                method,
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...headers
                }
            };

            if (body) {
                if (body instanceof FormData) {
                    // Let browser set Content-Type for FormData
                    delete fetchOptions.headers['Content-Type'];
                    fetchOptions.body = body;
                } else {
                    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
                }
            }

            const response = await fetch(url, fetchOptions);
            
            // Parse JSON response
            let data;
            try {
                data = await response.json();
            } catch (jsonError) {
                // If response is not JSON, create error object
                data = {
                    success: false,
                    error: 'invalid_response',
                    message: `Server returned non-JSON response: ${response.statusText}`
                };
            }

            // Check for API-level error
            if (!response.ok || data.error) {
                const errorMsg = data.message || data.error || `HTTP ${response.status}`;
                console.error(`API Error (${data.error || response.status}):`, errorMsg);
                
                if (onError) {
                    onError(errorMsg, data.error, response.status);
                } else if (showError) {
                    this.showErrorModal(errorMsg, {
                        retry: retryCount > 0 ? () => this.request(path, { 
                            ...options, 
                            retryCount: retryCount - 1 
                        }) : null
                    });
                }
                return null;
            }

            // Return actual data (unwrap from standardized response)
            return data.data !== undefined ? data.data : data;

        } catch (err) {
            const errorMsg = `Network error: ${err.message}`;
            console.error(errorMsg, err);
            
            if (onError) {
                onError(errorMsg, 'network_error', 0);
            } else if (showError) {
                this.showErrorModal(errorMsg, {
                    retry: retryCount > 0 ? () => this.request(path, { 
                        ...options, 
                        retryCount: retryCount - 1 
                    }) : () => this.request(path, options)
                });
            }
            return null;
        } finally {
            if (onLoading) onLoading(false);
        }
    }

    /**
     * GET request
     * @param {string} path - API endpoint path
     * @param {Object} options - Request options
     * @returns {Promise<any>}
     */
    static get(path, options = {}) {
        return this.request(path, { ...options, method: 'GET' });
    }

    /**
     * POST request
     * @param {string} path - API endpoint path
     * @param {Object} body - Request body
     * @param {Object} options - Request options
     * @returns {Promise<any>}
     */
    static post(path, body, options = {}) {
        return this.request(path, { ...options, method: 'POST', body });
    }

    /**
     * PUT request
     * @param {string} path - API endpoint path
     * @param {Object} body - Request body
     * @param {Object} options - Request options
     * @returns {Promise<any>}
     */
    static put(path, body, options = {}) {
        return this.request(path, { ...options, method: 'PUT', body });
    }

    /**
     * DELETE request
     * @param {string} path - API endpoint path
     * @param {Object} options - Request options
     * @returns {Promise<any>}
     */
    static delete(path, options = {}) {
        return this.request(path, { ...options, method: 'DELETE' });
    }

    /**
     * Show error modal with optional retry button
     * @param {string} message - Error message to display
     * @param {Object} actions - Action buttons
     * @param {Function} actions.retry - Retry callback
     */
    static showErrorModal(message, actions = {}) {
        // Remove existing modal if present
        const existingModal = document.getElementById('apiErrorModal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'apiErrorModal';
        modal.className = 'modal fade show';
        modal.style.display = 'block';
        modal.setAttribute('tabindex', '-1');
        
        modal.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header bg-danger text-white">
                        <h5 class="modal-title">
                            <i class="fas fa-exclamation-triangle"></i> Error
                        </h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p>${message}</p>
                    </div>
                    <div class="modal-footer">
                        ${actions.retry ? '<button id="retryBtn" class="btn btn-primary">Retry</button>' : ''}
                        <button id="closeBtn" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        backdrop.id = 'apiErrorBackdrop';
        
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);

        // Event handlers
        const closeModal = () => {
            modal.remove();
            backdrop.remove();
        };

        if (actions.retry) {
            document.getElementById('retryBtn').addEventListener('click', () => {
                closeModal();
                actions.retry();
            });
        }

        document.getElementById('closeBtn').addEventListener('click', closeModal);
        modal.querySelector('.btn-close').addEventListener('click', closeModal);
        
        // Close on backdrop click
        backdrop.addEventListener('click', closeModal);
    }

    /**
     * Show success toast notification
     * @param {string} message - Success message
     */
    static showSuccess(message) {
        // Create toast container if not exists
        let toastContainer = document.getElementById('toastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'toastContainer';
            toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = 'toast align-items-center text-bg-success border-0 show';
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">
                    <i class="fas fa-check-circle"></i> ${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        `;

        toastContainer.appendChild(toast);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);

        // Manual close
        toast.querySelector('.btn-close').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        });
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = APIClient;
}

/**
 * USAGE EXAMPLES:
 * 
 * // 1. Simple GET request
 * const processes = await APIClient.get('/processes');
 * 
 * // 2. POST with custom error handling
 * const newProcess = await APIClient.post('/processes', 
 *     { name: 'New Process', description: 'Test' },
 *     {
 *         onError: (msg) => alert('Failed: ' + msg),
 *         onLoading: (loading) => showSpinner(loading)
 *     }
 * );
 * 
 * // 3. GET with auto-retry
 * const structure = await APIClient.get('/processes/123/structure', {
 *     retryCount: 2  // Will retry twice on failure
 * });
 * 
 * // 4. DELETE with loading state
 * let isDeleting = false;
 * const deleted = await APIClient.delete('/processes/123', {
 *     onLoading: (loading) => {
 *         isDeleting = loading;
 *         document.getElementById('deleteBtn').disabled = loading;
 *     }
 * });
 * 
 * // 5. Show success message
 * if (newProcess) {
 *     APIClient.showSuccess('Process created successfully!');
 * }
 */
