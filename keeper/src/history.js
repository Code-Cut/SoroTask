const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'executions.ndjson');

// ---------------------------------------------------------------------------
// Issue #842 — Real-Time Performance Analytics & Exportable PDF/CSV Audit Logs
//
// Generates monthly accounting reports detailing:
//   - Gas/fee expenditures per task execution
//   - Bounties earned per successful execution
//   - Net profit (bounties − fees)
//   - Daily XLM/USD exchange rate snapshots at time of execution
//   - Itemized transaction log with block explorer verification links
//
// Output formats:
//   - CSV  : machine-readable, importable into any accounting tool
//   - PDF  : human-readable monthly statement (pure-JS PDFKit, no native deps)
//
// The PDF renderer is implemented without requiring pdfkit or any native module.
// It produces a minimal but valid PDF/1.4 document using raw PDF syntax so the
// feature works in any Node.js environment without additional dependencies.
// To use a richer PDF library (e.g. pdfkit) the _renderPdfDocument() method can
// be swapped in place without changing the public generateAuditReport() API.
// ---------------------------------------------------------------------------

const STELLAR_EXPLORER_BASE = 'https://stellar.expert/explorer/public/tx';

/**
 * Format a number as USD string with two decimal places.
 * @param {number} usd
 * @returns {string}
 */
function _formatUsd(usd) {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format XLM amount with 7 decimal places (Stellar native precision).
 * @param {number} xlm
 * @returns {string}
 */
function _formatXlm(xlm) {
  return `${xlm.toFixed(7)} XLM`;
}

/**
 * Return an ISO YYYY-MM string for a given Date or ISO string.
 * @param {Date|string} ts
 * @returns {string}
 */
function _monthKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fetch current XLM/USD rate from a public API.
 * Falls back to 0 gracefully if the network is unavailable.
 *
 * In production this should be replaced with a rate stored at execution time
 * (see record() which now accepts an xlmUsdRate field).
 *
 * @returns {Promise<number>}
 */
async function _fetchXlmUsdRate() {
  try {
    // Use the built-in https module — no extra dependencies
    const https = require('https');
    return await new Promise((resolve) => {
      const req = https.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
        { timeout: 5000 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              resolve(json?.stellar?.usd ?? 0);
            } catch {
              resolve(0);
            }
          });
        },
      );
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
    });
  } catch {
    return 0;
  }
}

/**
 * Escape a CSV field — wraps in double quotes if it contains comma, quote, or
 * newline; internal double-quotes are doubled per RFC 4180.
 * @param {string|number} val
 * @returns {string}
 */
