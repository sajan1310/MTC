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
  // The document that goes to the floor with a lot: a Common Components
  // table, a per-colour matrix, and a Sub-Group section, fitted to one
  // page by the density loop below.
  //
  // This is the renderer desktop actually uses. There was a second, simpler
  // one (buildProductionSheetPrintPageHtml) and production.js records why
  // it was abandoned: "one lot printed with a different table layout
  // depending on whether it was reached through Print Sheet or Print
  // Selected. There is one layout now." It is gone, and this is the one
  // layout -- now reachable from the phone too.
  //
  // It renders INTO #print-production-sheet-container, which lives in the
  // shared partials/print.html both shells include, so the output is the
  // same element filled the same way either way. What used to be read
  // straight out of the desktop dialog's own DOM arrives as `data`, which
  // is the whole reason MApp can call it: there is no dialog on a phone.
  //
  //   data.title/date/productId/productName/qty/lotColor/remarks
  //   data.common   [{ name, qty, unit }]
  //   data.matrix   [{ name, unit, qtyByGroup, tagByGroup }]
  //   data.colors / data.subGroups   column groups
  //   data.excluded                  groups unticked in Print options
  //   data.landscape
  productionSheet(data, deps) {
    const d = data || {};
    const dp = deps || {};
    const fmtQty = dp.formatQty || (v => String(v == null ? '' : v));
    const sameColor = dp.sameColor || ((a, b) => String(a || '') === String(b || ''));
    const landscape = !!d.landscape;

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };

    setText('print-prod-title', d.title || 'Production Material Requirement Sheet');
    setText('print-prod-date', d.date || '');
    setText('print-prod-id', d.productId || '');
    setText('print-prod-name', d.productName || '');
    setText('print-prod-qty', d.qty || '');

    const lotColor = d.lotColor || '';
    const colorWrapper = document.getElementById('print-prod-color-wrapper');
    if (colorWrapper) colorWrapper.style.display = lotColor ? '' : 'none';
    setText('print-prod-color', lotColor);

    // Anything unticked in the Print options panel is dropped from the
    // printed sheet only -- the lot's own data is untouched.
    const excluded = d.excluded || [];
    const kept = g => !excluded.some(e => sameColor(e, g));

    const commonData = d.common || [];
    const matrixRows = d.matrix || [];

    const commonSection = document.getElementById('print-prod-common-section');
    if (commonSection) commonSection.style.display = commonData.length > 0 ? '' : 'none';
    const matrixSection = document.getElementById('print-prod-matrix-section');
    const subGroupSection = document.getElementById('print-prod-subgroup-section');

    const qtyFor = (row, group) => {
      const map = row.qtyByGroup || {};
      const hit = Object.keys(map).find(k => sameColor(k, group));
      return hit === undefined ? '' : map[hit];
    };
    const tagFor = (row, group) => {
      const map = row.tagByGroup || {};
      const hit = Object.keys(map).find(k => sameColor(k, group));
      return hit === undefined ? '' : map[hit];
    };
    const toMatrixRow = columns => row => ({
      name: row.name,
      unit: row.unit,
      colorQty: columns.map(c => qtyFor(row, c)),
      colorTag: columns.map(c => tagFor(row, c))
    });

    const colors = (d.colors || []).filter(kept);
    const subGroups = (d.subGroups || []).filter(kept);

    // Both the Per-Color matrix and Sub-Group Components split into
    // connected clusters of columns -- two columns land in the same
    // printed table only if some row uses BOTH of them together, directly
    // or transitively through a bridging row (e.g. one item legitimately
    // offered in every color in the lot ties otherwise-unrelated subsets
    // into one family, and stays on one table). Columns that are always
    // used together as one family stay consolidated (the common case: a
    // real 6-colour/11-row worst case that must NOT fragment into one
    // table per row signature, or it spills across pages). But two groups
    // that NEVER co-occur on any row -- e.g. a Painted Mudguard's own
    // plain Blue/Pink/Purple/Red axis next to the Frame's compound
    // Blue-White/Black-style axis, or a "KIT BAG 24\"" bucket next to a
    // "SMALL KIT 24\"" bucket that never shares an item -- get their own
    // table instead of doubling every row's column count with dashes (and,
    // for a long component list, needlessly spilling onto extra printed
    // pages).
    const clusterMatrixTables = (columns, rows) => {
      if (columns.length === 0 || rows.length === 0) return [];
      const parent = new Map(columns.map(c => [c, c]));
      const find = c => { while (parent.get(c) !== c) c = parent.get(c); return c; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

      const rowColumns = rows.map(row => columns.filter(c => String(qtyFor(row, c)).trim() !== ''));
      rowColumns.forEach(set => { for (let i = 1; i < set.length; i++) union(set[0], set[i]); });

      const clusters = new Map(); // root -> { columns: [], rows: [] }
      columns.forEach(c => {
        if (!rowColumns.some(set => set.includes(c))) return; // no row ever uses it -- drop
        const root = find(c);
        if (!clusters.has(root)) clusters.set(root, { columns: [], rows: [] });
        clusters.get(root).columns.push(c);
      });
      rows.forEach((row, i) => {
        const set = rowColumns[i];
        if (set.length === 0) return;
        clusters.get(find(set[0])).rows.push(row);
      });

      return Array.from(clusters.values())
        .filter(g => g.rows.length > 0)
        .map(g => ({ columns: g.columns, data: g.rows.map(toMatrixRow(g.columns)) }));
    };

    const matrixGroups = clusterMatrixTables(colors, matrixRows);
    const subGroupGroups = clusterMatrixTables(subGroups, matrixRows);

    // Each section appears only if it has at least one cluster left after
    // exclusions/empty filtering, so a lot with no sub-groups looks exactly
    // as it always did, and a kit-bag-only lot shows no empty color matrix.
    if (matrixSection) matrixSection.style.display = matrixGroups.length > 0 ? '' : 'none';
    if (subGroupSection) subGroupSection.style.display = subGroupGroups.length > 0 ? '' : 'none';

    const FIT_TIERS = [
      { pad: '7px 9px', font: 12, emphasisFont: 15, qtyFont: 17, lineHeight: 20, tableGap: 12 },
      { pad: '5px 8px', font: 11, emphasisFont: 14, qtyFont: 15, lineHeight: 19, tableGap: 9 },
      { pad: '4px 7px', font: 11, emphasisFont: 13, qtyFont: 14, lineHeight: 17, tableGap: 7 },
      { pad: '3px 6px', font: 10, emphasisFont: 12, qtyFont: 13, lineHeight: 16, tableGap: 5 }
    ];
    // Readability palette. Hierarchy is carried by size, weight and ink
    // together: near-black bold names against the muted grey of the
    // surrounding cells, so the eye lands on the item first. ZEBRA is a
    // real, visible band and RULE is a light hairline so the banding, not a
    // heavy grid, does the row tracking. GRID_STRONG outlines the table so
    // columns stay anchored.
    // Defaulted rather than destructured straight off deps: a shell that
    // forgets to pass one should print a plainer sheet, not throw at the
    // moment somebody needs the paper. These are desktop's own values.
    const { HEAD_BG, HEAD_INK, ZEBRA, RULE, GRID_STRONG, INK_PRIMARY, INK_MUTED } =
      dp.palette || {
        HEAD_BG: '#cfe8d5', HEAD_INK: '#0b5132', ZEBRA: '#eef4ef', RULE: '#c8d3ca',
        GRID_STRONG: '#8fae99', INK_PRIMARY: '#111', INK_MUTED: '#5b6b60'
      };

    // Headers are stepped one size ABOVE the body's own tier.font -- a
    // column header being smaller than the data it labels reads backwards,
    // especially on the color-matrix table where getting the wrong
    // header/column pairing means misreading which color a number belongs
    // to. Safety valve so an over-long token can never spill outside its
    // cell border. overflow-wrap:break-word ONLY -- deliberately not
    // word-break:break-word alongside it, and not overflow-wrap:anywhere;
    // both of those also shrink the column's min-content width and force a
    // mid-token break, which html2canvas then paints at the wrong position
    // as two overlapping lines. vertical-align:top, not the table-cell
    // default of middle -- with middle, html2canvas has to offset the text
    // block inside a taller row, and got that offset wrong whenever a
    // cell's own content height landed exactly on the row height.
    const CELL_VALIGN = 'vertical-align:top;';
    const CELL_WRAP = 'overflow-wrap:break-word;';

    // Item names are hyphen-chained compounds where a run of two or more
    // hyphens is the author's own separator: "BB---CUP---SET",
    // "CYCLE-CHAIN--110-LINK", "CARTOON--S-D". Those runs are rendered as a
    // single space, so the whole name reads as ONE line.
    //
    // It used to put each segment on its own block line, which turned a
    // three-part name into a three-line row and was the single biggest
    // consumer of vertical space on the sheet -- a 15-row Common
    // Components table could occupy 30+ lines. That was defensive: the old
    // html2canvas PDF path mis-painted any line IT had to wrap, so the fix
    // was to leave it nothing to wrap. PDFs are now rendered server-side by
    // WeasyPrint (app/erp/services/pdf_render_service.py), which wraps text
    // correctly, so the defence costs page count and buys nothing.
    //
    // Single hyphens stay inside their segment (they are part of the token,
    // e.g. "BRUT-BLACK") but still get a zero-width space after them, so an
    // unusually long name can still wrap at a sensible point rather than
    // overflow its cell. Written as an explicit \u200B escape rather than
    // the literal character: an invisible codepoint sitting in a string
    // literal is the kind of thing an editor or a paste silently eats.
    const withBreakPoints = text => String(text)
      .split(/-{2,}/)
      .map(seg => seg.trim())
      .filter(seg => seg !== '')
      .map(seg => seg.replace(/-/g, '$&\u200B'))
      .join(' ');

    // Deliberately AUTO layout, not table-layout:fixed. Fixed layout makes
    // the column percentages binding, which does stop the tables blowing
    // past their grid track -- but html2canvas then mis-measures the
    // column and lays each header out on a single unwrapped line, clipping
    // it mid-word in the PDF. Auto layout is what html2canvas renders
    // faithfully; the track cap on the Common grid plus CELL_WRAP is what
    // keeps the width in bounds.
    const TABLE_STYLE = 'width:100%;border-collapse:collapse;';

    // Item Name is emphasised by size (tier.emphasisFont) AND weight.
    //
    // Bold on a wrapping cell used to be unsafe: html2canvas laid a line out
    // using normal-weight metrics and then painted bold glyphs, so wrapped
    // bold text overran its measured line and the fragments landed on top of
    // each other. That exporter is gone -- every print and PDF path is now
    // window.print() against a real print engine, which measures the weight
    // it paints (see print.js's "What used to be here"). So the restriction
    // went with it, and the item name reads as strongly as its quantity.
    //
    // There was an opts.nowrap here that pinned short single-token columns;
    // its only caller was Size, whose "GENERAL" auto layout used to break
    // into "GEN/ERAL". With Size and Narration no longer printed it had no
    // callers left, so it went rather than sitting unused.
    const headCell = (label, tier, opts = {}) => {
      const width = opts.width ? `width:${opts.width};` : '';
      const wrap = CELL_VALIGN + CELL_WRAP;
      return `<th style="padding:${tier.pad};border:1px solid ${GRID_STRONG};background:${HEAD_BG};color:${HEAD_INK};
                font-weight:700;text-align:${opts.align || 'center'};font-size:${Math.max(tier.font + 1, 10)}px;
                line-height:${tier.lineHeight}px;${wrap}${width}
                -webkit-print-color-adjust:exact;print-color-adjust:exact;">${label}</th>`;
    };
    const bodyCell = (content, tier, opts = {}) => {
      const bg = opts.zebra ? `background:${ZEBRA};` : '';
      const weight = opts.bold ? 'font-weight:700;' : '';
      // `qty` outranks `emphasis`: a quantity cell is emphasised too, and
      // takes the larger of the two sizes.
      const fs = opts.qty ? tier.qtyFont : (opts.emphasis ? tier.emphasisFont : tier.font);
      const wrap = CELL_VALIGN + CELL_WRAP;
      const ink = (opts.emphasis || opts.bold) ? INK_PRIMARY : INK_MUTED;
      return `<td style="padding:${tier.pad};border:1px solid ${RULE};text-align:${opts.align || 'left'};
                color:${ink};font-size:${fs}px;line-height:${tier.lineHeight}px;${wrap}${weight}${bg}">${content}</td>`;
    };

    // PRINT ONLY carries Item Name + quantities. Size and Narration stay in
    // the on-screen sheet -- still editable, still saved, still serialized --
    // but are not printed: they were spending ~38% of the paper's width on
    // information the worker picking and counting items does not read off it
    // (Size is "GENERAL" on most rows, and Narration repeats what the item
    // name already says). Dropping them also gives the per-colour matrix its
    // width back, which is what actually decides whether a lot fits one page.
    const buildCommonTable = (rows, tier) => {
      if (rows.length === 0) return '';
      // Item Name is deliberately generous: Size is not printed and the
      // narration rides INSIDE this column as "Name(Narration)", so it
      // carries both identifiers. Required Qty needs no more than a short
      // "270 Pcs".
      let head = headCell('Item Name', tier, { align: 'left', width: '72%' });
      head += headCell('Required Qty', tier, { align: 'right', width: '28%' });

      const body = rows.map((r, i) => {
        const zebra = i % 2 === 1;
        let row = bodyCell(withBreakPoints(r.name), tier, { zebra, emphasis: true, bold: true });
        const qtyText = r.qty ? `${escapeHtml(fmtQty(r.qty))}${r.unit ? ' ' + escapeHtml(r.unit) : ''}` : '&#8211;';
        row += bodyCell(qtyText, tier, { align: 'right', bold: !!r.qty, zebra, emphasis: true, qty: true });
        return `<tr>${row}</tr>`;
      }).join('');

      return `<table style="${TABLE_STYLE}margin-bottom:${tier.tableGap}px;">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };

    // `columns` is passed in rather than closed over, so the same builder
    // renders both the color matrix and the sub-group table.
    const buildMatrixTable = (rows, tier, columns) => {
      if (rows.length === 0 || columns.length === 0) return '';
      // 38%, not the 26% Item Name used to get: Size freed its column and
      // the narration rides inside this one as "Name(Narration)", so the
      // name needs the larger share of what Size freed and the rest goes to
      // the colour columns.
      let head = headCell('Item Name', tier, { align: 'left', width: '38%' });
      columns.forEach(c => { head += headCell(escapeHtml(c), tier, { align: 'right' }); });

      const body = rows.map((r, i) => {
        const zebra = i % 2 === 1;
        let row = bodyCell(withBreakPoints(r.name), tier, { zebra, emphasis: true, bold: true });
        r.colorQty.forEach((val, ci) => {
          const cellText = val ? `${escapeHtml(fmtQty(val))}${r.unit ? ' ' + escapeHtml(r.unit) : ''}` : '&#8211;';
          // Which literal item this colour's qty refers to, e.g. a "Teddy
          // Basket" row's Blue column reading "(Red)" -- read back from
          // renderMatrixSheetRow's own tag rather than recomputed, so print
          // can never disagree with the dialog. See _cellItemTag.
          const tag = (r.colorTag && r.colorTag[ci]) || '';
          const tagHtml = tag ? `<div style="font-size:${Math.max(tier.font - 2, 8)}px;font-weight:700;color:${INK_MUTED};line-height:1.2;">${escapeHtml(tag)}</div>` : '';
          row += bodyCell(cellText + tagHtml, tier, { align: 'right', bold: !!val, zebra, emphasis: true, qty: true });
        });
        return `<tr>${row}</tr>`;
      }).join('');

      return `<table style="${TABLE_STYLE}margin-bottom:${tier.tableGap}px;">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };

    // Common Components reads as a tall narrow list; past a handful of
    // rows it's cheaper on vertical space split into two side-by-side
    // tables than left as one column with the page's right half empty.
    const COMMON_TWO_COL_THRESHOLD = 8;

    const commonDest = document.getElementById('print-production-sheet-common-tables');
    const matrixDest = document.getElementById('print-production-sheet-matrix-tables');
    const subGroupDest = document.getElementById('print-production-sheet-subgroup-tables');

    const render = tier => {
      if (commonDest) {
        if (commonData.length > COMMON_TWO_COL_THRESHOLD) {
          const mid = Math.ceil(commonData.length / 2);
          const left = buildCommonTable(commonData.slice(0, mid), tier);
          const right = buildCommonTable(commonData.slice(mid), tier);
          // minmax(0,1fr), not 1fr: a bare 1fr track is minmax(auto,1fr) and
          // GROWS past its share to fit a wide item's min-content, which
          // blows the grid wider than the page and pushes the right-hand
          // table off the edge of the PDF.
          commonDest.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;">${left}${right}</div>`;
        } else {
          commonDest.innerHTML = buildCommonTable(commonData, tier);
        }
      }
      if (matrixDest) {
        // Stacked full-width, NOT packed side-by-side like Sub-Group
        // Components below: a colour-axis cluster routinely carries 4+
        // columns (a whole colour family), and forcing two of those into a
        // half-width minmax(0,1fr) track overflows the page. Sub-group
        // buckets are usually only 1-2 columns, where half-width is
        // comfortably enough room.
        matrixDest.innerHTML = matrixGroups.map(g => buildMatrixTable(g.data, tier, g.columns)).join('');
      }
      if (subGroupDest) {
        const tables = subGroupGroups.map(g => buildMatrixTable(g.data, tier, g.columns));
        // Sub-group cluster tables are usually narrow (packing/variant
        // buckets, often just 1-2 columns) -- stacking them full-width one
        // after another leaves most of each row empty and burns extra
        // printed pages for no reason. Same minmax(0,1fr) grid Common
        // Components uses above packs two per row instead; CSS grid
        // auto-placement wraps any further tables onto more rows with no
        // extra layout logic needed.
        subGroupDest.innerHTML = tables.length > 1
          ? `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;">${tables.join('')}</div>`
          : tables.join('');
      }
    };

    // Measure-and-compress: lay the container out offscreen at the real
    // A4 printable width (matches the @page margin geometry in
    // styles.css -- keep PAGE_MARGIN_MM in sync with that file's @page
    // rule and mobile_styles.css's copy of it), try each density tier, and
    // stop at the first one that fits a single page -- so nothing shrinks
    // or drops a column unless the sheet actually needs it to.
    const container = document.getElementById('print-production-sheet-container');
    // Geometry comes from App.Print so the sheet is measured at exactly the
    // printable page box (@page A4 minus its margin, in CSS px at 96dpi).
    // Landscape swaps the page box, so the fit loop must measure against
    // the rotated dimensions or it would compress a sheet that already fits.
    // `landscape` comes from data, declared at the top of this method.
    const PAGE_WIDTH_PX = landscape ? (dp.pageHeightPx || 1077) : (dp.pageWidthPx || 748);
    const PAGE_HEIGHT_PX = landscape ? (dp.pageWidthPx || 748) : (dp.pageHeightPx || 1077);

    if (container) {
      const prevDisplay = container.style.display;
      const prevPosition = container.style.position;
      const prevVisibility = container.style.visibility;
      const prevWidth = container.style.width;
      const prevLeft = container.style.left;
      const prevTop = container.style.top;

      container.style.position = 'fixed';
      container.style.left = '-10000px';
      container.style.top = '0';
      container.style.visibility = 'hidden';
      container.style.display = 'block';
      container.style.width = PAGE_WIDTH_PX + 'px';

      // A tier only "fits" if it fits BOTH ways. The height test alone let
      // a sheet that was too WIDE pass as fitting, and it exported with
      // its right-hand column sliced off -- html2canvas captures only the
      // element's own box, so anything past it is simply gone. offsetHeight,
      // not scrollHeight: scrollHeight excludes the container's top/bottom
      // accent borders, so a sheet sitting right on the boundary measured
      // shorter than it really printed. A couple px of slack on the width:
      // a fractional track (two halves of the Common grid) can round up by
      // a px each, which is not real overflow.
      const ROUNDING_SLACK_PX = 2;
      const overflows = () =>
        container.offsetHeight > PAGE_HEIGHT_PX ||
        container.scrollWidth > container.clientWidth + ROUNDING_SLACK_PX;

      for (const tier of FIT_TIERS) {
        render(tier);
        if (!overflows()) break;
      }

      container.style.display = prevDisplay;
      container.style.position = prevPosition;
      container.style.visibility = prevVisibility;
      container.style.width = prevWidth;
      container.style.left = prevLeft;
      container.style.top = prevTop;
    } else {
      render(FIT_TIERS[0]);
    }

    const remarksSection = document.getElementById('print-prod-remarks-section');
    const remarksText = document.getElementById('productionSheetRemarks')?.value.trim() || '';
    if (remarksSection) {
      remarksSection.style.display = remarksText ? '' : 'none';
      setText('print-prod-remarks-text', remarksText);
    }
  },
  // ── Shared document helpers ──────────────────────────────────────────
  // Every builder below needs the same handful, and each shell spells them
  // differently (App.Utils.* vs MApp.Util.*). Resolved once, here, with
  // fallbacks so a shell that forgets one prints a barer document rather
  // than throwing at the moment somebody needs the paper.
  _deps(deps) {
    const d = deps || {};
    return {
      esc: d.escapeHtml || (typeof escapeHtml === 'function' ? escapeHtml : String),
      num: d.toNumber || (v => Number(v) || 0),
      money: d.formatCurrency || (v => String(Number(v) || 0)),
      nameCase: d.formatNameCase || (v => String(v == null ? '' : v)),
      sameText: d.sameText || ((a, b) =>
        String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()),
      brand: d.brandColor || this.BRAND
    };
  },

  _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val == null ? '' : val;
  },

  // ── Purchase Order ───────────────────────────────────────────────────
  // `options.includeRates` / `options.includeTotal` are desktop's two Print
  // Options checkboxes. Both default to on, which is what desktop sends
  // when the boxes are absent and what the phone (which has no such
  // checkboxes) wants every time.
  poDocument(po, deps, options) {
    const p = po || {};
    const { esc, num, money, nameCase, brand } = this._deps(deps);
    const opt = options || {};
    const includeRates = opt.includeRates !== false;
    const includeTotal = opt.includeTotal !== false;

    this._setText('print-vendor', nameCase(p.vendor));
    this._setText('print-contact', p.contact || '');
    this._setText('print-supp-rem', p.supplierRemarks || '');
    this._setText('print-ponum', p.poNumber || '');
    this._setText('print-date', p.poDate || '');
    this._setText('print-desc', p.poDescription || '');
    this._setText('print-remarks', p.poRemarks || '');

    const thBase = `padding:8px 6px;background-color:${brand};color:#fff;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border:1px solid ${brand};-webkit-print-color-adjust:exact;print-color-adjust:exact;`;
    const tdBase = 'padding:7px 6px;border:1px solid #e5e5e5;word-break:break-word;overflow-wrap:break-word;font-size:12px;';

    const head = document.getElementById('print-table-head');
    if (head) {
      if (includeRates) {
        head.innerHTML = includeTotal
          ? `<tr>
            <th style="${thBase}width:5%;text-align:center">#</th>
            <th style="${thBase}width:20%;text-align:left">Item Name</th>
            <th style="${thBase}width:17%;text-align:left">Narration</th>
            <th style="${thBase}width:12%;text-align:left">Size</th>
            <th style="${thBase}width:14%;text-align:center">Qty</th>
            <th style="${thBase}width:14%;text-align:right">Rate</th>
            <th style="${thBase}width:18%;text-align:right">Total</th>
           </tr>`
          : `<tr>
            <th style="${thBase}width:5%;text-align:center">#</th>
            <th style="${thBase}width:25%;text-align:left">Item Name</th>
            <th style="${thBase}width:22%;text-align:left">Narration</th>
            <th style="${thBase}width:15%;text-align:left">Size</th>
            <th style="${thBase}width:15%;text-align:center">Qty</th>
            <th style="${thBase}width:18%;text-align:right">Rate</th>
           </tr>`;
      } else {
        head.innerHTML = `<tr>
        <th style="${thBase}width:5%;text-align:center">#</th>
        <th style="${thBase}width:30%;text-align:left">Item Name</th>
        <th style="${thBase}width:28%;text-align:left">Narration</th>
        <th style="${thBase}width:15%;text-align:left">Size</th>
        <th style="${thBase}width:22%;text-align:center">Quantity</th>
       </tr>`;
      }
    }

    let grandTotal = 0;
    const bodyHtml = (p.items || []).map((item, idx) => {
      const qty = num(item.qty);
      const price = num(item.price);
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#FFF5F5';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;

      let row = `
      <tr style="${rowStyle}">
        <td style="${tdBase}text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="${tdBase}text-align:left;font-weight:600;">${esc(item.name || '')}</td>
        <td style="${tdBase}text-align:left;color:#555;">${esc(item.narration || '')}</td>
        <td style="${tdBase}text-align:left;">${esc(item.size || '')}</td>
        <td style="${tdBase}text-align:center;font-weight:600;">${esc(String(qty))} ${esc(item.unit || 'Pcs')}</td>`;

      if (includeRates) {
        row += `<td style="${tdBase}text-align:right;">${money(price)}</td>`;
        if (includeTotal) {
          const lineTotal = qty * price;
          grandTotal += lineTotal;
          row += `<td style="${tdBase}text-align:right;font-weight:700;color:${brand};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${money(lineTotal)}</td>`;
        }
      }
      return row + '</tr>';
    }).join('');

    const tblBody = document.getElementById('print-items-body');
    if (tblBody) tblBody.innerHTML = bodyHtml;

    const totalContainer = document.getElementById('print-grand-total-container');
    if (includeRates && includeTotal) {
      this._setText('print-grand-total', num(grandTotal).toFixed(2));
      if (totalContainer) totalContainer.style.display = 'block';
    } else if (totalContainer) {
      totalContainer.style.display = 'none';
    }

    return p;
  },

  // ── Vendor Bill ──────────────────────────────────────────────────────
  billDocument(bill, deps) {
    const b = bill || {};
    const { esc, num, money, nameCase } = this._deps(deps);

    this._setText('print-bill-number', b.billNumber || '');
    this._setText('print-bill-date', b.billDate || '');
    this._setText('print-bill-vendor', nameCase(b.vendor));
    this._setText('print-bill-remarks', b.remarks || '');
    this._setText('print-bill-contact', b.contact || '');

    const poNums = (b.poNumbers && b.poNumbers.length)
      ? b.poNumbers
      : (b.poNumber ? [b.poNumber] : []);
    const poRefEl = document.getElementById('print-bill-po-ref');
    if (poRefEl) {
      poRefEl.innerHTML = poNums.length
        ? poNums.map(x => x === 'DIRECT' ? 'Direct Purchase (No PO)' : `PO-${esc(String(x))}`).join(' | ')
        : 'N/A';
    }

    const bodyHtml = (b.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#F5F0FB';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
      return `
      <tr style="${rowStyle}">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${esc(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${esc(item.narration || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${esc(item.size || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${esc(String(num(item.qty)))} ${esc(item.unit || 'Pcs')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${money(item.price)}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${esc(String(item.gstRatePct == null ? 0 : item.gstRatePct))}%</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:#6F42C1;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${money(item.lineTotal)}</td>
      </tr>`;
    }).join('');

    const tblBody = document.getElementById('print-bill-items-body');
    if (tblBody) tblBody.innerHTML = bodyHtml;

    this._setText('print-bill-grand-total', num(b.totalAmount).toFixed(2));
    return b;
  },

  // ── Delivery Challan ─────────────────────────────────────────────────
  // A GST challan: goods physically leave the factory on a Dispatch, so the
  // consignee's address and GSTIN and each line's HSN have to be on the
  // paper. None of the three is stored on the dispatch itself, so they are
  // looked up from Client Master and Items Master -- `deps.clients` and
  // `deps.items`. The phone used to print this challan without any of them,
  // which is the difference that matters most in this file: a challan
  // missing the consignee's GSTIN is not the same document.
  dispatchDocument(dispatch, deps) {
    const b = dispatch || {};
    const { esc, num, nameCase, sameText } = this._deps(deps);
    const d = deps || {};
    const clients = d.clients || [];
    const items = d.items || [];

    const client = clients.find(c => sameText(c.name, b.clientName));

    this._setText('print-dispatch-number', b.dispatchNumber || '');
    this._setText('print-dispatch-date', b.dispatchDate || '');
    this._setText('print-dispatch-client', nameCase(b.clientName));
    this._setText('print-dispatch-client-address', (client && client.address) || '');
    this._setText('print-dispatch-client-gstin', (client && client.gstin) || '');
    this._setText('print-dispatch-transport', b.transport || '');
    this._setText('print-dispatch-order-ref', b.orderNumber || '');

    const grRefParts = [];
    if (b.invoiceNumber) grRefParts.push(`Inv: ${b.invoiceNumber}`);
    if (b.grNumber) grRefParts.push(`GR: ${b.grNumber}`);
    this._setText('print-dispatch-gr-ref', grRefParts.join(' | '));
    this._setText('print-dispatch-remarks', b.remarks || '');

    const tbody = document.getElementById('print-dispatch-items-body');
    if (tbody) {
      tbody.innerHTML = (b.items || []).map((i, idx) => {
        const item = items.find(it => sameText(it.name, i.productName));
        return `<tr>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${esc(i.productName || '')}${i.productId ? ` <small style="color:#888;">(${esc(i.productId)})</small>` : ''}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;">${esc((item && item.hsn) || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;font-weight:600;">${esc(String(num(i.qty)))}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;">Pcs</td>
      </tr>`;
      }).join('');
    }

    return b;
  },
  // ── Stock Issue Receipt ──────────────────────────────────────────────
  // One self-contained page per record, handed to whichever shell's bulk
  // printer asked for it. The phone used to print a LIST of the issue log
  // instead -- a different document answering a different question, and no
  // use at all to somebody signing for goods they have just been handed.
  issueNote(iss, deps) {
    const { esc, num, nameCase } = this._deps(deps);
    const brandHeader = (deps && deps.brandHeaderHtml) || (() => '');
    const BRAND = '#212529';
    const hasValue = num(iss.totalValue) > 0;
    const colCount = hasValue ? 5 : 4;

    const rowsHtml = (iss.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#f5f5f5';
      const amountCell = hasValue
        ? `<td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:600;">${num(item.rate) ? '&#8377;' + num(item.value).toFixed(2) : '-'}</td>`
        : '';
      return `
      <tr style="background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${esc(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${esc(item.size || '-')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${esc(String(num(item.qty)))} ${esc(item.unit || 'Pcs')}</td>
        ${amountCell}
      </tr>`;
    }).join('');
    const rows = rowsHtml || `<tr><td colspan="${colCount}" style="padding:10px;text-align:center;color:#999;">No items recorded for this issue.</td></tr>`;
    const amountHeader = hasValue ? '<th style="padding:6px;border:1px solid #bbb;text-align:right;width:20%;">Amount</th>' : '';
    const totalValueHtml = hasValue ? `
      <div style="text-align:right;margin-top:4px;">
        <span style="font-size:11px;font-weight:600;color:#1a1a1a;">Total Value:&nbsp;&nbsp;</span>
        <span style="font-size:13px;font-weight:800;color:${BRAND};">&#8377;${num(iss.totalValue).toFixed(2)}</span>
      </div>` : '';

    const remarksHtml = iss.remarks ? `
    <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
      <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${esc(iss.remarks)}</div>
    </div>` : '';

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${brandHeader(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
          Stock Issue Receipt
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="flex:1;text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Issue #</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};">${esc(iss.issueId || '')}</div>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${esc(iss.date || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Issued To / Purpose</span>
            <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${esc(nameCase(iss.issuedTo))}</div>
          </div>
          <div style="flex:1;">
            <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Reference</span>
            <div style="font-size:13px;font-weight:600;color:#1a1a1a;margin-top:1px;">${esc(iss.reference || '-')}</div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:8%;">#</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:${hasValue ? '37' : '47'}%;">Item Name</th>
            <th style="padding:6px;border:1px solid #bbb;width:20%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:${hasValue ? '15' : '25'}%;">Qty</th>
            ${amountHeader}
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">${rows}</tbody>
      </table>

      <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;">
        <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Total Qty:&nbsp;&nbsp;</span>
        <span style="font-size:15px;font-weight:800;color:${BRAND};">${esc(String(iss.totalQty ?? 0))}</span>
      </div>
      ${totalValueHtml}
      ${remarksHtml}

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;margin-top:16px;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Received By / Signature</span>
        </div>
      </div>
    </div>`;
  },

  // ── Goods Return Note ────────────────────────────────────────────────
  returnNote(ret, deps) {
    const { esc, num, nameCase } = this._deps(deps);
    const brandHeader = (deps && deps.brandHeaderHtml) || (() => '');
    const BRAND = '#FD7E14';

    const bodyHtml = (ret.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#FFF6EE';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
      return `
      <tr style="${rowStyle}">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${esc(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${esc(item.narration || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${esc(item.size || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${esc(String(num(item.qty)))} ${esc(item.unit || 'Pcs')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${formatCurrency(item.price)}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${esc(item.reason || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${formatCurrency(item.lineTotal)}</td>
      </tr>`;
    }).join('');

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${brandHeader(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:10px;color:#555;margin-top:2px;letter-spacing:0.3px;">
          Ph : 86996-42398, 91546-94000, 94170-42398 &nbsp;|&nbsp; E-mail : maharaja.bikes@gmail.com
          &nbsp;&nbsp; GSTIN : 03AFIPS4089J1Z1
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="flex:1;text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Return #</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${esc(ret.returnNumber || '')}</div>
        </div>
        <div style="flex:2;text-align:center;">
          <span style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:3px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            Goods Returned
          </span>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${esc(ret.returnDate || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vendor</span>
              <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${esc(nameCase(ret.vendor))}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
              <div style="font-size:11px;color:#333;margin-top:1px;white-space:pre-wrap;">${esc(ret.remarks || '')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contact</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${esc(ret.contact || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Bill Reference</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${esc(ret.billNumber || 'N/A')}</div>
            </div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:5%;">#</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Item Name</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:17%;">Narration</th>
            <th style="padding:6px;border:1px solid #bbb;width:9%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:11%;">Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:10%;">Rate</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:16%;">Reason</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:12%;">Total</th>
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">${bodyHtml}</tbody>
      </table>

      <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
        <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Grand Total:&nbsp;&nbsp;</span>
        <span style="font-size:15px;font-weight:800;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          &#8377;${num(ret.totalAmount).toFixed(2)}
        </span>
      </div>

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Authorized Signature</span>
        </div>
      </div>
    </div>`;
  },

  // ── Wastage entry ────────────────────────────────────────────────────
  // Plainer than the two notes above because desktop's wastage print is
  // plainer -- it is the reference, so this is what the phone prints too.
  // One entry, not a whole document: desktop wraps these in a popup print
  // window, and the phone (where popups are unreliable) renders the same
  // entries into the shared bulk container.
  wastageNote(w, deps) {
    const { esc, nameCase } = this._deps(deps);
    const itemRows = (w.items || []).map(it => `
        <tr>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${esc(it.name || '')}${it.size ? ` <em>(${esc(it.size)})</em>` : ''}</td>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${esc(String(it.qty || ''))} ${esc(it.unit || '')}</td>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${esc(it.reason || '—')}</td>
        </tr>`).join('');

    const vendorLine = w.vendor ? `<br><small><strong>Vendor:</strong> ${esc(nameCase(w.vendor))}</small>` : '';
    const remarksLine = w.remarks ? `<br><small><strong>Remarks:</strong> ${esc(w.remarks)}</small>` : '';

    return `
      <div class="wastage-entry" style="page-break-inside:avoid; margin-bottom:24px; border:1px solid #dee2e6; border-radius:6px; padding:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
          <div>
            <strong style="font-size:15px;">${esc(w.wastageId)}</strong>
            ${vendorLine}
            ${remarksLine}
          </div>
          <div class="text-end">
            <span style="background:#fff3cd; padding:4px 10px; border-radius:4px; font-weight:bold;">${esc(w.date || '')}</span>
          </div>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#f8f9fa;">
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left;">Item</th>
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left; width:15%;">Qty</th>
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left; width:35%;">Reason</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>
        <div style="margin-top:8px; font-size:12px; color:#666;">
          Total Qty: <strong>${esc(String(w.totalQty ?? 0))}</strong>
        </div>
      </div>`;
  },
  // ── Contractor statement ─────────────────────────────────────────────
  // The printed ledger is the ledger ON SCREEN. Printing a whole account
  // from a screen filtered to a date window hands somebody a document that
  // does not match what they were looking at when they pressed the button,
  // and they have no way to tell, because every row in it is real.
  //
  // The opening balance travels with it for the same reason it is on
  // screen: the balance column is cumulative across the whole account, so
  // without the carried-in figure the first printed row reads as though
  // the account began mid-window.
  //
  // The phone printed neither -- no window, no opening row -- so a
  // contractor at the gate and the office were reading two different
  // statements of the same account.
  contractorLedgerBody(entries, opening, from, to, deps) {
    const { esc, money } = this._deps(deps);
    const cell = 'padding:6px;border:1px solid #999;color:#000;';
    const num = `${cell}text-align:right;font-weight:700;`;
    const rows = entries || [];

    if (!rows.length) {
      return `<tr><td colspan="7" style="padding:10px;text-align:center;color:#999;">${
        from || to
          ? 'No transactions in the selected dates.'
          : 'No transactions yet for this contractor.'
      }</td></tr>`;
    }

    const openingRow = opening === null || opening === undefined
      ? ''
      : `<tr>
      <td style="${cell}">${esc(from || '')}</td>
      <td style="${cell}">Opening</td>
      <td style="${cell}"></td>
      <td style="${cell}">Balance carried into the selected dates</td>
      <td style="${num.replace('font-weight:700;', '')}">-</td>
      <td style="${num.replace('font-weight:700;', '')}">-</td>
      <td style="${num}">${money(opening)}</td>
    </tr>`;

    return openingRow + rows.map(e => `<tr>
      <td style="${cell}">${esc(e.date)}</td>
      <td style="${cell}">${esc(e.type)}</td>
      <td style="${cell}">${esc(e.ref)}</td>
      <td style="${cell}">${esc(e.description)}</td>
      <td style="${num}">${e.type === 'Payable' ? money(e.amount) : '-'}</td>
      <td style="${num}">${e.type === 'Payment' ? money(e.rawAmount) : '-'}</td>
      <td style="${num}">${money(e.balance)}</td>
    </tr>`).join('');
  },

  // "Period: 01/08/2026 to today", or nothing at all when the statement
  // covers the whole account. Shared so the two shells cannot word it
  // differently.
  ledgerPeriodLine(from, to) {
    return (from || to) ? `Period: ${from || 'start'} to ${to || 'today'}` : '';
  },

  // The balance carried into a window. Entries arrive in chronological
  // order (the running balance depends on it), so the last one before the
  // window is what was carried in. Null means no window, so nothing is
  // being excluded and no opening row belongs on the page.
  ledgerOpeningBalance(entries, from, toInputValue) {
    if (!from) return null;
    const asValue = toInputValue || (e => e.dateRaw || e.date);
    let carried = 0;
    let sawAny = false;
    (entries || []).forEach(e => {
      const value = asValue(e);
      if (value && value < from) { carried = e.balance; sawAny = true; }
    });
    return sawAny ? carried : 0;
  },
  // ── Item Ledger & Comparison ─────────────────────────────────────────
  // Three sections: what is on the shelf per size, how each vendor's rate
  // compares, and every movement that got the item to its current figure.
  //
  // Not a renderer so much as an assembler -- it reads six collections
  // (items, stock, vendors, POs, bills and the server's own ledger) and
  // that is exactly why the phone never had this document: the data was
  // reachable but nothing joined it up. `src` is that bag, so each shell
  // hands over its own copies and the joining happens once, here.
  //
  // The rows use Bootstrap utility classes, which mobile.html does not
  // load -- partials/print.html defines the handful they need, scoped to
  // .print-container, so the same markup prints on both shells.
  itemLedgerSections(name, src, deps) {
    const { esc, num, money } = this._deps(deps);
    const getPendingByItem = (deps && deps.getPendingByItem) || (() => ({}));
    src = src || {};
    const nameLower = name.toLowerCase();
    const compMap = {};

    const getCKey = (size, vendor) => `${String(size || '').trim().toLowerCase()}|${String(vendor || '').trim().toLowerCase()}`;

    const sortedPOs = [...(src.pos || [])].sort((a, b) => {
      const ad = parseRecordDate(a.poDateRaw, a.poDate);
      const bd = parseRecordDate(b.poDateRaw, b.poDate);
      return ad - bd;
    });

    sortedPOs.forEach(po => {
      (po.items || []).forEach(line => {
        if ((line.name || '').toLowerCase() === nameLower) {
          const key = getCKey(line.size, po.vendor);
          compMap[key] = {
            size: line.size || '-',
            narration: line.narration || '-',
            vendor: po.vendor,
            masterRate: null,
            // baseRate, not price. `price` is per ENTERED unit: a spoke
            // ordered by the Gross carries 94.00 there and 0.6528 in
            // baseRate, and the Item Master rate beside it is per piece.
            // Comparing them printed a 144x price rise that did not
            // happen, on the one table whose whole job is spotting a
            // price change. The server has computed baseRate since
            // po_service went in and nothing on the client had used it.
            latestPoRate: line.baseRate != null ? line.baseRate : line.price
          };
        }
      });
    });

    const itemMasterVariants = (src.items || []).filter(i => (i.name || '').toLowerCase() === nameLower);
    itemMasterVariants.forEach(item => {
      (item.vendors || []).forEach(v => {
        const key = getCKey(item.size, v.vendor);
        if (compMap[key]) {
          compMap[key].masterRate = v.rate;
        } else {
          compMap[key] = { size: item.size || '-', narration: item.narration || '-', vendor: v.vendor, masterRate: v.rate, latestPoRate: null };
        }
      });
    });

    let compHtml = '';
    const compList = Object.values(compMap);
    compList.sort((a, b) => {
      const sc = a.size.localeCompare(b.size);
      if (sc !== 0) return sc;
      return a.vendor.localeCompare(b.vendor);
    });

    compList.forEach(entry => {
      const vendorInfo = (src.vendors || []).find(vendor => vendor.name.toLowerCase() === entry.vendor.toLowerCase());
      const contact = vendorInfo ? (vendorInfo.contact || vendorInfo.address || '-') : '-';
      const mRateText = entry.masterRate !== null ? money(entry.masterRate) : '-';
      const pRateText = entry.latestPoRate !== null ? money(entry.latestPoRate) : '-';

      compHtml += `<tr>
        <td><strong>${esc(entry.size)}</strong></td>
        <td><small class="text-muted">${esc(entry.narration)}</small></td>
        <td><strong class="text-primary">${esc(entry.vendor)}</strong></td>
        <td><small>${esc(contact)}</small></td>
        <td class="text-end fw-bold">${mRateText}</td>
        <td class="text-end fw-bold text-success">${pRateText}</td>
      </tr>`;
    });

    // History comes straight from the server (getItemLedgerData), which
    // builds it from the SAME terms, signs and unit conversions as the
    // Current Stock formula -- so it reconciles with the Stock page by
    // construction. It used to be reassembled here from whichever
    // collections the browser happened to have loaded, which silently
    // dropped Wastage and Issue entirely, showed as-entered instead of
    // base-unit quantities, and reconstructed Production consumption from
    // the BOM recipe (an estimate that missed every non-final-stage lot,
    // since only final-stage lots carry a productId to match a BOM by).
    // Populated by ensureItemLedgerLoaded(), which every caller of this
    // function awaits first.
    const ledger = src.itemLedgers[nameLower];
    const historyList = (ledger && ledger.entries) || [];

    const BADGE_BY_KIND = {
      PO: 'bg-primary',
      BILL: 'bg-success',
      RETURN: 'bg-danger',
      WASTAGE: 'bg-danger',
      ISSUE: 'bg-danger',
      PRODUCTION: 'bg-danger',
      ADJUSTMENT: 'bg-warning text-dark'
    };

    const fmtQty = v => {
      const n = num(v);
      if (!n) return '-';
      return String(Math.round(n * 10000) / 10000);
    };

    // Unlike fmtQty, a balance of exactly zero is a real reading -- the
    // stock ran out on this row -- so it prints "0" rather than the "-"
    // fmtQty uses for "this column does not apply to this row". A negative
    // balance is shown in red and never clamped: it means the ledger says
    // more went out than came in, which is a signal to investigate, not a
    // number to tidy away.
    const fmtBalance = v => {
      const n = num(v);
      const text = String(Math.round(n * 10000) / 10000);
      return n < 0 ? `<span class="text-danger">${text}</span>` : text;
    };

    // One entry -> one <tr>. Size itself is no longer a cell here -- entries
    // are grouped into a separate mini-table per size below, so the size is
    // said once in that group's heading instead of repeated down a column.
    const buildHistRow = entry => {
      const badgeClass = entry.kind === 'ADJUSTMENT' && entry.type === 'Stock Reset'
        ? 'bg-info'
        : (BADGE_BY_KIND[entry.kind] || 'bg-secondary');

      // Quantities are base-unit. Show what was actually typed alongside it
      // whenever the two differ, so a line entered in Dozen reads
      // "12 (1 Dozen)" instead of silently disagreeing with the Stock page.
      const enteredQty = num(entry.enteredQty);
      const baseMoved = num(entry.incomingQty) || num(entry.outgoingQty) || num(entry.orderQty);
      const showEntered = entry.unit && enteredQty && Math.abs(enteredQty - baseMoved) > 0.0001;
      const enteredNote = showEntered
        ? ` <small class="text-muted">(${fmtQty(enteredQty)} ${esc(entry.unit)})</small>`
        : '';

      // A row the Stock formula does not count -- a "Ledger only" bill, a
      // PO (an order, not a movement), or a manual adjustment (already
      // absorbed into Initial Stock). Muted so it can't be misread as a
      // movement that failed to land.
      const rowClass = entry.countsTowardStock ? '' : ' class="text-muted fst-italic"';

      // Balance is the stock on hand after this row, from the server (which
      // starts it at the same initial_stock the Current Stock formula uses).
      // null on a row that moved no stock -- a PO, a "Ledger only" bill, an
      // adjustment -- so the column never implies those settled at a figure.
      const balanceCell = (entry.balance === null || entry.balance === undefined)
        ? '<span class="text-muted">-</span>'
        : fmtBalance(entry.balance);

      return `<tr${rowClass}>
        <td>${esc(entry.date || '')}</td>
        <td><span class="badge ${badgeClass}">${esc(entry.type || '')}</span></td>
        <td><strong class="text-dark">${esc(entry.ref || '-')}</strong></td>
        <td><strong class="text-primary">${esc(entry.party || '-')}</strong></td>
        <td><small class="text-muted">${esc(entry.narration || '-')}</small></td>
        <td class="text-end">${entry.price !== null && entry.price !== undefined ? money(entry.price) : '-'}</td>
        <td class="text-center text-primary fw-bold">${fmtQty(entry.orderQty)}</td>
        <td class="text-center text-success fw-bold">${fmtQty(entry.incomingQty)}${entry.incomingQty ? enteredNote : ''}</td>
        <td class="text-center text-danger fw-bold">${fmtQty(entry.outgoingQty)}${entry.outgoingQty ? enteredNote : ''}</td>
        <td class="text-center fw-bold">${balanceCell}</td>
      </tr>`;
    };

    // Group by size (preserving each size's own chronological order from
    // the server), then sort the groups themselves by size so the
    // Comparison/Stock tables above and the History groups below list
    // sizes in the same order.
    const bySize = new Map();
    historyList.forEach(entry => {
      const sizeKey = entry.size || '-';
      if (!bySize.has(sizeKey)) bySize.set(sizeKey, []);
      bySize.get(sizeKey).push(entry);
    });
    const sizeKeys = [...bySize.keys()].sort((a, b) => String(a).localeCompare(String(b)));

    // Namespaced by item name so bulk-print pages (which concatenate many
    // items' ledgers, each rebuilding its own groups) don't hand out
    // duplicate ids across items.
    const idBase = (nameLower.replace(/[^a-z0-9]/g, '') || 'item');

    let histHtml = sizeKeys.map((sizeKey, i) => {
      const entries = bySize.get(sizeKey);
      const rows = entries.map(buildHistRow).join('');
      const groupId = `ledgerHist-${idBase}-${i}`;
      return `
      <div class="ledger-size-group mb-3">
        <div class="ledger-size-toggle fw-bold px-3 py-2 d-flex justify-content-between align-items-center"
             style="background:#eef6f8;border-left:4px solid #17a2b8;cursor:pointer;"
             data-bs-toggle="collapse" data-bs-target="#${groupId}"
             role="button" aria-expanded="true" aria-controls="${groupId}">
          <span>Size: ${esc(sizeKey)} <span class="badge bg-secondary ms-2">${entries.length} txn${entries.length === 1 ? '' : 's'}</span></span>
          <i class="bi bi-chevron-down"></i>
        </div>
        <div class="collapse show" id="${groupId}">
          <div class="table-responsive">
            <table class="table table-hover table-striped align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th scope="col" style="width: 8%;">Date</th>
                  <th scope="col" style="width: 11%;">Type</th>
                  <th scope="col" style="width: 10%;">Ref #</th>
                  <th scope="col" style="width: 16%;">Vendor / Source</th>
                  <th scope="col" style="width: 13%;">Narration</th>
                  <th scope="col" style="width: 8%; text-align: right;">Price</th>
                  <th scope="col" style="width: 9%; text-align: center;">Order Qty</th>
                  <th scope="col" style="width: 9%; text-align: center;">Incoming Qty</th>
                  <th scope="col" style="width: 9%; text-align: center;">Outgoing Qty</th>
                  <th scope="col" style="width: 7%; text-align: center;">Balance</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    }).join('');

    // Prefer the server's own freshly-computed figures over globalStock,
    // which is a tab-load snapshot: a lot completed (or a bill saved) since
    // the Items tab was last loaded would otherwise render a stale Current
    // Stock next to fresh movements, and trip the mismatch badge below for
    // no real reason. Falls back to globalStock only when the ledger call
    // failed, so the table still renders something.
    const reconList = (ledger && ledger.reconciliation) || [];
    const stockVariants = (reconList.length
      ? reconList.map(r => ({
        size: r.size,
        initialStock: r.initialStock,
        currentStock: r.currentStock,
        isLowStock: r.isLowStock,
        computedStock: r.computedStock,
        balanced: r.balanced
      }))
      : (src.stock || [])
        .filter(s => (s.name || '').toLowerCase() === nameLower)
        .map(s => ({ ...s, balanced: true }))
    ).sort((a, b) => String(a.size || '').localeCompare(String(b.size || '')));

    const pendingMap = getPendingByItem();

    let stockHtml = '';
    stockVariants.forEach(s => {
      const pendingEntry = pendingMap.get(`${nameLower}|${(s.size || '').toLowerCase()}`);
      const pendingText = pendingEntry
        ? `${Math.round(pendingEntry.qty * 100) / 100} <small class="text-muted">(PO# ${[...pendingEntry.poNumbers].map(escapeHtml).join(', ')})</small>`
        : '-';

      // Server-side proof that the movements listed below actually add up
      // to the Current Stock shown here. Silence means they agree; a
      // mismatch is badged rather than hidden, since it would mean a
      // movement exists that one side counts and the other doesn't.
      const driftBadge = s.balanced === false
        ? ` <span class="badge bg-danger" title="Ledger movements total ${s.computedStock}, but Current Stock is ${s.currentStock}. These should match -- please report this.">Mismatch</span>`
        : '';

      stockHtml += `<tr>
        <td>${esc(s.size || '-')}</td>
        <td class="text-center fw-bold">${s.initialStock}</td>
        <td class="text-center fw-bold ${s.isLowStock ? 'text-danger' : 'text-success'}">${s.currentStock}${driftBadge}</td>
        <td class="text-center fw-bold text-warning">${pendingText}</td>
      </tr>`;
    });

    return { compHtml, histHtml, stockHtml };
  },
  // ── What is still owed on open POs ───────────────────────────────────
  // Ordered minus billed, per item and size, with the PO numbers it is
  // outstanding on. The Item Ledger prints it, so both shells need the
  // same answer -- and it used to be reachable only through App.Bill's
  // cached index, which is why the phone could not build the document.
  //
  // Takes the two collections rather than reading any shell's state, so
  // the caller decides what "the bills" means. No caching here: the
  // callers that needed it (an open bill form recalculating on every
  // keystroke) keep their own.
  billedQtyIndex(bills) {
    const index = new Map();
    (bills || []).forEach(bill => {
      const billNumber = String(bill.billNumber || '').trim();
      (bill.items || []).forEach(bItem => {
        const key = [
          String(bItem.poNumber || '').trim(),
          String(bItem.name || '').trim().toLowerCase(),
          String(bItem.size || '').trim().toLowerCase(),
          String(bItem.narration || '').trim().toLowerCase()
        ].join('|');
        let entry = index.get(key);
        if (!entry) { entry = { total: 0, byBill: new Map() }; index.set(key, entry); }
        const qty = this._baseUnits(bItem);
        entry.total += qty;
        entry.byBill.set(billNumber, (entry.byBill.get(billNumber) || 0) + qty);
      });
    });
    return index;
  },

  // `index` is billedQtyIndex()'s output, passed in so a caller holding a
  // cached one does not rebuild it per line.
  billedQty(index, poNumber, itemName, itemSize, itemNarration, excludeBillNumber) {
    const key = [
      String(poNumber || '').trim(),
      String(itemName || '').trim().toLowerCase(),
      String(itemSize || '').trim().toLowerCase(),
      String(itemNarration || '').trim().toLowerCase()
    ].join('|');
    const entry = index && index.get(key);
    if (!entry) return 0;
    if (excludeBillNumber) {
      return entry.total - (entry.byBill.get(String(excludeBillNumber).trim()) || 0);
    }
    return entry.total;
  },

  // How many base units a line represents. Mirrors po_service's own
  // `effective_base_qty`: a legacy row that never went through unit
  // conversion carries baseQty 0, and is 1:1 with its as-entered qty
  // rather than being worth nothing.
  _baseUnits(line) {
    const base = Number((line || {}).baseQty) || 0;
    return base > 0 ? base : (Number((line || {}).qty) || 0);
  },

  pendingByItem(pos, bills) {
    const index = this.billedQtyIndex(bills);
    const map = new Map();
    (pos || []).forEach(po => {
      (po.items || []).forEach(line => {
        const name = String(line.name || '').trim();
        if (!name) return;
        const size = String(line.size || '').trim();
        // Same fallback po_service applies: baseQty 0 means the row
        // predates unit conversion, not that nothing was ordered. Without
        // it every legacy line silently vanished from what is still owed.
        const ordered = this._baseUnits(line);
        if (ordered <= 0) return;

        const billed = this.billedQty(index, po.poNumber, name, size, line.narration);
        const pending = ordered - billed;
        if (pending <= 0.0001) return;

        const key = `${name.toLowerCase()}|${size.toLowerCase()}`;
        const entry = map.get(key) || { qty: 0, poNumbers: new Set() };
        entry.qty += pending;
        entry.poNumbers.add(String(po.poNumber));
        map.set(key, entry);
      });
    });
    return map;
  },
  // ── BOM Cost Sheet / Recipe Card ─────────────────────────────────────
  // A self-contained page per recipe: the components grouped as the recipe
  // groups them, the extra costs, and what the product costs to make.
  // Desktop prints one or many; the phone had the recipes on screen and no
  // way to put one on paper.
  bomCostSheet(bom, deps) {
    const { esc, num, money, brand: _brand } = this._deps(deps);
    const qty = (deps && deps.formatQty) || (v => String(v == null ? '' : v));
    const brandHeader = (deps && deps.brandHeaderHtml) || (() => '');
    const BRAND = '#6610f2';
    const reportDate = new Date().toLocaleDateString('en-GB');

    const groupOrder = [];
    const groupMap = {};
    (bom.components || []).forEach(c => {
      const groupName = c.processGroup || 'General';
      if (!groupMap[groupName]) {
        groupMap[groupName] = [];
        groupOrder.push(groupName);
      }
      groupMap[groupName].push(c);
    });

    let groupsHtml = '';
    groupOrder.forEach(groupName => {
      let rowsHtml = '';
      groupMap[groupName].forEach(c => {
        rowsHtml += `<tr>
      <td style="padding:6px;border:1px solid #e5e5e5;font-weight:600;">${esc(c.itemName)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${esc(c.size || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;color:#555;">${esc(c.narration || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${esc(c.vendor || 'Custom')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${Number(num(c.qtyPerProduct).toFixed(4))}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;">${money(c.rate)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${money(c.lineCost)}</td>
    </tr>`;
      });

      groupsHtml += `
  <div style="margin-bottom:14px;page-break-inside:avoid;break-inside:avoid;">
    ${groupOrder.length > 1 ? `<h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${esc(groupName)}</h6>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:22%;">Item Name</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:10%;">Size</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Narration</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:16%;">Vendor</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:center;width:10%;">Qty/Unit</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:11%;">Rate</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:11%;">Line Cost</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
    });

    let costsRows = '';
    (bom.additionalCosts || []).forEach(cost => {
      costsRows += `<tr>
    <td style="padding:6px;border:1px solid #e5e5e5;">${esc(cost.description)}</td>
    <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${money(cost.rate)}</td>
  </tr>`;
    });
    const costsSectionHtml = (bom.additionalCosts && bom.additionalCosts.length > 0) ? `
  <div style="margin-bottom:14px;page-break-inside:avoid;break-inside:avoid;">
    <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Additional / Dynamic Costs</h6>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:75%;">Description</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:25%;">Rate</th>
        </tr>
      </thead>
      <tbody>${costsRows}</tbody>
    </table>
  </div>` : '';

    const remarksHtml = bom.remarks ? `
  <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
    <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
    <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${esc(bom.remarks)}</div>
  </div>` : '';

    return `
<div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:4px 0 8px 0;">
    ${brandHeader(BRAND)}
    <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
      6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
    </div>
    <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
      Bill of Materials &mdash; Cost Sheet / Recipe Card
    </div>
  </div>
  <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <div style="text-align:left;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product ID</span>
      <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${esc(bom.productId)}</div>
    </div>
    <div style="flex:1;text-align:center;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product Name</span>
      <div style="font-size:16px;font-weight:700;color:#111;">${esc(bom.productName)}</div>
    </div>
    <div style="text-align:right;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Report Date</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${reportDate}</div>
    </div>
  </div>

  <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

  ${groupsHtml}
  ${costsSectionHtml}

  <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
    <span style="font-size:11px;font-weight:600;color:#555;">Material Cost:&nbsp;&nbsp;${money(bom.totalCost)} &nbsp;&nbsp;|&nbsp;&nbsp; Additional Cost:&nbsp;&nbsp;${money(bom.totalAdditionalCost)}</span>
    <br>
    <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Total Estimated Cost (per unit):&nbsp;&nbsp;</span>
    <span style="font-size:15px;font-weight:800;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      ${money(bom.grandTotal ?? bom.totalCost)}
    </span>
    ${(bom.colorCosts || []).length > 1 ? `
    <div style="font-size:10px;color:#777;margin-top:2px;">
      Color rows are alternatives, not additive &mdash; cost above is for <strong>${esc(bom.colorCosts[0].color)}</strong> only.
      By color: ${bom.colorCosts.map(c => `${esc(c.color)} ${money(c.totalCost + bom.totalAdditionalCost)}`).join(' &nbsp;|&nbsp; ')}
    </div>` : ''}
  </div>
  ${remarksHtml}
</div>`;
  },
  // ── Vendor ledger ────────────────────────────────────────────────────
  // What came in from this vendor and what went back: POs, bills, returns
  // and issues merged into one dated run with a running quantity, plus
  // what is still outstanding per item. Assembled from four collections,
  // which is why the phone -- where all four were reachable -- still had
  // no vendor ledger.
  vendorLedger(vendorName, src, deps) {
    const { esc, num, sameText } = this._deps(deps);
    src = src || {};
    const vendorPOs = src.pos.filter(po => sameText(po.vendor, vendorName));
    const vendorBills = src.bills.filter(b => sameText(b.vendor, vendorName));
    const vendorReturns = (src.returns || []).filter(r => sameText(r.vendor, vendorName));
    const vendorIssues = (src.issues || []).filter(iss => sameText(iss.vendor, vendorName));

    let ledger = [];
    vendorPOs.forEach(po => {
      ledger.push({
        dateObj: parseRecordDate(po.poDateRaw, po.poDate),
        dateStr: po.poDate,
        type: 'PO Issued',
        ref: `PO-${po.poNumber}`,
        items: po.items.map(i => `${i.name} (${String(i.qty)})`).join(', '),
        orderQty: po.items.reduce((sum, i) => sum + num(i.qty), 0),
        incomingQty: 0,
        outgoingQty: 0,
        value: po.grandTotal,
        badgeClass: 'bg-primary'
      });
    });

    vendorBills.forEach(b => {
      const itemsStr = b.items.length
        ? (typeof b.items[0] === 'object'
          ? b.items.map(i => `${i.name} (${String(i.qty)})`).join(', ')
          : b.items.map(s => String(s)).join(', '))
        : '';
      const billQty = typeof b.items[0] === 'object'
        ? b.items.reduce((sum, i) => sum + num(i.qty), 0)
        : 0;
      ledger.push({
        dateObj: parseRecordDate(b.billDateRaw, b.billDate),
        dateStr: b.billDate,
        type: 'Bill Received',
        ref: b.billNumber,
        items: itemsStr,
        orderQty: 0,
        incomingQty: billQty,
        outgoingQty: 0,
        value: b.totalAmount,
        badgeClass: 'bg-success'
      });
    });

    vendorReturns.forEach(r => {
      const itemsStr = (r.items || []).map(i => `${i.name} (${String(i.qty)})`).join(', ');
      const returnQty = (r.items || []).reduce((sum, i) => sum + num(i.qty), 0);
      ledger.push({
        dateObj: parseRecordDate(r.returnDateRaw, r.returnDate),
        dateStr: r.returnDate,
        type: 'Goods Returned',
        ref: r.returnNumber,
        items: itemsStr,
        orderQty: 0,
        incomingQty: 0,
        outgoingQty: returnQty,
        value: r.totalAmount,
        badgeClass: 'bg-danger'
      });
    });

    vendorIssues.forEach(iss => {
      const itemsStr = (iss.items || []).map(i => `${i.name} (${String(i.qty)})`).join(', ');
      ledger.push({
        dateObj: parseRecordDate(iss.dateRaw, iss.date),
        dateStr: iss.date,
        type: 'Stock Issued',
        ref: iss.issueId,
        items: itemsStr,
        orderQty: 0,
        incomingQty: 0,
        outgoingQty: num(iss.totalQty),
        value: num(iss.totalValue) || 0,
        badgeClass: 'bg-warning text-dark'
      });
    });

    // Running qty balance: net units taken from this vendor to date.
    //
    // Accumulated over a CHRONOLOGICAL copy while the display order stays
    // newest-first below -- the entries are the same objects, so writing
    // .balance here lands on the rows the table renders. Same shape as the
    // Item Ledger, the Pool Ledger and the Contractor Account Ledger, all of
    // which accumulate oldest-first and display newest-first.
    //
    // A PO moves nothing -- it is an intent to buy, and the goods arrive as
    // a Bill that has its own row -- so it leaves the balance untouched and
    // reports null rather than the carried-forward figure. Counting a PO
    // here would double every order: once when placed, once when received.
    // This mirrors countsTowardStock in get_item_ledger_data.
    let runningQty = 0;
    [...ledger].sort((a, b) => a.dateObj - b.dateObj).forEach(entry => {
      if (entry.type === 'PO Issued') {
        entry.balance = null;
        return;
      }
      runningQty += num(entry.incomingQty) - num(entry.outgoingQty);
      entry.balance = runningQty;
    });

    ledger.sort((a, b) => b.dateObj - a.dateObj);

    let itemMap = {};

    // Ordered and received in BASE units, which is what the server's own
    // remaining-qty calculations use (po_service, bill_service and
    // dashboard_service all subtract base quantities) and what the Item
    // Ledger reports. As-entered quantities made this table disagree with
    // that one by the conversion factor -- 280 here against 40,320 there
    // for the same outstanding spokes, neither stating a unit. It is also
    // only safe while a PO and its bills share one unit: nothing enforces
    // that, and the first bill entered in Pcs against a PO in Gross would
    // have made this subtraction meaningless.
    vendorPOs.forEach(po => {
      (po.items || []).forEach(i => {
        const key = `${i.name}|${i.size || ''}`;
        if (!itemMap[key]) itemMap[key] = { name: i.name, size: i.size, ordered: 0, received: 0 };
        itemMap[key].ordered += this._baseUnits(i);
      });
    });

    vendorBills.forEach(b => {
      b.items.forEach(i => {
        const name = typeof i === 'object' ? i.name : String(i).split(' [')[0];
        const size = typeof i === 'object' ? (i.size || '') : '';
        const qty = typeof i === 'object' ? this._baseUnits(i) : 0;
        const key = `${name}|${size}`;
        if (itemMap[key]) {
          itemMap[key].received += qty;
        }
      });
    });

    const pendingList = Object.values(itemMap)
      .map(item => ({ ...item, pending: item.ordered - item.received }))
      .filter(item => item.pending !== 0);

    return { ledger, pendingList };
  },
  // ── Vendor Profile & Transaction Ledger ──────────────────────────────
  // The whole page, self-contained, so a shell with no vendor-detail
  // screen can still print the document. Desktop reached this only from
  // bulk print; the phone reaches it from the vendor list.
  vendorLedgerSheet(vendor, src, deps) {
    const { esc, num, money, nameCase } = this._deps(deps);
    const brandHeader = (deps && deps.brandHeaderHtml) || (() => '');
    const BRAND = '#D35400';
    const { ledger, pendingList } = this.vendorLedger(vendor.name, src, deps);

    let ledgerHtml = '';
    ledger.forEach(entry => {
      ledgerHtml += `<tr>
        <td style="padding:6px;border:1px solid #e5e5e5;">${esc(entry.dateStr)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;">${esc(entry.type)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;font-weight:700;">${esc(entry.ref)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;color:#555;">${esc(entry.items)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">${entry.orderQty || '-'}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">${entry.incomingQty || '-'}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">-</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${money(entry.value)}</td>
      </tr>`;
    });
    const ledgerRows = ledgerHtml || '<tr><td colspan="8" style="padding:10px;text-align:center;color:#999;">No transaction history found.</td></tr>';

    let pendingHtml = '';
    pendingList.forEach(item => {
      const isOver = item.pending < 0;
      pendingHtml += `<tr>
        <td style="padding:6px;border:1px solid #e5e5e5;font-weight:700;color:#0d6efd;">${esc(item.name)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;">${esc(item.size || '-')}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${item.ordered}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${item.received}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;color:${isOver ? '#198754' : '#dc3545'};">
          ${isOver ? '+' : ''}${Math.abs(item.pending)}${isOver ? ' (Over-Delivered)' : ''}
        </td>
      </tr>`;
    });
    const pendingRows = pendingHtml || '<tr><td colspan="5" style="padding:10px;text-align:center;color:#198754;font-weight:700;">No pending orders. All caught up!</td></tr>';

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${brandHeader(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
          Vendor Profile &amp; Transaction Ledger Report
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;page-break-inside:avoid;break-inside:avoid;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vendor Name</span>
              <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-top:1px;">${esc(nameCase(vendor.name))}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">GSTIN</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${esc(vendor.gstin || '-')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contact Info</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${esc(vendor.contact || '-')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Address</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${esc(vendor.address || '-')}</div>
            </div>
          </div>
        </div>
        <div style="margin-top:8px;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
          <div style="font-size:11px;color:#444;margin-top:1px;font-style:italic;">${esc(vendor.remarks || 'No remarks')}</div>
        </div>
      </div>

      <div style="margin-bottom:20px;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Ledger Transaction History</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:12%;">Date</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Doc Type</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Reference #</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:43%;">Items Summary</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:right;width:15%;">Total Value</th>
            </tr>
          </thead>
          <tbody>${ledgerRows}</tbody>
        </table>
      </div>

      <div style="margin-bottom:20px;page-break-inside:avoid;break-inside:avoid;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Pending Quantities Summary</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:45%;">Item Name</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Size</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:13%;">Total Ordered</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:13%;">Total Received</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:14%;">Pending Qty</th>
            </tr>
          </thead>
          <tbody>${pendingRows}</tbody>
        </table>
      </div>
    </div>`;
  },
  // ── Client ledger ────────────────────────────────────────────────────
  // Three sections: every PI/Estimate, what is still owed on the confirmed
  // ones, and everything dispatched. Assembled from orders and dispatches
  // -- both reachable on the phone, neither joined up there before.
  clientLedgerSections(clientName, src, deps) {
    const { esc, sameText } = this._deps(deps);
    const qty = (deps && deps.formatQty) || (v => String(v == null ? '' : v));
    const piStatus = (deps && deps.piDisplayStatus)
      || (o => ({ label: String((o && o.status) || '-'), badgeClass: 'bg-secondary' }));
    src = src || {};

    const orders = (src.orders || []).filter(o => sameText(o.clientName, clientName));
    const dispatches = (src.dispatches || []).filter(d => sameText(d.clientName, clientName));

    const ordersHtml = orders.map(o => {
      const productsSummary = (o.lines || [])
        .map(l => `${esc(l.productName)} <span class="text-muted">x${qty(l.qty)}</span>`)
        .join('<br>');
      const totalQty = (o.lines || []).reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
      const { label, badgeClass } = piStatus(o);
      return `<tr>
          <td><span class="badge bg-dark shadow-sm">${esc(o.orderNumber)}</span></td>
          <td>${esc(o.orderDate)}</td>
          <td><small>${productsSummary || '-'}</small></td>
          <td class="text-center"><span class="badge ${badgeClass} shadow-sm">${label}</span></td>
          <td class="text-center fw-bold">${qty(totalQty)}</td>
        </tr>`;
    }).join('');

    const pendingHtml = this.pendingOrderLines(clientName, src, deps).map(p => `<tr>
          <td><span class="badge bg-dark shadow-sm">${esc(p.orderNumber)}</span></td>
          <td>${esc(p.orderDate)}</td>
          <td>${esc(p.productName)} <span class="text-muted">(${esc(p.productId)})</span></td>
          <td class="text-center">${qty(p.orderedQty)}</td>
          <td class="text-center">${qty(p.dispatchedQty)}</td>
          <td class="text-center fw-bold text-danger">${qty(p.pendingQty)}</td>
          <td class="text-center"><span class="badge ${p.badgeClass} shadow-sm">${p.label}</span></td>
        </tr>`).join('');

    const dispatchHtml = dispatches.map(d => {
      const invoiceGr = [
        d.invoiceNumber ? `Inv: ${esc(d.invoiceNumber)}` : '',
        d.grNumber ? `GR: ${esc(d.grNumber)}` : ''
      ].filter(Boolean).join('<br>');
      return `<tr>
          <td><span class="badge bg-success shadow-sm">${esc(d.dispatchNumber)}</span></td>
          <td>${esc(d.dispatchDate)}</td>
          <td>${esc(d.orderNumber) || '-'}</td>
          <td>${esc(d.productName)} <span class="text-muted">(${esc(d.productId)})</span></td>
          <td class="text-center fw-bold">${qty(d.qty)}</td>
          <td>${esc(d.transport) || '-'}</td>
          <td><small>${invoiceGr || '-'}</small></td>
        </tr>`;
    }).join('');

    return {
      ordersHtml: ordersHtml
        || '<tr><td colspan="5" class="text-center text-muted p-4">No PI / Estimates found for this client.</td></tr>',
      pendingHtml: pendingHtml
        || '<tr><td colspan="7" class="text-center text-success fw-bold p-4">No pending orders. All caught up!</td></tr>',
      dispatchHtml: dispatchHtml
        || '<tr><td colspan="7" class="text-center text-muted p-4">No dispatch records found for this client.</td></tr>'
    };
  },

  // One row per confirmed order line still awaiting dispatch. `clientName`
  // null means every client, which is what the global Pending Orders view
  // asks for.
  pendingOrderLines(clientName, src, deps) {
    const { sameText } = this._deps(deps);
    const piStatus = (deps && deps.piDisplayStatus)
      || (o => ({ label: String((o && o.status) || '-'), badgeClass: 'bg-secondary' }));
    src = src || {};
    const result = [];

    (src.orders || []).forEach(o => {
      if (o.status !== 'Order Confirmed') return;
      if (clientName && !sameText(o.clientName, clientName)) return;

      const { label, badgeClass } = piStatus(o);

      (o.lines || []).forEach(line => {
        const orderedQty = Number(line.qty) || 0;
        const dispatchedQty = (src.dispatches || [])
          .filter(d => d.orderNumber === o.orderNumber &&
            String(d.productId).toLowerCase() === String(line.productId).toLowerCase())
          .reduce((sum, d) => sum + (Number(d.qty) || 0), 0);
        const pendingQty = orderedQty - dispatchedQty;
        if (pendingQty <= 0.0001) return;

        result.push({
          orderNumber: o.orderNumber,
          orderDate: o.orderDate,
          clientName: o.clientName,
          productId: line.productId,
          productName: line.productName,
          orderedQty,
          dispatchedQty,
          pendingQty,
          label,
          badgeClass
        });
      });
    });

    return result;
  },

  // The whole page, self-contained -- desktop prints this by copying its
  // detail modal's three tables, which needs a modal. The phone has no
  // such screen, so the page is built here and both shells get the same
  // three sections under the same headings.
  clientLedgerSheet(client, src, deps) {
    const c = client || {};
    const { esc, nameCase } = this._deps(deps);
    const brandHeader = (deps && deps.brandHeaderHtml) || (() => '');
    const BRAND = '#0d6efd';
    const { ordersHtml, pendingHtml, dispatchHtml } =
      this.clientLedgerSections(c.name, src, deps);

    const th = 'padding:6px;border:1px solid #bbb;font-weight:700;text-align:left;';
    const section = (title, headers, rows) => `
      <div style="font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;letter-spacing:1px;margin:14px 0 6px 0;">${title}</div>
      <table class="table table-sm table-bordered" style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead style="background-color:${BRAND};color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>${headers.map(h => `<th style="${th}">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    const field = (label, value) => `
      <div style="flex:1;">
        <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">${label}</span>
        <div style="font-size:12px;font-weight:600;color:#1a1a1a;margin-top:1px;">${esc(value || '-')}</div>
      </div>`;

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${brandHeader(BRAND)}
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
          Client Profile &amp; Order Ledger
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div style="flex:1;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Client</span>
          <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-top:1px;">${esc(nameCase(c.name))}</div>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Printed</span>
          <div style="font-size:12px;font-weight:700;">${new Date().toLocaleDateString('en-GB')}</div>
        </div>
      </div>

      <div style="display:flex;gap:16px;margin-bottom:6px;padding-bottom:8px;border-bottom:1px solid #ccc;">
        ${field('GSTIN', c.gstin)}
        ${field('Contact', c.contact)}
      </div>
      <div style="display:flex;gap:16px;margin-bottom:4px;padding-bottom:8px;border-bottom:1px solid #ccc;">
        ${field('Address', c.address)}
        ${field('Remarks', c.remarks || 'No remarks')}
      </div>

      ${section('PI / Estimates', ['Order #', 'Date', 'Products', 'Status', 'Qty'], ordersHtml)}
      ${section('Pending Dispatch', ['Order #', 'Date', 'Product', 'Ordered', 'Dispatched', 'Pending', 'Status'], pendingHtml)}
      ${section('Dispatch History', ['Challan #', 'Date', 'Order #', 'Product', 'Qty', 'Transport', 'Invoice / GR'], dispatchHtml)}
    </div>`;
  }
};
