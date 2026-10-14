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

module.exports = {
  renderTrace,
  renderRpcResult
};
