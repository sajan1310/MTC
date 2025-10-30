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

  async renderStockTrendChart() {
    const data = await App.fetchJson(`${App.config.apiBase}/stock-trend`);
    if (!data || !this.elements.stockTrendChart) return;

    new Chart(this.elements.stockTrendChart, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: 'Total Stock Over Time',
          data: data.values,
          borderColor: 'rgba(75, 192, 192, 1)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          fill: true,
          tension: 0.4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true
          }
        }
      }
    });
  },
};

document.addEventListener("DOMContentLoaded", () => Dashboard.init());
