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
  }
};