function _csvField(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render a minimal but valid PDF/1.4 document containing the audit report.
 * Uses raw PDF syntax — no native bindings or external modules required.
 *
 * @param {object} report - Output of _buildReportData()
 * @returns {Buffer} Raw PDF bytes
 */
function _renderPdfDocument(report) {
  const lines = [];
  const { month, summary, rows } = report;

  // PDF string helpers -------------------------------------------------------
  const pdfStr = (s) => `(${s.replace(/[\\()]/g, '\\$&')})`;
  const obj = (n, content) => { lines.push(`${n} 0 obj\n${content}\nendobj`); };

  // Build page content as a sequence of BT … ET text blocks
  const textLines = [];
  const TL = 14; // line height

  const text = (x, y, size, str) =>
    textLines.push(`BT /F1 ${size} Tf ${x} ${y} Td ${pdfStr(str)} Tj ET`);

  let y = 750;
  text(50, y, 16, `SoroTask Keeper — Monthly Audit Report`);
  y -= TL * 1.5;
  text(50, y, 12, `Period: ${month}`);
  y -= TL * 1.5;

  // Summary table
  const summaryFields = [
    [`Executions`, String(summary.totalExecutions)],
    [`Successful`, String(summary.successCount)],
    [`Failed`, String(summary.failureCount)],
    [`Total Fees Paid`, _formatXlm(summary.totalFeePaidXlm)],
    [`Total Bounty Earned`, _formatXlm(summary.totalBountyXlm)],
    [`Net Profit`, _formatXlm(summary.netProfitXlm)],
    [`Avg XLM/USD Rate`, _formatUsd(summary.avgXlmUsdRate)],
    [`Net Profit (USD)`, _formatUsd(summary.netProfitUsd)],
  ];

  text(50, y, 11, `Summary`);
  y -= TL;
  for (const [label, value] of summaryFields) {
    text(60, y, 9, `${label}: ${value}`);
    y -= TL - 2;
  }
  y -= TL;

  // Transaction rows (up to 30 per page for simplicity)
  text(50, y, 11, `Transaction Log (recent ${Math.min(rows.length, 30)} entries)`);
  y -= TL;

  const header = `Date       | Task   | Status  | Fee (XLM)   | Bounty (XLM)| TX Hash`;
  text(50, y, 7, header);
  y -= TL - 3;

  const displayRows = rows.slice(0, 30);
  for (const row of displayRows) {
    if (y < 60) break; // rudimentary page overflow guard
    const date = row.timestamp.slice(0, 10);
    const fee = row.feePaidXlm.toFixed(5).padStart(10);
    const bounty = row.bountyXlm.toFixed(5).padStart(10);
    const hash = row.txHash ? row.txHash.slice(0, 12) + '…' : 'N/A';
    const line = `${date} | ${String(row.taskId).padEnd(6)} | ${row.status.padEnd(7)} | ${fee} | ${bounty} | ${hash}`;
    text(50, y, 6, line);
    y -= TL - 5;
  }

  // ---- Assemble raw PDF objects -------------------------------------------
  const parts = [];
  let xref = [];

  const writeObj = (n, s) => {
    xref[n] = parts.reduce((acc, p) => acc + p.length, 0);
    parts.push(Buffer.from(`${n} 0 obj\n${s}\nendobj\n`));
  };

  const contentStream = textLines.join('\n');
  const streamBytes = Buffer.from(contentStream);

  writeObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  writeObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  writeObj(3, [
    `<< /Type /Page /Parent 2 0 R`,
    `/MediaBox [0 0 612 792]`,
    `/Contents 4 0 R`,
    `/Resources << /Font << /F1 5 0 R >> >> >>`,
  ].join('\n'));
  writeObj(4, `<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream`);
  writeObj(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const xrefOffset = parts.reduce((acc, p) => acc + p.length, 0);

  const header2 = Buffer.from('%PDF-1.4\n');
  const body = Buffer.concat(parts);

  const xrefSection = [
    'xref',
    `0 ${xref.length + 1}`,
    '0000000000 65535 f ',
    ...xref.map((off) => `${String(off + header2.length).padStart(10, '0')} 00000 n `),
    '',
    'trailer',
    `<< /Size ${xref.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset + header2.length),
    '%%EOF',
  ].join('\n');

  return Buffer.concat([header2, body, Buffer.from(xrefSection)]);
}

class HistoryManager {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('history');
    this._ensureDataDir();
    this.maxDriftRecordsPerTask = options.maxDriftRecordsPerTask || 20;
    this.maxRecentExecutions = options.maxRecentExecutions || 200;
    this.recentDriftByTask = new Map();
    this.recentExecutions = [];
    this.writeQueue = Promise.resolve();
  }

  /**
   * Record an execution attempt.
   * This is non-blocking (uses appendFile without awaiting).
   * 
   * @param {Object} record - The execution record to persist
   * @param {string} record.taskId - Task ID
   * @param {string} record.keeper - Keeper public key
   * @param {string} record.status - SUCCESS, FAILED, or ERROR
   * @param {string} [record.txHash] - Transaction hash
   * @param {number} [record.feePaid] - Fee paid in XLM (optional)
   * @param {string} [record.error] - Error message (optional)
   * @param {string} [record.classification] - Error classification (optional)
   */
  record(record) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...record,
    };

    this.recentExecutions.push(entry);
    if (this.recentExecutions.length > this.maxRecentExecutions) {
      this.recentExecutions.shift();
    }

    const line = JSON.stringify(entry) + '\n';

    this.writeQueue = this.writeQueue
      .then(() => fs.promises.appendFile(HISTORY_FILE, line))
      .catch((err) => {
        this.logger.error('Failed to persist execution history', {
          taskId: record.taskId,
          error: err.message,
        });
      });
  }

  recordDrift(record) {
    const taskId = Number(record.taskId);
    const entry = {
      timestamp: new Date().toISOString(),
      taskId,
      expectedRunAt: record.expectedRunAt,
      observedAt: record.observedAt,
      driftSeconds: record.driftSeconds,
      severity: record.severity,
      shardLabel: record.shardLabel || null,
    };

    const existing = this.recentDriftByTask.get(taskId) || [];
    existing.push(entry);
    while (existing.length > this.maxDriftRecordsPerTask) {
      existing.shift();
    }
    this.recentDriftByTask.set(taskId, existing);

    this.record({
      kind: 'schedule_drift',
      ...entry,
    });

    return entry;
  }

  getRecentDrift(taskId, limit = 5) {
    const entries = this.recentDriftByTask.get(Number(taskId)) || [];
    return entries.slice(-limit).reverse();
  }

  getDriftSnapshot(limit = 20) {
    return Array.from(this.recentDriftByTask.entries())
      .map(([taskId, entries]) => ({
        taskId,
        latest: entries[entries.length - 1],
        samples: entries.length,
      }))
      .sort((left, right) => {
        const leftDrift = left.latest?.driftSeconds || 0;
        const rightDrift = right.latest?.driftSeconds || 0;
        return rightDrift - leftDrift;
      })
      .slice(0, limit);
  }

  getRecentExecutions(limit = 50) {
    return this.recentExecutions.slice(-limit).reverse();
  }

  getExecutionSummary(taskId = null) {
    const records = this.recentExecutions.filter((entry) => {
      if (taskId == null) {
        return true;
      }
      return String(entry.taskId) === String(taskId);
    });

    const successCount = records.filter((entry) => entry.status === 'SUCCESS').length;
    const failureCount = records.filter((entry) => entry.status === 'FAILED' || entry.status === 'ERROR').length;
    const totalFeePaid = records.reduce((sum, entry) => sum + (Number(entry.feePaid) || 0), 0);
    const sampleCount = records.length;
    const failureRate = sampleCount > 0 ? failureCount / sampleCount : 0;
    const successRate = sampleCount > 0 ? successCount / sampleCount : 0;
    const averageFeePaid = sampleCount > 0 ? totalFeePaid / sampleCount : 0;

    // Issue #784 — execution speed and gas efficiency, for keeper reputation
    // scoring. Only records that actually carry a duration/bounty (added
    // alongside this feature; older persisted history predates it) count
    // toward each average, so historical data doesn't silently zero these out.
    const durationSamples = records
      .map((entry) => Number(entry.durationMs))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const averageDurationMs = durationSamples.length > 0
      ? durationSamples.reduce((sum, value) => sum + value, 0) / durationSamples.length
      : null;

    const efficiencySamples = records
      .filter((entry) => Number(entry.bounty) > 0 && entry.status === 'SUCCESS')
      .map((entry) => {
        const ratio = (Number(entry.feePaid) || 0) / Number(entry.bounty);
        return Math.max(0, Math.min(1, 1 - ratio));
      });
    const averageGasEfficiency = efficiencySamples.length > 0
      ? efficiencySamples.reduce((sum, value) => sum + value, 0) / efficiencySamples.length
      : null;

    return {
      taskId: taskId == null ? null : String(taskId),
      sampleCount,
      successCount,
      failureCount,
      successRate,
      failureRate,
      averageFeePaid,
      averageDurationMs,
      averageGasEfficiency,
      recentExecutions: records.slice(-10).reverse(),
    };
  }

  /**
   * Get recent history (for simple debugging/audit)
   * @param {number} limit - Number of recent records to return
   * @returns {Promise<Object[]>}
   */
  async getRecent(limit = 100) {
    try {
      await this.writeQueue;
      if (!fs.existsSync(HISTORY_FILE)) return [];

      const content = await fs.promises.readFile(HISTORY_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      return lines
        .slice(-limit)
        .reverse()
        .map(line => JSON.parse(line));
    } catch (err) {
      this.logger.error('Failed to read execution history', { error: err.message });
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Issue #842 — Audit reporting: CSV + PDF monthly statements
  // -------------------------------------------------------------------------

  /**
   * Build a structured report data object for the given month.
   *
   * @param {object} [options]
   * @param {string} [options.month] - YYYY-MM string, defaults to current month
   * @param {number} [options.xlmUsdRate] - Override XLM/USD rate (useful in tests)
   * @returns {Promise<object>} Report data with summary and itemized rows
   */
  async _buildReportData(options = {}) {
    const targetMonth = options.month ?? _monthKey(new Date());

    // Load all history from disk to cover the full month
    const allRecords = await this.getRecent(100000);

    // Filter to the requested month; skip drift/non-execution records
    const execRecords = allRecords.filter((r) => {
      if (r.kind === 'schedule_drift') return false;
      const m = _monthKey(r.timestamp);
      return m === targetMonth;
    });

    // Determine exchange rate: use provided override, otherwise attempt live fetch
    const xlmUsdRate =
      options.xlmUsdRate != null
        ? options.xlmUsdRate
        : (await _fetchXlmUsdRate());

    // Build itemized rows
    const rows = execRecords.map((r) => {
      const feePaidXlm = Number(r.feePaid) || 0;
      const bountyXlm = Number(r.bounty) || 0;
      // Use per-record rate if stored, else fall back to the report-level rate
      const rate = Number(r.xlmUsdRate) || xlmUsdRate;
      return {
        timestamp: r.timestamp,
        taskId: r.taskId ?? 'unknown',
        keeper: r.keeper ?? 'unknown',
        status: r.status ?? 'UNKNOWN',
        txHash: r.txHash ?? null,
        explorerUrl: r.txHash ? `${STELLAR_EXPLORER_BASE}/${r.txHash}` : null,
        feePaidXlm,
        bountyXlm,
        netXlm: bountyXlm - feePaidXlm,
        xlmUsdRate: rate,
        feePaidUsd: feePaidXlm * rate,
        bountyUsd: bountyXlm * rate,
        netUsd: (bountyXlm - feePaidXlm) * rate,
      };
    });

    // Aggregate summary
    const totalFeePaidXlm = rows.reduce((s, r) => s + r.feePaidXlm, 0);
    const totalBountyXlm = rows.reduce((s, r) => s + r.bountyXlm, 0);
    const netProfitXlm = totalBountyXlm - totalFeePaidXlm;
    const successCount = rows.filter((r) => r.status === 'SUCCESS').length;
    const failureCount = rows.filter((r) => r.status === 'FAILED' || r.status === 'ERROR').length;

    // Rolling average XLM/USD rate from per-record rates
    const ratesWithData = rows.filter((r) => r.xlmUsdRate > 0);
    const avgXlmUsdRate =
      ratesWithData.length > 0
        ? ratesWithData.reduce((s, r) => s + r.xlmUsdRate, 0) / ratesWithData.length
        : xlmUsdRate;

    return {
      month: targetMonth,
      generatedAt: new Date().toISOString(),
      summary: {
        totalExecutions: rows.length,
        successCount,
        failureCount,
        totalFeePaidXlm,
        totalBountyXlm,
        netProfitXlm,
        avgXlmUsdRate,
        totalFeePaidUsd: totalFeePaidXlm * avgXlmUsdRate,
        totalBountyUsd: totalBountyXlm * avgXlmUsdRate,
        netProfitUsd: netProfitXlm * avgXlmUsdRate,
      },
      rows,
    };
  }

  /**
   * Generate a monthly audit report as a structured data object.
   *
   * @param {object} [options]
   * @param {string} [options.month] - YYYY-MM, defaults to current month
   * @param {number} [options.xlmUsdRate] - Override XLM/USD rate
   * @returns {Promise<object>}
   */
  async generateAuditReport(options = {}) {
    return this._buildReportData(options);
  }

  /**
   * Export a monthly audit report as a CSV string (RFC 4180).
   *
   * Columns:
   *   Timestamp, TaskId, Keeper, Status, FeePaid_XLM, Bounty_XLM, Net_XLM,
   *   XLM_USD_Rate, FeePaid_USD, Bounty_USD, Net_USD, TxHash, ExplorerURL
   *
   * @param {object} [options]
   * @param {string} [options.month] - YYYY-MM, defaults to current month
   * @param {number} [options.xlmUsdRate] - Override XLM/USD rate
   * @returns {Promise<string>} CSV text
   */
  async exportAuditCsv(options = {}) {
    const report = await this._buildReportData(options);
    const { month, generatedAt, summary, rows } = report;

    const csvLines = [];

    // Report header comment rows
    csvLines.push(`# SoroTask Keeper Monthly Audit Report`);
    csvLines.push(`# Period: ${month}`);
    csvLines.push(`# Generated: ${generatedAt}`);
    csvLines.push(`# Executions: ${summary.totalExecutions}  Successful: ${summary.successCount}  Failed: ${summary.failureCount}`);
    csvLines.push(`# Total Fees: ${_formatXlm(summary.totalFeePaidXlm)}  Total Bounty: ${_formatXlm(summary.totalBountyXlm)}  Net Profit: ${_formatXlm(summary.netProfitXlm)}`);
    csvLines.push(`# Avg XLM/USD: ${_formatUsd(summary.avgXlmUsdRate)}  Net Profit (USD): ${_formatUsd(summary.netProfitUsd)}`);
    csvLines.push('');

    // Column headers
    csvLines.push([
      'Timestamp', 'TaskId', 'Keeper', 'Status',
      'FeePaid_XLM', 'Bounty_XLM', 'Net_XLM',
      'XLM_USD_Rate', 'FeePaid_USD', 'Bounty_USD', 'Net_USD',
      'TxHash', 'ExplorerURL',
    ].map(_csvField).join(','));

    // Data rows
    for (const row of rows) {
      csvLines.push([
        row.timestamp,
        row.taskId,
        row.keeper,
        row.status,
        row.feePaidXlm.toFixed(7),
        row.bountyXlm.toFixed(7),
        row.netXlm.toFixed(7),
        row.xlmUsdRate.toFixed(6),
        row.feePaidUsd.toFixed(4),
        row.bountyUsd.toFixed(4),
        row.netUsd.toFixed(4),
        row.txHash ?? '',
        row.explorerUrl ?? '',
      ].map(_csvField).join(','));
    }

    return csvLines.join('\n');
  }

  /**
   * Export a monthly audit report as a PDF Buffer.
   *
   * Generates a minimal valid PDF/1.4 document without any native dependencies.
   * Contains a summary table and up to 30 itemized transaction rows.
   *
   * @param {object} [options]
   * @param {string} [options.month] - YYYY-MM, defaults to current month
   * @param {number} [options.xlmUsdRate] - Override XLM/USD rate
   * @returns {Promise<Buffer>} Raw PDF bytes ready to write to disk or stream
   */
  async exportAuditPdf(options = {}) {
    const report = await this._buildReportData(options);
    return _renderPdfDocument(report);
  }

  /**
   * Issue #1473: Record keeper execution fee claims
   * @param {Object} claim
   * @param {string} claim.keeper - Keeper public key/address
   * @param {string} claim.taskId - Associated task ID
   * @param {number} [claim.feePaid] - Fee paid in XLM
   * @param {number} [claim.bounty] - Bounty earned in XLM
   * @param {string} [claim.txHash] - Execution transaction hash
   * @returns {Object} fee claim record
   */
  recordFeeClaim(claim) {
    const to7Decimals = (n) => Number(Number(n || 0).toFixed(7));
    const crypto = require('crypto');
    const claimRecord = {
      claimId: claim.claimId || `CLAIM-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      keeper: claim.keeper,
      taskId: String(claim.taskId),
      feePaidXlm: to7Decimals(claim.feePaid ?? claim.executionFee ?? 0),
      bountyXlm: to7Decimals(claim.bounty ?? claim.bountyXlm ?? 0),
      txHash: claim.txHash || null,
      status: 'CLAIMED',
      settled: false,
    };

    if (!this.feeClaims) {
      this.feeClaims = [];
    }
    this.feeClaims.push(claimRecord);

    this.record({
      kind: 'fee_claim',
      ...claimRecord,
    });

    return claimRecord;
  }

  /**
   * Issue #1473: Calculate protocol cut and net keeper payout with multi-currency tax withholding
   * Accurately executes to 7 decimal places.
   *
   * @param {Array<Object>|Object} claims - Array of fee claims or executions
   * @param {Object} [options]
   * @param {number} [options.protocolCutRate=0.10] - Protocol revenue cut (e.g. 10%)
   * @param {number} [options.taxWithholdingRate=0.20] - Tax withholding rate (e.g. 20%)
   * @param {Object} [options.currencyRates] - Rates mapping { USD: 0.12, EUR: 0.11, GBP: 0.095 }
   * @returns {Object} Net payout summary
   */
  calculateKeeperPayout(claims, options = {}) {
    const claimList = Array.isArray(claims) ? claims : [claims];
    const to7Decimals = (n) => Number(Number(n || 0).toFixed(7));
    const protocolCutRate = options.protocolCutRate !== undefined ? options.protocolCutRate : 0.10;
    const taxWithholdingRate = options.taxWithholdingRate !== undefined ? options.taxWithholdingRate : 0.20;
    const currencyRates = options.currencyRates || { USD: 0.12, EUR: 0.11, GBP: 0.095 };

    let totalGrossBountyXlm = 0;
    let totalFeeReimbursementXlm = 0;
    let totalProtocolCutXlm = 0;
    let totalTaxableGrossXlm = 0;
    let totalTaxWithheldXlm = 0;
    let totalNetPayoutXlm = 0;

    const itemized = claimList.map((claim) => {
      const grossBounty = to7Decimals(claim.bounty ?? claim.bountyXlm ?? 0);
      const feeReimbursement = to7Decimals(claim.feePaid ?? claim.feePaidXlm ?? 0);
      const protocolCut = to7Decimals(grossBounty * protocolCutRate);
      const taxableGross = to7Decimals(Math.max(0, grossBounty - protocolCut));
      const taxWithheld = to7Decimals(taxableGross * taxWithholdingRate);
      const netPayout = to7Decimals(taxableGross - taxWithheld + feeReimbursement);

      totalGrossBountyXlm = to7Decimals(totalGrossBountyXlm + grossBounty);
      totalFeeReimbursementXlm = to7Decimals(totalFeeReimbursementXlm + feeReimbursement);
      totalProtocolCutXlm = to7Decimals(totalProtocolCutXlm + protocolCut);
      totalTaxableGrossXlm = to7Decimals(totalTaxableGrossXlm + taxableGross);
      totalTaxWithheldXlm = to7Decimals(totalTaxWithheldXlm + taxWithheld);
      totalNetPayoutXlm = to7Decimals(totalNetPayoutXlm + netPayout);

      const multiCurrencyWithholdings = {};
      const multiCurrencyNet = {};
      for (const [curr, rate] of Object.entries(currencyRates)) {
        multiCurrencyWithholdings[curr] = Number((taxWithheld * rate).toFixed(4));
        multiCurrencyNet[curr] = Number((netPayout * rate).toFixed(4));
      }

      return {
        claimId: claim.claimId,
        taskId: claim.taskId,
        keeper: claim.keeper,
        grossBountyXlm: grossBounty,
        feeReimbursementXlm: feeReimbursement,
        protocolCutXlm: protocolCut,
        taxableGrossXlm: taxableGross,
        taxWithheldXlm: taxWithheld,
        netPayoutXlm: netPayout,
        multiCurrency: {
          withholdings: multiCurrencyWithholdings,
          net: multiCurrencyNet,
        },
      };
    });

    const multiCurrencySummary = {};
    for (const [curr, rate] of Object.entries(currencyRates)) {
      multiCurrencySummary[curr] = {
        rate,
        taxWithheld: Number((totalTaxWithheldXlm * rate).toFixed(4)),
        netPayout: Number((totalNetPayoutXlm * rate).toFixed(4)),
        protocolRevenue: Number((totalProtocolCutXlm * rate).toFixed(4)),
      };
    }

    return {
      claimCount: claimList.length,
      protocolCutRate,
      taxWithholdingRate,
      totalGrossBountyXlm,
      totalFeeReimbursementXlm,
      totalProtocolCutXlm,
      totalTaxableGrossXlm,
      totalTaxWithheldXlm,
      totalNetPayoutXlm,
      multiCurrency: multiCurrencySummary,
      itemized,
    };
  }

  /**
   * Issue #1473: Generates an automated periodic settlement batch with cryptographic tax lot receipts
   * and GAAP-compliant dual-entry journal records.
   */
  async generateSettlementBatch(options = {}) {
    const crypto = require('crypto');
    const { signProofOfPaymentReceipt } = require('./account');
    const to7Decimals = (n) => Number(Number(n || 0).toFixed(7));

    let candidateClaims = options.claims;
    if (!candidateClaims || candidateClaims.length === 0) {
      if (this.feeClaims && this.feeClaims.length > 0) {
        candidateClaims = this.feeClaims.filter((c) => !c.settled);
      } else {
        candidateClaims = this.recentExecutions
          .filter((e) => e.status === 'SUCCESS' && (Number(e.bounty) > 0 || Number(e.feePaid) > 0))
          .map((e) => ({
            claimId: `CLAIM-${e.taskId}-${crypto.randomBytes(3).toString('hex')}`,
            keeper: e.keeper || options.defaultKeeper || 'G_DEFAULT_KEEPER',
            taskId: e.taskId,
            bounty: e.bounty || 10,
            feePaid: e.feePaid || 0.001,
            txHash: e.txHash,
          }));
      }
    }

    const claimsByKeeper = new Map();
    for (const c of candidateClaims) {
      const keeper = c.keeper || 'G_DEFAULT_KEEPER';
      if (!claimsByKeeper.has(keeper)) {
        claimsByKeeper.set(keeper, []);
      }
      claimsByKeeper.get(keeper).push(c);
    }

    const batchId = `BATCH-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    const period = options.period || `${new Date().getUTCFullYear()}-W${Math.ceil(new Date().getUTCDate() / 7)}`;
    const settlements = [];
    const taxLots = [];

    for (const [keeper, claims] of claimsByKeeper.entries()) {
      const payoutCalc = this.calculateKeeperPayout(claims, options);
      const taxLotId = `LOT-${period}-${crypto.randomBytes(3).toString('hex')}`;
      const settlementId = `SETTLE-${batchId}-${keeper.slice(0, 6)}`;

      const taxLot = {
        taxLotId,
        settlementId,
        keeperAddress: keeper,
        claimsCount: claims.length,
        grossBountyXlm: payoutCalc.totalGrossBountyXlm,
        feeReimbursementXlm: payoutCalc.totalFeeReimbursementXlm,
        protocolCutXlm: payoutCalc.totalProtocolCutXlm,
        taxWithheldXlm: payoutCalc.totalTaxWithheldXlm,
        netPayoutXlm: payoutCalc.totalNetPayoutXlm,
        multiCurrency: payoutCalc.multiCurrency,
        createdAt: new Date().toISOString(),
      };

      const receipt = signProofOfPaymentReceipt(taxLot, options.signerKeypair || options.keypair);
      taxLot.receipt = receipt;

      taxLots.push(taxLot);
      settlements.push({
        settlementId,
        taxLotId,
        keeperAddress: keeper,
        grossBountyXlm: taxLot.grossBountyXlm,
        feeReimbursementXlm: taxLot.feeReimbursementXlm,
        protocolCutXlm: taxLot.protocolCutXlm,
        taxWithheldXlm: taxLot.taxWithheldXlm,
        netPayoutXlm: taxLot.netPayoutXlm,
        multiCurrency: taxLot.multiCurrency,
        receipt,
      });
    }

    const totalGrossExpense = to7Decimals(taxLots.reduce((s, t) => s + t.grossBountyXlm + t.feeReimbursementXlm, 0));
    const totalProtocolRevenue = to7Decimals(taxLots.reduce((s, t) => s + t.protocolCutXlm, 0));
    const totalTaxWithholdingLiability = to7Decimals(taxLots.reduce((s, t) => s + t.taxWithheldXlm, 0));
    const totalNetPayoutLiability = to7Decimals(taxLots.reduce((s, t) => s + t.netPayoutXlm, 0));

    const avgRate = options.currencyRates?.USD || 0.12;

    const journalEntries = [
      {
        entryId: `JE-${batchId}-1`,
        date: new Date().toISOString().slice(0, 10),
        accountCode: '50100',
        accountTitle: 'Keeper Execution & Compensation Expense',
        debitXlm: totalGrossExpense,
        creditXlm: 0,
        debitUsd: Number((totalGrossExpense * avgRate).toFixed(4)),
        creditUsd: 0,
        description: `Gross keeper earnings and gas reimbursements for period ${period}`,
      },
      {
        entryId: `JE-${batchId}-2`,
        date: new Date().toISOString().slice(0, 10),
        accountCode: '40100',
        accountTitle: 'Protocol Execution Fee Revenue',
        debitXlm: 0,
        creditXlm: totalProtocolRevenue,
        debitUsd: 0,
        creditUsd: Number((totalProtocolRevenue * avgRate).toFixed(4)),
        description: `Protocol cut retained from execution earnings`,
      },
      {
        entryId: `JE-${batchId}-3`,
        date: new Date().toISOString().slice(0, 10),
        accountCode: '20200',
        accountTitle: 'Tax Withholding Liability Payable',
        debitXlm: 0,
        creditXlm: totalTaxWithholdingLiability,
        debitUsd: 0,
        creditUsd: Number((totalTaxWithholdingLiability * avgRate).toFixed(4)),
        description: `Multi-currency statutory tax withholding on taxable keeper lots`,
      },
      {
        entryId: `JE-${batchId}-4`,
        date: new Date().toISOString().slice(0, 10),
        accountCode: '20100',
        accountTitle: 'Keeper Settlements Payable',
        debitXlm: 0,
        creditXlm: totalNetPayoutLiability,
        debitUsd: 0,
        creditUsd: Number((totalNetPayoutLiability * avgRate).toFixed(4)),
        description: `Net payable to node operator wallets for period ${period}`,
      },
    ];

    const totalDebits = totalGrossExpense;
    const totalCredits = to7Decimals(totalProtocolRevenue + totalTaxWithholdingLiability + totalNetPayoutLiability);
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.0000001;

    return {
      batchId,
      period,
      generatedAt: new Date().toISOString(),
      settlements,
      taxLots,
      gaapSummary: {
        totalGrossExpense,
        totalProtocolRevenue,
        totalTaxWithholdingLiability,
        totalNetPayoutLiability,
        totalDebits,
        totalCredits,
        isBalanced,
      },
      journalEntries,
    };
  }

  /**
   * Issue #1473: Export automated GAAP-compliant accounting CSV
   */
  exportSettlementAccountingCsv(settlementBatch) {
    const csvLines = [];
    const { batchId, period, generatedAt, gaapSummary, journalEntries, taxLots } = settlementBatch;

    csvLines.push(`# SoroTask Keeper Settlement Accounting Report (GAAP Standard)`);
    csvLines.push(`# Batch ID: ${batchId}`);
    csvLines.push(`# Settlement Period: ${period}`);
    csvLines.push(`# Generated At: ${generatedAt}`);
    csvLines.push(`# GAAP Balance Verified: ${gaapSummary.isBalanced ? 'YES (Debits == Credits)' : 'NO'}`);
    csvLines.push(`# Total Debits: ${gaapSummary.totalDebits.toFixed(7)} XLM | Total Credits: ${gaapSummary.totalCredits.toFixed(7)} XLM`);
    csvLines.push('');

    csvLines.push(`# SECTION 1: GENERAL JOURNAL (DUAL-ENTRY ACCRUAL RECORD)`);
    csvLines.push([
      'EntryId', 'Date', 'AccountCode', 'AccountTitle',
      'Debit_XLM', 'Credit_XLM', 'Debit_USD', 'Credit_USD', 'Description'
    ].map(_csvField).join(','));

    for (const je of journalEntries) {
      csvLines.push([
        je.entryId,
        je.date,
        je.accountCode,
        je.accountTitle,
        je.debitXlm.toFixed(7),
        je.creditXlm.toFixed(7),
        je.debitUsd.toFixed(4),
        je.creditUsd.toFixed(4),
        je.description,
      ].map(_csvField).join(','));
    }

    csvLines.push('');
    csvLines.push(`# SECTION 2: ITEMIZED KEEPER TAX LOT RECEIPTS`);
    csvLines.push([
      'TaxLotId', 'SettlementId', 'KeeperAddress',
      'GrossBounty_XLM', 'FeeReimbursement_XLM', 'ProtocolCut_XLM',
      'TaxWithheld_XLM', 'NetPayout_XLM', 'TaxWithheld_USD', 'NetPayout_USD',
      'Digest', 'ReceiptSignature', 'SignerPublicKey'
    ].map(_csvField).join(','));

    for (const lot of taxLots) {
      csvLines.push([
        lot.taxLotId,
        lot.settlementId,
        lot.keeperAddress,
        lot.grossBountyXlm.toFixed(7),
        lot.feeReimbursementXlm.toFixed(7),
        lot.protocolCutXlm.toFixed(7),
        lot.taxWithheldXlm.toFixed(7),
        lot.netPayoutXlm.toFixed(7),
        (lot.multiCurrency?.USD?.taxWithheld ?? 0).toFixed(4),
        (lot.multiCurrency?.USD?.netPayout ?? 0).toFixed(4),
        lot.receipt?.digest ?? '',
        lot.receipt?.receiptSignature ?? '',
        lot.receipt?.signerPublicKey ?? '',
      ].map(_csvField).join(','));
    }

    return csvLines.join('\n');
  }

  /**
   * Issue #1473: Automated periodic settlement daemon pipeline.
   * Computes net earnings, signs proof-of-payment receipts, broadcasts transfers,
   * and saves GAAP accounting exports.
   */
  async runPeriodicSettlementPipeline(options = {}) {
    const { executePayoutSettlement } = require('./account');
    const batch = await this.generateSettlementBatch(options);

    const payoutExec = await executePayoutSettlement({
      keypair: options.keypair,
      settlements: batch.settlements,
      networkPassphrase: options.networkPassphrase,
      server: options.server,
      dryRun: options.dryRun || false,
    });

    const csvContent = this.exportSettlementAccountingCsv(batch);
    const exportPath = path.join(DATA_DIR, `settlement-${batch.batchId}.csv`);
    try {
      await fs.promises.writeFile(exportPath, csvContent, 'utf8');
    } catch (_err) {
      // ignore
    }

    this.record({
      kind: 'settlement_pipeline_run',
      batchId: batch.batchId,
      period: batch.period,
      count: payoutExec.count,
      totalDisbursedXlm: payoutExec.totalDisbursedXlm,
      exportPath,
    });

    return {
      batch,
      payoutExec,
      csvContent,
      exportPath,
    };
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }
}

module.exports = HistoryManager;
