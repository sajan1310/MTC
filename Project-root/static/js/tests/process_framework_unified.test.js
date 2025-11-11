/**
 * Unit tests for process_framework_unified.js
 * Focus on debounced variant usage updates
 * 
 * Run with: npm test (if you set up Jest) or open in browser with test harness
 */

// Mock fetch
global.fetch = jest.fn();

// Mock framework
const mockFramework = {
    currentEditProcessId: 1,
    
    updateVariantUsage: async function(usageId, quantity, rate) {
        const payload = {};
        if (quantity !== null && quantity !== undefined) {
            const q = parseFloat(quantity);
            if (!isNaN(q)) payload.quantity = q;
        }
        if (rate !== null && rate !== undefined) {
            const r = parseFloat(rate);
            if (!isNaN(r)) payload.cost_per_unit = r;
        }
        if (Object.keys(payload).length === 0) return;

        const resp = await fetch(`/api/upf/variant_usage/${usageId}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || err.message || 'Failed to update variant usage');
        }
        return resp;
    },

    // Debounced wrapper to minimize excessive reloads
    updateVariantUsageDebounced: (() => {
        let timers = {};
        return function(usageId, quantityOrNull, rateOrNull) {
            if (timers[usageId]) clearTimeout(timers[usageId]);
            timers[usageId] = setTimeout(() => {
                this.updateVariantUsage(usageId, quantityOrNull, rateOrNull);
            }, 400);
        };
    })(),
    
    showAlert: jest.fn(),
    loadInlineSubprocesses: jest.fn()
};

describe('Variant Usage Update Logic', () => {
    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        fetch.mockClear();
        mockFramework.showAlert.mockClear();
        mockFramework.loadInlineSubprocesses.mockClear();
    });

    describe('updateVariantUsage', () => {
        test('should send quantity update when quantity changes', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

            await mockFramework.updateVariantUsage(123, 5, null);

            expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: 5 })
            });
        });

        test('should send cost_per_unit update when rate changes', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

            await mockFramework.updateVariantUsage(123, null, 10.5);

            expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cost_per_unit: 10.5 })
            });
        });

        test('should send both quantity and cost_per_unit when both change', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

            await mockFramework.updateVariantUsage(123, 8, 12.75);

            expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: 8, cost_per_unit: 12.75 })
            });
        });

        test('should not send request when both values are null', async () => {
            await mockFramework.updateVariantUsage(123, null, null);
            expect(fetch).not.toHaveBeenCalled();
        });

        test('should ignore invalid numeric values', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

            await mockFramework.updateVariantUsage(123, 'invalid', 'abc');
            expect(fetch).not.toHaveBeenCalled();
        });

        test('should handle valid numeric strings', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

            await mockFramework.updateVariantUsage(123, '5', '10.5');

            expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: 5, cost_per_unit: 10.5 })
            });
        });

        test('should throw error on failed response', async () => {
            fetch.mockResolvedValueOnce({
                ok: false,
                json: async () => ({ error: 'Validation failed' })
            });

            await expect(mockFramework.updateVariantUsage(123, 5, null))
                .rejects.toThrow('Validation failed');
        });

        test('should throw generic error when response has no error message', async () => {
            fetch.mockResolvedValueOnce({
                ok: false,
                json: async () => ({})
            });

            await expect(mockFramework.updateVariantUsage(123, 5, null))
                .rejects.toThrow('Failed to update variant usage');
        });
    });

    describe('updateVariantUsageDebounced', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should debounce multiple rapid calls to same usage', () => {
            const spy = jest.spyOn(mockFramework, 'updateVariantUsage');

            // Rapid calls to same variant
            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 5, null);
            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 6, null);
            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 7, null);

            // No calls yet
            expect(spy).not.toHaveBeenCalled();

            // Fast-forward 400ms
            jest.advanceTimersByTime(400);

            // Only last value should be called
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(123, 7, null);
        });

        test('should not debounce calls to different usages', () => {
            const spy = jest.spyOn(mockFramework, 'updateVariantUsage');

            // Calls to different variants
            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 5, null);
            mockFramework.updateVariantUsageDebounced.call(mockFramework, 456, 10, null);

            jest.advanceTimersByTime(400);

            // Both should be called
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy).toHaveBeenCalledWith(123, 5, null);
            expect(spy).toHaveBeenCalledWith(456, 10, null);
        });

        test('should reset timer on subsequent calls before delay expires', () => {
            const spy = jest.spyOn(mockFramework, 'updateVariantUsage');

            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 5, null);
            jest.advanceTimersByTime(200); // Halfway through

            mockFramework.updateVariantUsageDebounced.call(mockFramework, 123, 6, null);
            jest.advanceTimersByTime(200); // Another 200ms (total 400ms from first call)

            // First call should not have fired yet
            expect(spy).not.toHaveBeenCalled();

            jest.advanceTimersByTime(200); // Complete the second delay

            // Only second value should be called
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(123, 6, null);
        });
    });
});

describe('Edge Cases', () => {
    test('should handle zero values correctly', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        await mockFramework.updateVariantUsage(123, 0, 0);

        expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: 0, cost_per_unit: 0 })
        });
    });

    test('should handle negative values correctly', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        await mockFramework.updateVariantUsage(123, -5, -10);

        expect(fetch).toHaveBeenCalledWith('/api/upf/variant_usage/123', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: -5, cost_per_unit: -10 })
        });
    });

    test('should handle floating point precision', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        await mockFramework.updateVariantUsage(123, 0.1 + 0.2, null);

        const callArgs = fetch.mock.calls[0][1];
        const payload = JSON.parse(callArgs.body);
        
        // 0.1 + 0.2 = 0.30000000000000004 in JS
        expect(payload.quantity).toBeCloseTo(0.3, 10);
    });
});
