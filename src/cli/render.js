// src/cli/render.js: Render distributed RPC traces and tables (no explanatory prose)

function renderTrace(trace = [], requestId = '') {
  if (!Array.isArray(trace) || trace.length === 0) return '';
  const lines = [];

  for (const span of trace) {
    const node = span.node || 'unknown';
    const event = span.event || '';
    const lamport = span.lamport !== undefined ? `L=${span.lamport}` : '';
    const dt = span.dtMs !== undefined ? `${span.dtMs.toFixed(1)} ms` : '';

    lines.push(`[${node.padEnd(12)}] ${event.padEnd(35)} ${lamport.padEnd(8)} ${dt}`);
  }

  return lines.join('\n');
}

function renderRpcResult(result, durationMs) {
  const lines = [];
  if (result.txnId) {
    lines.push(`txn        ${result.txnId.slice(0, 8)}   ${result.status || ''}`);
  }
  if (result.accountId) {
    lines.push(`account    ${result.accountId}   balance: ${result.balance || ''}`);
  }
  if (result.fromBalance && result.toBalance) {
    lines.push(`fromBal    ${result.fromBalance}   toBal: ${result.toBalance}`);
  }
  if (result.lsn) {
    lines.push(`lsn        ${result.lsn}   epoch ${result.epoch || ''}   durability ${result.durability || 'LOCAL'}`);
  }
  if (result.duplicate) {
    lines.push(`duplicate  true (stored result replayed)`);
  }
  if (durationMs !== undefined) {
    lines.push(`round trip ${durationMs.toFixed(1)} ms`);
  }
  return lines.join('\n');
}

function renderClocksTable(clocksList = []) {
  const lines = [
    'node   offsetMs   physical (app clock)        lamport'
  ];

  for (const c of clocksList) {
    const rawNode = String(c.nodeId || c.node);
    const node = (rawNode === 'coordinator' ? 'coord' : rawNode).padEnd(6);
    let offsetStr;
    if (typeof c.offsetMs === 'number') {
      const sign = c.offsetMs >= 0 ? '+' : '';
      offsetStr = `${sign}${Math.round(c.offsetMs)}`;
    } else {
      offsetStr = String(c.offsetMs);
    }
    const offset = offsetStr.padStart(6);
    const iso = String(c.iso || new Date(c.physicalTs).toISOString()).padEnd(27);
    const lamport = String(c.lamport || 0);

    lines.push(`${node} ${offset}     ${iso} ${lamport}`);
  }

  return lines.join('\n');
}

function renderBerkeleySync(report) {
  const lines = [
    'node   rtt     estOffset   injected   error   adjustment'
  ];

  for (const p of report.participants || []) {
    const rawNode = String(p.nodeId);
    const node = (rawNode === 'coordinator' ? 'coord' : rawNode).padEnd(6);
    const rtt = p.nodeId === report.master ? '-      ' : `${Number(p.rttMs).toFixed(1)} ms`.padEnd(7);
    const estSign = p.estimatedOffsetMs >= 0 ? '+' : '';
    const est = `${estSign}${Math.round(p.estimatedOffsetMs)}`.padStart(8);
    const injSign = p.injectedOffsetMs >= 0 ? '+' : '';
    const inj = `${injSign}${Math.round(p.injectedOffsetMs)}`.padStart(8);
    const errSign = p.errorMs >= 0 ? '+' : '';
    const err = `${errSign}${Math.round(p.errorMs)}`.padStart(6);
    const adjSign = p.adjustmentMs >= 0 ? '+' : '';
    const adj = `${adjSign}${Number(p.adjustmentMs).toFixed(1)}`.padStart(11);

    lines.push(`${node} ${rtt} ${est}   ${inj}   ${err}   ${adj}`);
  }

  lines.push(`average offset ${Number(report.averageOffsetMs).toFixed(1)} ms`);
  lines.push(`after sync   max spread ${Math.round(report.postSyncSpreadMs)} ms`);

  return lines.join('\n');
}

function renderEventOrdering(orderingReport, title = '') {
  const lines = [];
  if (title) {
    lines.push(`CLOCKS > Compare Event Ordering   ${title}`);
  }
  lines.push('event                  node  physical-rank  lamport  lamport-rank');

  for (const r of orderingReport.rows || []) {
    const ev = String(r.event).padEnd(22);
    const node = String(r.node).padEnd(5);
    const pRank = String(r.physicalRank).padEnd(14);
    const lamport = String(r.lamport).padEnd(8);
    const lRank = String(r.lamportRank);

    lines.push(`${ev} ${node} ${pRank} ${lamport} ${lRank}`);
  }

  if (orderingReport.physicalViolations > 0) {
    const vMsg = orderingReport.violationDetails && orderingReport.violationDetails[0]
      ? orderingReport.violationDetails[0].message
      : 'inversion detected';
    lines.push(`physical order: ${orderingReport.physicalViolations} causal violation(s) (${vMsg})`);
  } else {
    lines.push(`physical order: 0 causal violations`);
  }

  lines.push(`lamport order: ${orderingReport.lamportViolations} causal violations`);

  return lines.join('\n');
}

module.exports = {
  renderTrace,
  renderRpcResult,
  renderClocksTable,
  renderBerkeleySync,
  renderEventOrdering
};
