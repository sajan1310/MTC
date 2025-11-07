// Defensive cost calculation with error handling for structure API
async function calculateProcessCost(processId) {
    try {
        const response = await fetch(`/api/upf/processes/${processId}/structure`);
        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }
        const structure = await response.json();
        if (!structure || !structure.subprocesses) {
            throw new Error('Invalid structure data received');
        }
        let totalCost = 0;
        (structure.subprocesses || []).forEach(subprocess => {
            if (subprocess.variants && Array.isArray(subprocess.variants)) {
                subprocess.variants.forEach(variant => {
                    const cost = parseFloat(variant.cost) || 0;
                    const quantity = parseFloat(variant.quantity) || 0;
                    totalCost += cost * quantity;
                });
            }
        });
        updateCostDisplay(totalCost);
        return totalCost;
    } catch (error) {
        console.error('Cost calculation failed:', error);
        const costDisplay = document.getElementById('process-cost-display');
        if (costDisplay) {
            costDisplay.innerHTML = `
                <span class="cost-error">
                    ⚠️ Unable to calculate cost: ${error.message}
                </span>
            `;
        }
        return null;
    }
}

function updateCostDisplay(cost) {
    const costDisplay = document.getElementById('process-cost-display');
    if (costDisplay && cost !== null) {
        costDisplay.innerHTML = `
            <span class="cost-value">₹${cost.toFixed(2)}</span>
        `;
    }
}
/**
 * Cost Calculator Component
 * Handles real-time cost calculation and profitability analysis
 */

const costCalculator = {
    processId: null,
    costData: null,

    /**
     * Initialize the cost calculator
     */
    init(processId) {
        this.processId = processId;
        console.log('Initializing cost calculator for process:', processId);
    },

    /**
     * Calculate and update costs
     */
    async calculate() {
        if (!this.processId) {
            console.error('No process ID set for cost calculation');
            return;
        }

        try {
            const response = await fetch(`/api/upf/processes/${this.processId}/costing`, {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to calculate costs');
            }

            const data = await response.json();
            this.costData = data;
            this.renderCosts();
        } catch (error) {
            console.error('Error calculating costs:', error);
            this.showAlert('Failed to calculate costs', 'error');
        }
    },

    /**
     * Render cost summary
     */
    renderCosts() {
        if (!this.costData) return;

        const worstCaseEl = document.getElementById('worst-case-cost');
        const salesPriceEl = document.getElementById('sales-price');
        const profitMarginEl = document.getElementById('profit-margin');

        if (worstCaseEl) {
            const worstCost = parseFloat(this.costData.worst_case_cost || 0);
            worstCaseEl.textContent = `$${worstCost.toFixed(2)}`;
        }

        if (salesPriceEl) {
            const salesPrice = parseFloat(this.costData.sales_price || 0);
            if (salesPrice > 0) {
                salesPriceEl.textContent = `$${salesPrice.toFixed(2)}`;
            } else {
                salesPriceEl.textContent = 'Not Set';
            }
        }

        if (profitMarginEl) {
            const margin = this.calculateMargin();
            if (margin !== null) {
                const marginPercent = margin.toFixed(1);
                const color = margin >= 30 ? '#4CAF50' : margin >= 15 ? '#FF9800' : '#f44336';
                profitMarginEl.textContent = `${marginPercent}%`;
                profitMarginEl.style.color = color;
            } else {
                profitMarginEl.textContent = '-';
                profitMarginEl.style.color = '#999';
            }
        }
    },

    /**
     * Calculate profit margin percentage
     */
    calculateMargin() {
        if (!this.costData) return null;

        const cost = parseFloat(this.costData.worst_case_cost || 0);
        const price = parseFloat(this.costData.sales_price || 0);

        if (price === 0 || cost === 0) return null;

        const margin = ((price - cost) / price) * 100;
        return margin;
    },

    /**
     * Get cost breakdown by subprocess
     */
    getCostBreakdown() {
        if (!this.costData || !this.costData.subprocess_costs) return [];

        return this.costData.subprocess_costs.map(sp => ({
            name: sp.subprocess_name,
            cost: parseFloat(sp.worst_case_cost || 0),
            variant_count: sp.variant_count || 0
        }));
    },

    /**
     * Show alert message
     */
    showAlert(message, type = 'success') {
        const container = document.getElementById('alert-container');
        if (!container) return;

        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;

        container.appendChild(alert);

        setTimeout(() => {
            alert.remove();
        }, 5000);
    }
};
