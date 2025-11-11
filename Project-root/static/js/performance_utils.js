/**
 * Performance Optimization Utilities
 * Provides debouncing, throttling, memoization, and DOM optimization utilities
 */

const PerformanceUtils = {
    /**
     * Debounce function - delays execution until after wait time
     * Use for search inputs, resize handlers
     */
    debounce(func, wait = 300) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Throttle function - limits execution to once per wait time
     * Use for scroll handlers, frequent events
     */
    throttle(func, wait = 300) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, wait);
            }
        };
    },

    /**
     * Memoize function - cache results based on arguments
     * Use for expensive calculations with repeated inputs
     */
    memoize(func) {
        const cache = new Map();
        return function(...args) {
            const key = JSON.stringify(args);
            if (cache.has(key)) {
                console.log('[Memoize] Cache hit:', key.substring(0, 50));
                return cache.get(key);
            }
            const result = func.apply(this, args);
            cache.set(key, result);
            return result;
        };
    },

    /**
     * Batch DOM updates - group multiple DOM changes
     * Use when updating multiple elements
     */
    batchDOMUpdate(callback) {
        requestAnimationFrame(() => {
            callback();
        });
    },

    /**
     * Virtual scroll - only render visible items
     * Use for long lists (100+ items)
     */
    createVirtualScroll(container, items, renderItem, itemHeight = 80) {
        const viewportHeight = container.clientHeight;
        const totalHeight = items.length * itemHeight;
        const visibleCount = Math.ceil(viewportHeight / itemHeight);
        const buffer = 5; // Extra items to render above/below viewport
        
        let scrollTop = 0;
        
        const render = () => {
            const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
            const endIndex = Math.min(items.length, startIndex + visibleCount + (buffer * 2));
            
            const visibleItems = items.slice(startIndex, endIndex);
            const offsetY = startIndex * itemHeight;
            
            container.innerHTML = `
                <div style="height: ${totalHeight}px; position: relative;">
                    <div style="transform: translateY(${offsetY}px);">
                        ${visibleItems.map(renderItem).join('')}
                    </div>
                </div>
            `;
        };
        
        const onScroll = this.throttle(() => {
            scrollTop = container.scrollTop;
            render();
        }, 100);
        
        container.addEventListener('scroll', onScroll);
        render();
        
        return {
            update: (newItems) => {
                items = newItems;
                render();
            },
            destroy: () => {
                container.removeEventListener('scroll', onScroll);
            }
        };
    },

    /**
     * Lazy load images - only load when visible
     */
    lazyLoadImages(selector = '[data-lazy-src]') {
        const imageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.lazySrc;
                    img.removeAttribute('data-lazy-src');
                    imageObserver.unobserve(img);
                }
            });
        });
        
        document.querySelectorAll(selector).forEach(img => {
            imageObserver.observe(img);
        });
    },

    /**
     * Progressive rendering - render in chunks to avoid blocking UI
     */
    progressiveRender(items, renderItem, container, chunkSize = 50) {
        let index = 0;
        
        const renderChunk = () => {
            const chunk = items.slice(index, index + chunkSize);
            const fragment = document.createDocumentFragment();
            
            chunk.forEach(item => {
                const element = renderItem(item);
                if (typeof element === 'string') {
                    const temp = document.createElement('div');
                    temp.innerHTML = element;
                    fragment.appendChild(temp.firstChild);
                } else {
                    fragment.appendChild(element);
                }
            });
            
            container.appendChild(fragment);
            index += chunkSize;
            
            if (index < items.length) {
                requestAnimationFrame(renderChunk);
            }
        };
        
        renderChunk();
    },

    /**
     * Measure rendering performance
     */
    measureRender(name, callback) {
        const start = performance.now();
        callback();
        const end = performance.now();
        console.log(`[Performance] ${name}: ${(end - start).toFixed(2)}ms`);
    },

    /**
     * Create skeleton loader for better perceived performance
     */
    createSkeleton(count = 3, type = 'card') {
        const skeletons = {
            card: `
                <div class="skeleton-card">
                    <div class="skeleton-header"></div>
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line short"></div>
                </div>
            `,
            row: `
                <div class="skeleton-row">
                    <div class="skeleton-cell"></div>
                    <div class="skeleton-cell"></div>
                    <div class="skeleton-cell"></div>
                </div>
            `
        };
        
        return Array(count).fill(skeletons[type] || skeletons.card).join('');
    },

    /**
     * Optimize DOM selectors - cache frequently used elements
     */
    createElementCache() {
        const cache = {};
        return {
            get(selector) {
                if (!cache[selector]) {
                    cache[selector] = document.querySelector(selector);
                }
                return cache[selector];
            },
            getAll(selector) {
                if (!cache[selector]) {
                    cache[selector] = Array.from(document.querySelectorAll(selector));
                }
                return cache[selector];
            },
            clear() {
                for (const key in cache) {
                    delete cache[key];
                }
            }
        };
    },

    /**
     * Detect slow operations and warn
     */
    warnSlowOperation(name, duration, threshold = 100) {
        if (duration > threshold) {
            console.warn(`[Performance Warning] ${name} took ${duration.toFixed(2)}ms (threshold: ${threshold}ms)`);
        }
    },

    /**
     * Create optimized event listener that auto-removes
     */
    addOptimizedListener(element, event, handler, options = {}) {
        const optimizedHandler = options.debounce 
            ? this.debounce(handler, options.debounce)
            : options.throttle
            ? this.throttle(handler, options.throttle)
            : handler;
            
        element.addEventListener(event, optimizedHandler, options.passive || false);
        
        return () => element.removeEventListener(event, optimizedHandler);
    }
};

// Add skeleton CSS if not present
if (!document.getElementById('skeleton-styles')) {
    const style = document.createElement('style');
    style.id = 'skeleton-styles';
    style.textContent = `
        .skeleton-card {
            background: #f5f5f5;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
            animation: skeleton-pulse 1.5s ease-in-out infinite;
        }
        
        .skeleton-header {
            height: 24px;
            background: #e0e0e0;
            border-radius: 4px;
            margin-bottom: 15px;
            width: 60%;
        }
        
        .skeleton-line {
            height: 16px;
            background: #e0e0e0;
            border-radius: 4px;
            margin-bottom: 10px;
        }
        
        .skeleton-line.short {
            width: 40%;
        }
        
        .skeleton-row {
            display: flex;
            gap: 10px;
            padding: 15px;
            background: #f5f5f5;
            margin-bottom: 10px;
            border-radius: 4px;
        }
        
        .skeleton-cell {
            height: 20px;
            background: #e0e0e0;
            border-radius: 4px;
            flex: 1;
        }
        
        @keyframes skeleton-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    `;
    document.head.appendChild(style);
}

window.PerformanceUtils = PerformanceUtils;

console.log('[Performance Utils] Utilities loaded: debounce, throttle, memoize, virtualScroll, progressive rendering');
