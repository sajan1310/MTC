"use strict";

const Dashboard = {
  elements: {
    stockTrendChart: null,
  },

  init() {
    this.elements.stockTrendChart = document.getElementById('stock-trend-chart');
    if (this.elements.stockTrendChart) {
      console.log("Dashboard module initialized.");
      this.renderStockTrendChart();
    }
  },

  /**
   * Renders the stock trend chart using Chart.js
   * Fetches data from backend and displays 30-day stock history
   */
  async renderStockTrendChart() {
    if (!this.elements.stockTrendChart) {
      console.warn('Stock trend chart canvas element not found');
      return;
    }

    try {
      const data = await App.fetchJson(`${App.config.apiBase}/stock-trend`);

      if (!data || !data.labels || !data.values) {
        console.error('Invalid chart data received:', data);
        this.showChartError('No data available for stock trend.');
        return;
      }

      // Ensure Chart.js is loaded
      if (typeof Chart === 'undefined') {
        console.error('Chart.js library not loaded');
        this.showChartError('Chart library not loaded.');
        return;
      }

      new Chart(this.elements.stockTrendChart, {
        type: 'line',
        data: {
          labels: data.labels,
          datasets: [{
            label: 'Total Stock Over Time',
            data: data.values,
            borderColor: 'rgba(108, 99, 255, 1)',
            backgroundColor: 'rgba(108, 99, 255, 0.2)',
            fill: true,
            tension: 0.4,
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: 'top'
            },
            tooltip: {
              mode: 'index',
              intersect: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                precision: 0
              }
            }
          }
        }
      });
    } catch (error) {
      console.error('Error rendering stock trend chart:', error);
      this.showChartError('Failed to load stock trend data.');
    }
  },

  /**
   * Shows an error message in place of the chart
   * @param {string} message - Error message to display
   */
  showChartError(message) {
    if (!this.elements.stockTrendChart) return;

    const canvas = this.elements.stockTrendChart;
    const ctx = canvas.getContext('2d');

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw error message
    ctx.font = '16px Inter, sans-serif';
    ctx.fillStyle = '#718096';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, canvas.width / 2, canvas.height / 2);
  },
};

document.addEventListener("DOMContentLoaded", () => Dashboard.init());
