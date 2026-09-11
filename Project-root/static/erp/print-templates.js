'use strict';
// print-templates.js -- the documents BOTH shells print.
//
// Desktop and MApp are two independent implementations of one product and
// deliberately share almost nothing. Printed documents are the exception,
// and always have been: mobile.html includes the same partials/print.html
// desktop does, so a challan, a PO, a bill and every ledger come out
// identical whichever shell produced them. That is the point -- a document
// goes to a vendor or onto the floor, and which device it was printed from
// is not something the paper should record.
//
// Three documents escaped that. Desktop builds the Production Sheet and the
// stock/pool pivot in its own bundles (production.js, stock.js), which the
// mobile shell never loads, so MApp had no way to reach them and printed a
// plain generic table instead: the same numbers, a different document.
//
// The builders live here now and both shells call them, so there is one
// layout per document and no second copy to drift.
//
// Pure on purpose. Everything shell-specific arrives through `deps` --
// desktop passes App.Print/App.Utils, MApp passes its own equivalents --
// so this file can be loaded by either without dragging the other's globals
// in. It relies only on escapeHtml, which api.js defines and both shells
// already load.

const PrintTemplates = {
  BRAND: '#198754',

  // ── Stock / Warehouse Pool pivot ─────────────────────────────────────
  // Items down the page, sizes across it. Not a flat list: a warehouse
  // carries the same item in a dozen sizes, and a row per combination is a
  // report nobody reads. Desktop's Low Stock Report, Full Stock List and
  // Warehouse Pool print all render through this one shape.
  computeStockPivot(items, poolItems, deps) {
    const sizeOf = (deps && deps.sizeFromOutputItemName) || (() => '');
    const sizeSet = new Set();
    const byName = new Map();

    (items || []).forEach(item => {
      const sizeLabel = item.size || 'GENERAL';
      sizeSet.add(sizeLabel);
      if (!byName.has(item.name)) byName.set(item.name, new Map());
      byName.get(item.name).set(sizeLabel, {
        currentStock: item.currentStock,
        isLowStock: item.isLowStock
      });
    });

    (poolItems || []).forEach(r => {
      if (!r.outputItemName) return;
      const sizeLabel = sizeOf(r.outputItemName) || 'GENERAL';
      let name = `${r.outputItemName} (Warehouse Pool)`;
      if (r.productTag) name += ` (Tag: ${r.productTag})`;
      if (r.color) name += ` [${r.color}]`;
      sizeSet.add(sizeLabel);
      if (!byName.has(name)) byName.set(name, new Map());
      const sizeMap = byName.get(name);
      const existing = sizeMap.get(sizeLabel);
      // Summed, not replaced: one output item can hold several pool buckets
      // that land on the same size, and overwriting would report the last
      // one as if it were the total.
      sizeMap.set(sizeLabel, {
        currentStock: (existing ? existing.currentStock : 0) + (r.availableQty || 0),
        isLowStock: false
      });
    });

    return {
      sizes: [...sizeSet].sort((a, b) => a.localeCompare(b)),
      names: [...byName.keys()].sort((a, b) => a.localeCompare(b)),
      byName
    };
  },

  stockPivotMarkup(items, poolItems, emptyMessage, deps) {
    const { sizes, names, byName } = this.computeStockPivot(items, poolItems, deps);

    const headerHtml = `
      <th style="padding:6px;border:1px solid #000;text-align:left;">Item Name</th>
      ${sizes.map(s => `<th style="padding:6px;border:1px solid #000;text-align:center;">${escapeHtml(s)}</th>`).join('')}
    `;

    let bodyHtml;
    if (!names.length) {
      bodyHtml = `<tr><td colspan="${sizes.length + 1}" style="text-align:center;color:#777;padding:24px;">${escapeHtml(emptyMessage)}</td></tr>`;
    } else {
      bodyHtml = names.map(name => {
        const sizeMap = byName.get(name);
        const cells = sizes.map(size => {
          const entry = sizeMap.get(size);
          if (!entry) return '<td style="padding:6px;border:1px solid #999;text-align:center;color:#1a1a1a;">-</td>';
          // Low stock is grey and bold rather than coloured: these print on
          // whatever is in the office printer, and colour is not a
          // difference a monochrome page can carry.
          return `<td style="padding:6px;border:1px solid #999;text-align:center;color:#1a1a1a;${entry.isLowStock ? 'background:#e0e0e0;font-weight:800;' : ''}">${entry.currentStock}</td>`;
        }).join('');
        return `
      <tr>
        <td style="padding:6px;border:1px solid #999;text-align:left;"><strong style="color:#1a1a1a;">${escapeHtml(name)}</strong></td>
        ${cells}
      </tr>
    `;
      }).join('');
    }

    return { headerHtml, bodyHtml };
  },

  // ── Production Sheet ─────────────────────────────────────────────────
  // The document that goes to the floor with a lot. A fully self-contained
  // page, so it can be printed one at a time into the shared container or
  // stacked for a bulk run without the two rendering differently.
  productionSheetPage(p, deps) {
    const d = deps || {};
    const fmtQty = d.formatQty || (v => String(v == null ? '' : v));
    const brandHeader = d.brandHeaderHtml || (() => '');
    const title = (d.requirementSheetTitle || (() => 'Material Requirement Sheet'))(p.processId);
    const BRAND = this.BRAND;
    const components = p.componentsConsumed || [];

    let rowsHtml = '';
    components.forEach(comp => {
      // Narration is a projection of Items Master, shown in brackets after
      // the name the way the lot form shows it -- the printed sheet and the
      // screen it came from name the same part the same way.
      const narr = (comp.narration || '').trim();
      const displayName = narr ? `${comp.itemName || ''}(${narr})` : (comp.itemName || '');
      rowsHtml += `<tr>
    <td style="padding:6px;border:1px solid #ddd;text-align:left;">${escapeHtml(displayName)}</td>
    <td style="padding:6px;border:1px solid #ddd;">${escapeHtml(comp.size || '-')}</td>
    <td style="padding:6px;border:1px solid #ddd;">${escapeHtml(comp.sourceType === 'POOL' ? 'Pool' : 'Item')}</td>
    <td style="padding:6px;border:1px solid #ddd;text-align:right;font-weight:700;">${escapeHtml(fmtQty(comp.qty))}</td>
  </tr>`;
    });
    const rows = rowsHtml || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#999;">No components recorded for this lot.</td></tr>';

    const remarksHtml = p.sheetRemarks ? `
  <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
    <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
    <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${escapeHtml(p.sheetRemarks)}</div>
  </div>` : '';

    return `
<div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:4px 0 8px 0;">
    ${brandHeader(BRAND)}
    <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
      6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
    </div>
    <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
      ${escapeHtml(title)}
    </div>
  </div>
  <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.date || '')}</div>
    </div>
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product ID</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.productId || '')}</div>
    </div>
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product Name</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.productName || '')}</div>
    </div>
    ${(p.colorBreakdown && p.colorBreakdown.length > 0) ? `
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Colors</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.colorBreakdown.map(c => `${c.color}${c.size ? ` (${c.size})` : ''}: ${fmtQty(c.qty)}`).join(', '))}</div>
    </div>` : (p.color ? `
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Color</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.color)}</div>
    </div>` : '')}
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Lot Qty</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${fmtQty(p.qty)}</div>
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
    <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <tr>
        <th style="padding:6px;border:1px solid #bbb;text-align:left;width:45%;">Item / Pool Name</th>
        <th style="padding:6px;border:1px solid #bbb;width:20%;">Size</th>
        <th style="padding:6px;border:1px solid #bbb;width:20%;">Source</th>
        <th style="padding:6px;border:1px solid #bbb;text-align:right;width:15%;">Qty</th>
      </tr>
    </thead>
    <tbody style="color:#1a1a1a;text-align:center;">${rows}</tbody>
  </table>
  ${remarksHtml}
</div>`;
  }
};
