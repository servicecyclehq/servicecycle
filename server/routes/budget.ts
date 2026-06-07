const router = require('express').Router();

// v0.37.2 W6 MT-134: defensive cap on budget contract scan -- same pattern as
// reports.js. Bounds the OOM surface from "unbounded findMany" to 5000 rows.
// The warn surfaces in droplet logs if any account ever hits it.
const REPORT_QUERY_CAP = 5000;
function _warnIfCapped(label, rows) {
  if (rows && rows.length >= REPORT_QUERY_CAP) {
    console.warn('[budget] ' + label + ' hit REPORT_QUERY_CAP=' + REPORT_QUERY_CAP +
                 ' -- forecast rows may be truncated.');
  }
  return rows;
}
const ExcelJS = require('exceljs');
const { requireManager } = require('../middleware/roles');
import prisma from '../lib/prisma';

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcProjections(contract, neededQtyOverride, upliftPct) {
  const currentUnitPrice = contract.costPerLicense ? parseFloat(contract.costPerLicense) : null;
  const currentQty = contract.quantity || 0;
  // Priority: explicit override → saved budgetNeededQty → fall back to current qty
  const needed = neededQtyOverride != null
    ? parseInt(neededQtyOverride)
    : contract.budgetNeededQty != null
      ? parseInt(contract.budgetNeededQty)
      : currentQty;
  const uplift = upliftPct != null ? parseFloat(upliftPct) : parseFloat(contract.vendor.budgetUpliftPercent || 10);

  const currentTotal = currentUnitPrice != null ? currentUnitPrice * currentQty : null;
  const projectedUnitPrice = currentUnitPrice != null ? currentUnitPrice * (1 + uplift / 100) : null;
  const projectedTotal = projectedUnitPrice != null ? projectedUnitPrice * needed : null;
  const delta = currentTotal != null && projectedTotal != null ? projectedTotal - currentTotal : null;

  return { currentUnitPrice, currentQty, neededQty: needed, upliftPct: uplift, currentTotal, projectedUnitPrice, projectedTotal, delta };
}

// ── GET /api/budget/forecast ──────────────────────────────────────────────────
// Returns all active/under-review contracts with vendor uplift defaults applied.
router.get('/forecast', async (req, res) => {
  try {
    // Scope-restricted viewers see only contracts they own. Without this,
    // a restricted viewer could read every contract's cost / quantity /
    // uplift via the forecast page even though the per-contract endpoints
    // (routes/contracts.js) correctly hide them.
    const where: any = {
      accountId: req.user.accountId,
      status: { in: ['active', 'under_review'] },
    };
    if (req.user.contractScopeRestricted) where.internalOwnerId = req.user.id;

    const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
      where,
      orderBy: [{ vendor: { name: 'asc' } }, { endDate: 'asc' }],
      include: {
        vendor: { select: { id: true, name: true, budgetUpliftPercent: true } },
        internalOwner: { select: { id: true, name: true } },
        // (Phase 3) Category for By-Category rollup + per-row badge.
        category: { select: { id: true, name: true, slug: true, icon: true, color: true } },
      },
    });

    const rows = contracts.map((c) => ({
      id: c.id,
      product: c.product,
      vendorId: c.vendorId,
      vendorName: c.vendor.name,
      department: c.department,
      categoryId: c.categoryId,                      // (Phase 3)
      categoryName: c.category?.name || null,        // (Phase 3)
      categoryIcon: c.category?.icon || null,        // (Phase 3)
      categoryColor: c.category?.color || null,      // (Phase 3)
      endDate: c.endDate,
      status: c.status,
      internalOwner: c.internalOwner?.name || null,
      budgetUpliftPercent: parseFloat(String(c.vendor.budgetUpliftPercent || 10)),
      savedNeededQty: c.budgetNeededQty,   // expose so frontend knows if user previously saved a qty
      ...calcProjections(c, null, null),
    }));

    const totalCurrentSpend = rows.reduce((s, r) => s + (r.currentTotal || 0), 0);
    const totalProjectedSpend = rows.reduce((s, r) => s + (r.projectedTotal || 0), 0);

    // (A2 5/02) Optional department rollup. Same logic as the Excel export's
    // "By department breakdown" sheet — surfaces dept-level spend so finance
    // chargeback flows can use the API directly without touching the row list.
    const responseData: any = {
      rows,
      totalCurrentSpend,
      totalProjectedSpend,
      totalDelta: totalProjectedSpend - totalCurrentSpend,
    };

    if (req.query.groupBy === 'department') {
      const byDept: any = {};
      for (const r of rows) {
        const key = r.department || 'Unassigned';
        if (!byDept[key]) {
          byDept[key] = { department: key, count: 0, currentTotal: 0, projectedTotal: 0 };
        }
        byDept[key].count += 1;
        byDept[key].currentTotal   += r.currentTotal   || 0;
        byDept[key].projectedTotal += r.projectedTotal || 0;
      }
      responseData.byDepartment = Object.values<any>(byDept)
        .map(d => ({ ...d, delta: d.projectedTotal - d.currentTotal }))
        .sort((a, b) => b.projectedTotal - a.projectedTotal);
    }

    // (Phase 3) Optional category rollup — same shape as byDepartment.
    if (req.query.groupBy === 'category') {
      const byCat: any = {};
      for (const r of rows) {
        const key = r.categoryId || 'uncategorized';
        if (!byCat[key]) {
          byCat[key] = {
            categoryId:   r.categoryId,
            categoryName: r.categoryName || 'Uncategorized',
            categoryIcon: r.categoryIcon,
            categoryColor: r.categoryColor,
            count: 0,
            currentTotal: 0,
            projectedTotal: 0,
          };
        }
        byCat[key].count += 1;
        byCat[key].currentTotal   += r.currentTotal   || 0;
        byCat[key].projectedTotal += r.projectedTotal || 0;
      }
      responseData.byCategory = Object.values<any>(byCat)
        .map(c => ({ ...c, delta: c.projectedTotal - c.currentTotal }))
        .sort((a, b) => b.projectedTotal - a.projectedTotal);
    }

    res.json({ success: true, data: responseData });
  } catch (err) {
    console.error('Budget forecast error:', err);
    res.status(500).json({ success: false, error: 'Failed to build forecast' });
  }
});

