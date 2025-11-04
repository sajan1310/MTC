/**
 * UPF Reports Component
 * Displays analytics and insights for the process framework
 */

const reports = {
    fromDate: null,
    toDate: null,

    /**
     * Initialize reports
     */
    async init() {
        console.log('Initializing UPF reports...');
        
        // Set default date range (last 30 days)
        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);
        
        this.toDate = today.toISOString().split('T')[0];
        this.fromDate = thirtyDaysAgo.toISOString().split('T')[0];
        
        document.getElementById('from-date').value = this.fromDate;
        document.getElementById('to-date').value = this.toDate;
        
        await this.loadAllReports();
    },

    /**
     * Load all report data
     */
    async loadAllReports() {
        await Promise.all([
            this.loadMetrics(),
            this.loadTopProcesses(),
            this.loadProcessStatus(),
            this.loadRecentLots(),
            this.loadSubprocessUsage()
        ]);
    },

    /**
     * Load key metrics
     */
    async loadMetrics() {
        try {
            const response = await fetch('/api/upf/reports/metrics', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                
                document.getElementById('total-processes').textContent = data.total_processes || 0;
                document.getElementById('total-lots').textContent = data.total_lots || 0;
                document.getElementById('avg-cost').textContent = `$${parseFloat(data.avg_cost || 0).toFixed(2)}`;
                document.getElementById('completed-lots').textContent = data.completed_lots || 0;
                
                // Update change percentages
                document.getElementById('processes-change').textContent = `${data.processes_change || 0}% from last month`;
                document.getElementById('lots-change').textContent = `${data.lots_change || 0}% from last month`;
                document.getElementById('cost-change').textContent = `${data.cost_change || 0}% from last month`;
                document.getElementById('completed-change').textContent = `${data.completed_change || 0}% from last month`;
            }
        } catch (error) {
            console.error('Error loading metrics:', error);
        }
    },

    /**
     * Load top processes by cost
     */
    async loadTopProcesses() {
        try {
            const response = await fetch('/api/upf/reports/top-processes', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                const list = document.getElementById('top-processes-list');
                
                if (data.processes && data.processes.length > 0) {
                    let html = '';
                    data.processes.slice(0, 5).forEach(p => {
                        html += `
                            <li class="report-list-item">
                                <span class="item-label">${p.name}</span>
                                <span class="item-value">$${parseFloat(p.worst_case_cost || 0).toFixed(2)}</span>
                            </li>
                        `;
                    });
                    list.innerHTML = html;
                }
            }
        } catch (error) {
            console.error('Error loading top processes:', error);
        }
    },

    /**
     * Load process status distribution
     */
    async loadProcessStatus() {
        try {
            const response = await fetch('/api/upf/reports/process-status', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                
                document.getElementById('active-count').textContent = data.active || 0;
                document.getElementById('inactive-count').textContent = data.inactive || 0;
                document.getElementById('draft-count').textContent = data.draft || 0;
            }
        } catch (error) {
            console.error('Error loading process status:', error);
        }
    },

    /**
     * Load recent production lots
     */
    async loadRecentLots() {
        try {
            const response = await fetch('/api/upf/production-lots?per_page=5', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                const list = document.getElementById('recent-lots-list');
                
                if (data.production_lots && data.production_lots.length > 0) {
                    let html = '';
                    data.production_lots.forEach(lot => {
                        html += `
                            <li class="report-list-item">
                                <span class="item-label">${lot.lot_number}</span>
                                <span class="item-value">${lot.status}</span>
                            </li>
                        `;
                    });
                    list.innerHTML = html;
                }
            }
        } catch (error) {
            console.error('Error loading recent lots:', error);
        }
    },

    /**
     * Load subprocess usage statistics
     */
    async loadSubprocessUsage() {
        try {
            const response = await fetch('/api/upf/reports/subprocess-usage', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                const list = document.getElementById('subprocess-usage');
                
                if (data.subprocesses && data.subprocesses.length > 0) {
                    let html = '';
                    data.subprocesses.slice(0, 5).forEach(sp => {
                        html += `
                            <li class="report-list-item">
                                <span class="item-label">${sp.name}</span>
                                <span class="item-value">${sp.usage_count} times</span>
                            </li>
                        `;
                    });
                    list.innerHTML = html;
                }
            }
        } catch (error) {
            console.error('Error loading subprocess usage:', error);
        }
    },

    /**
     * Apply date filter
     */
    applyDateFilter() {
        this.fromDate = document.getElementById('from-date').value;
        this.toDate = document.getElementById('to-date').value;
        
        if (!this.fromDate || !this.toDate) {
            alert('Please select both from and to dates');
            return;
        }
        
        if (new Date(this.fromDate) > new Date(this.toDate)) {
            alert('From date must be before to date');
            return;
        }
        
        this.loadAllReports();
    },

    /**
     * Reset filter
     */
    resetFilter() {
        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);
        
        this.toDate = today.toISOString().split('T')[0];
        this.fromDate = thirtyDaysAgo.toISOString().split('T')[0];
        
        document.getElementById('from-date').value = this.fromDate;
        document.getElementById('to-date').value = this.toDate;
        
        this.loadAllReports();
    }
};