// ── PUT /api/budget/vendor-uplift/:vendorId ───────────────────────────────────
// Saves the uplift % back to the vendor record.
router.put('/vendor-uplift/:vendorId', requireManager, async (req, res) => {
  try {
    const { budgetUpliftPercent } = req.body;
    if (budgetUpliftPercent == null || isNaN(parseFloat(budgetUpliftPercent))) {
      return res.status(400).json({ success: false, error: 'budgetUpliftPercent is required' });
    }

    const vendor = await prisma.vendor.findFirst({
      where: { id: req.params.vendorId, accountId: req.user.accountId },
    });
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    const updated = await prisma.vendor.update({
      where: { id: req.params.vendorId },
      data: { budgetUpliftPercent: parseFloat(budgetUpliftPercent) },
    });

    res.json({ success: true, data: { vendor: updated } });
  } catch (err) {
    console.error('Update uplift error:', err);
    res.status(500).json({ success: false, error: 'Failed to update uplift %' });
  }
});

// ── PUT /api/budget/contract-needed-qty/:contractId ──────────────────────────
// Saves the planned quantity for budget forecasting back to the contract record.
router.put('/contract-needed-qty/:contractId', requireManager, async (req, res) => {
  try {
    const { budgetNeededQty } = req.body;
    if (budgetNeededQty == null || isNaN(parseInt(budgetNeededQty))) {
      return res.status(400).json({ success: false, error: 'budgetNeededQty is required' });
    }

    const contract = await prisma.contract.findFirst({
      where: { id: req.params.contractId, accountId: req.user.accountId },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    await prisma.contract.update({
      where: { id: req.params.contractId },
      data: { budgetNeededQty: parseInt(budgetNeededQty) },
    });

    res.json({ success: true, data: { budgetNeededQty: parseInt(budgetNeededQty) } });
  } catch (err) {
    console.error('Update needed qty error:', err);
    res.status(500).json({ success: false, error: 'Failed to save needed qty' });
  }
});

// ── POST /api/budget/export ───────────────────────────────────────────────────
// Receives the current forecast state (with user-edited quantities/uplifts)
// and returns a formatted Excel file.
router.post('/export', async (req, res) => {
  try {
    const { rows, companyName } = req.body;
    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ success: false, error: 'rows array is required' });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'LapseIQ';
    wb.created = new Date();

    // H6: sanitize user-supplied text to prevent Excel formula injection.
    // Prefixes formula-trigger characters so the spreadsheet app treats the
    // value as plain text, not a formula.
    function safeText(v) {
      if (v == null) return '';
      const s = String(v);
      return /^\s*[=+\-@\t\r]/.test(s) ? "'" + s : s;
    }

    // ── Color palette ────────────────────────────────────────────────────────
    const HEADER_BG   = '1E293B'; // dark navy
    const HEADER_FG   = 'FFFFFF';
    const SECTION_BG  = 'EFF6FF'; // light blue
    const INPUT_COLOR = '0000FF'; // blue — user-editable inputs
    const CALC_COLOR  = '000000'; // black — calculated values
    const FONT_NAME   = 'Arial';

    const curr = (val) => ({
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FFFFFFFF' },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Sheet 1: Summary
    // ─────────────────────────────────────────────────────────────────────────
    const summary = wb.addWorksheet('Budget Summary');
    summary.columns = [
      { width: 35 }, { width: 20 }, { width: 20 }, { width: 20 },
    ];

    const totalCurrentSpend  = rows.reduce((s, r) => s + (r.currentTotal  || 0), 0);
    const totalProjectedSpend = rows.reduce((s, r) => s + (r.projectedTotal || 0), 0);
    const totalDelta          = totalProjectedSpend - totalCurrentSpend;
    const avgUplift           = rows.length ? rows.reduce((s, r) => s + (r.upliftPct || 0), 0) / rows.length : 0;

    const addSummaryRow = (label, value, format, isCalc) => {
      const row = summary.addRow([label, value]);
      row.getCell(1).font = { name: FONT_NAME, bold: true, size: 11 };
      row.getCell(2).font = { name: FONT_NAME, size: 11, color: { argb: isCalc ? CALC_COLOR : INPUT_COLOR } };
      if (format) row.getCell(2).numFmt = format;
      return row;
    };

    // Title
    const titleRow = summary.addRow([`LapseIQ Budget Forecast — ${safeText(companyName) || 'Your Company'}`]);
    titleRow.getCell(1).font = { name: FONT_NAME, bold: true, size: 14, color: { argb: '1E40AF' } };
    summary.addRow([`Generated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`])
      .getCell(1).font = { name: FONT_NAME, size: 10, color: { argb: '64748B' } };
    summary.addRow([]);

    // Key metrics
    const metricsHeader = summary.addRow(['Annual Software Budget Summary']);
    metricsHeader.getCell(1).font = { name: FONT_NAME, bold: true, size: 12, color: { argb: '1E293B' } };
    summary.addRow([]);

    addSummaryRow('Current Annual Spend',       totalCurrentSpend,   '$#,##0', true);
    addSummaryRow('Projected Annual Spend',      totalProjectedSpend, '$#,##0', true);
    addSummaryRow('Total Budget Variance',       totalDelta,          '$#,##0', true);
    addSummaryRow('Avg. Uplift Applied',         avgUplift / 100,     '0.0%',   true);
    addSummaryRow('Contracts in Forecast',       rows.length,         '0',      true);
    summary.addRow([]);

    // By department breakdown
    const byDept: any = {};
    rows.forEach((r) => {
      const d = r.department || 'Unassigned';
      if (!byDept[d]) byDept[d] = { current: 0, projected: 0 };
      byDept[d].current    += r.currentTotal  || 0;
      byDept[d].projected  += r.projectedTotal || 0;
    });

    const deptHeader = summary.addRow(['Department', 'Current Spend', 'Projected Spend', 'Delta']);
    deptHeader.eachCell((cell) => {
      cell.font = { name: FONT_NAME, bold: true, color: { argb: HEADER_FG }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
      cell.alignment = { horizontal: 'center' };
    });

    Object.entries<any>(byDept)
      .sort((a, b) => b[1].projected - a[1].projected)
      .forEach(([dept, vals]) => {
        const row = summary.addRow([safeText(dept), vals.current, vals.projected, vals.projected - vals.current]);
        row.getCell(2).numFmt = '$#,##0';
        row.getCell(3).numFmt = '$#,##0';
        row.getCell(4).numFmt = '$#,##0;($#,##0);-';
        row.eachCell((cell) => {
          cell.font = { name: FONT_NAME, size: 10 };
          cell.border = { bottom: { style: 'thin', color: { argb: 'E2E8F0' } } };
        });
      });

    // ─────────────────────────────────────────────────────────────────────────
    // Sheet 2: Contract Detail
    // ─────────────────────────────────────────────────────────────────────────
    const detail = wb.addWorksheet('Contract Detail');

    const detailCols = [
      { header: 'Vendor',              key: 'vendor',       width: 22 },
      { header: 'Product',             key: 'product',      width: 30 },
      { header: 'Department',          key: 'dept',         width: 16 },
      { header: 'Renewal Date',        key: 'endDate',      width: 14 },
      { header: 'Current Qty',         key: 'currentQty',   width: 13 },
      { header: 'Needed Qty',          key: 'neededQty',    width: 13 },
      { header: 'Uplift %',            key: 'uplift',       width: 10 },
      { header: 'Current Unit Price',  key: 'unitPrice',    width: 18 },
      { header: 'Proj. Unit Price',    key: 'projUnit',     width: 18 },
      { header: 'Current Total',       key: 'currTotal',    width: 16 },
      { header: 'Projected Total',     key: 'projTotal',    width: 16 },
      { header: 'Delta',               key: 'delta',        width: 14 },
      { header: 'Owner',               key: 'owner',        width: 18 },
    ];
    detail.columns = detailCols;

    // Style header row
    const detailHeaderRow = detail.getRow(1);
    detailHeaderRow.height = 22;
    detailHeaderRow.eachCell((cell) => {
      cell.font = { name: FONT_NAME, bold: true, color: { argb: HEADER_FG }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: '2563EB' } } };
    });
    detail.views = [{ state: 'frozen', ySplit: 1 }];

    // Add note row explaining color coding
    const noteRow = detail.addRow(['Blue = user inputs (editable)   |   Black = calculated values']);
    noteRow.getCell(1).font = { name: FONT_NAME, italic: true, size: 9, color: { argb: '64748B' } };
    detail.mergeCells(`A2:M2`);

    // Data rows
    rows.forEach((r) => {
      const rowData = [
        safeText(r.vendorName),
        safeText(r.product),
        safeText(r.department),
        r.endDate ? new Date(r.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
        r.currentQty,
        r.neededQty,
        (r.upliftPct || 0) / 100,
        r.currentUnitPrice,
        r.projectedUnitPrice,
        r.currentTotal,
        r.projectedTotal,
        r.delta,
        safeText(r.internalOwner),
      ];

      const row = detail.addRow(rowData);
      row.height = 18;

      row.eachCell((cell, colNum) => {
        cell.font = { name: FONT_NAME, size: 10 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'E2E8F0' } } };
        cell.alignment = { vertical: 'middle' };
      });

      // Currency columns
      [8, 9, 10, 11, 12].forEach((col) => {
        const cell = row.getCell(col);
        cell.numFmt = '$#,##0.00;($#,##0.00);-';
        cell.font = { name: FONT_NAME, size: 10, color: { argb: CALC_COLOR } };
      });

      // Delta — red if positive (spending more)
      const deltaCell = row.getCell(12);
      if (r.delta > 0) {
        deltaCell.font = { name: FONT_NAME, size: 10, color: { argb: 'DC2626' } };
      }

      // Uplift % column
      row.getCell(7).numFmt = '0.0%';
      row.getCell(7).font = { name: FONT_NAME, size: 10, color: { argb: INPUT_COLOR } };

      // Needed qty — blue (user input)
      row.getCell(6).font = { name: FONT_NAME, size: 10, color: { argb: INPUT_COLOR } };
    });

    // Totals row
    const lastDataRow = detail.rowCount;
    const totalsRow = detail.addRow([
      'TOTAL', '', '', '', '', '', '',
      '', '',
      rows.reduce((s, r) => s + (r.currentTotal || 0), 0),
      rows.reduce((s, r) => s + (r.projectedTotal || 0), 0),
      totalDelta,
      '',
    ]);
    totalsRow.eachCell((cell, colNum) => {
      cell.font = { name: FONT_NAME, bold: true, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EFF6FF' } };
      cell.border = { top: { style: 'medium', color: { argb: '2563EB' } } };
    });
    [10, 11, 12].forEach((col) => {
      totalsRow.getCell(col).numFmt = '$#,##0.00;($#,##0.00);-';
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stream response
    // ─────────────────────────────────────────────────────────────────────────
    const filename = `LapseIQ_Budget_Forecast_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Budget export error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate export' });
  }
});

module.exports = router;

export {};
