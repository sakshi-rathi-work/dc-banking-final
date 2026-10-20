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

function renderReplicationStatus(statusList = [], accountId = 'ACC-0001') {
  const lines = [
    `node  role     applied  lag  pending  lastAck   ${accountId.padEnd(11)} checksum`
  ];

  let leaderLastLsn = 0;
  for (const s of statusList) {
    if (s.role === 'primary') {
      leaderLastLsn = s.appliedLsn || 0;
    }
  }

  const acksList = [];
  for (const s of statusList) {
    const node = String(s.nodeId || '').padEnd(5);
    const role = String(s.role || '').padEnd(8);
    const applied = String(s.appliedLsn ?? '-').padEnd(8);
    const lagVal = s.role === 'primary' ? 0 : Math.max(0, leaderLastLsn - (s.appliedLsn || 0));
    const lag = String(lagVal).padEnd(4);
    const pending = String(lagVal).padEnd(8);
    const lastAck = s.role === 'primary' ? '-        ' : (s.lastAckMs !== undefined && s.lastAckMs !== null ? `${s.lastAckMs} ms`.padEnd(9) : '-        ');
    const bal = String(s.balance ?? '-').padEnd(11);
    const chk = s.stateChecksum ? String(s.stateChecksum).slice(0, 6) : `(lsn ${s.appliedLsn})`;

    lines.push(`${node} ${role} ${applied} ${lag} ${pending} ${lastAck} ${bal} ${chk}`);
    if (s.role !== 'primary') {
      acksList.push(`${s.nodeId}=${s.appliedLsn}`);
    }
  }

  lines.push(`errors none   acks ${acksList.join(' ')}`);
  return lines.join('\n');
}

function renderBanner(info = {}) {
  const leader = info.leaderId ? `node-${info.leaderId}` : 'none';
  const epoch = info.epoch !== undefined ? info.epoch : '-';
  const mode = info.replicationMode || 'ASYNC';
  const nodesUp = info.nodesUp || '4/4';

  const lines = [
    '=========================================',
    '       DISTRIBUTED BANKING SYSTEM        ',
    `  leader: ${leader.padEnd(8)} epoch: ${String(epoch).padEnd(3)} mode: ${mode.padEnd(7)} nodes up: ${nodesUp}`,
    '========================================='
  ];
  return lines.join('\n');
}

function renderClusterTable(nodesList = []) {
  const lines = [
    'node  role     epoch  leader  backup  lastLsn  durableLsn  mode   health   lease'
  ];

  for (const n of nodesList) {
    const node = String(n.nodeId || '').padEnd(5);
    const role = String(n.role || 'down').padEnd(8);
    const epoch = String(n.epoch ?? '-').padEnd(6);
    const leader = String(n.leaderId || '-').padEnd(7);
    const backup = String(n.backupId || '-').padEnd(7);
    const lastLsn = String(n.lastLsn ?? '-').padEnd(8);
    const durableLsn = String(n.durableLsn ?? '-').padEnd(11);
    const mode = String(n.replicationMode || '-').padEnd(6);
    const health = (n.dbHealthy ? 'healthy' : 'unhealthy').padEnd(8);
    const lease = n.leaseValid ? 'valid' : 'expired';

    lines.push(`${node} ${role} ${epoch} ${leader} ${backup} ${lastLsn} ${durableLsn} ${mode} ${health} ${lease}`);
  }

  return lines.join('\n');
}

function renderTransactionHistory(transactions = []) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return 'No transactions found.';
  }

  const lines = [
    'txnId     type        source    dest      amount       status     lsn  epoch  lamport  committed'
  ];

  for (const t of transactions) {
    const txnId = String(t.txn_id || t.txnId || '').slice(0, 8).padEnd(9);
    const type = String(t.type || '').padEnd(11);
    const src = String(t.source_account_id || t.sourceAccountId || '-').padEnd(9);
    const dst = String(t.destination_account_id || t.destinationAccountId || '-').padEnd(9);
    const amt = String(t.amount || '').padStart(10).padEnd(12);
    const status = String(t.status || '').padEnd(10);
    const lsn = String(t.lsn ?? '-').padEnd(4);
    const epoch = String(t.epoch ?? '-').padEnd(6);
    const lamport = String(t.lamport_ts || t.lamport || '-').padEnd(8);
    const committed = t.committed_at ? new Date(t.committed_at).toISOString().slice(11, 19) : '-';

    lines.push(`${txnId} ${type} ${src} ${dst} ${amt} ${status} ${lsn} ${epoch} ${lamport} ${committed}`);
  }

  return lines.join('\n');
}

function renderInvariantsReport(reports = []) {
  const lines = [
    'node  I1  I2  I3  I4  I5  I6  I7  I8  I9  I10 I11 I12  checksum  verdict'
  ];

  for (const r of reports) {
    const node = String(r.nodeId || '').padEnd(5);
    const inv = r.invariants || {};
    const flags = [];
    for (let i = 1; i <= 12; i++) {
      const code = `I${i}`;
      flags.push(inv[code] ? 'OK' : 'FL');
    }
    const invStr = flags.join('  ');
    const chk = r.checksum ? String(r.checksum).slice(0, 6).padEnd(9) : '-        ';
    const verdict = r.passed ? 'PASS' : 'FAIL';

    lines.push(`${node} ${invStr}   ${chk} ${verdict}`);
  }

  return lines.join('\n');
}

function renderFaultsTable(faultsList = []) {
  const lines = [
    'node  knob                  value'
  ];

  for (const f of faultsList) {
    const node = String(f.nodeId).padEnd(5);
    const knob = String(f.knob).padEnd(21);
    const val = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
    lines.push(`${node} ${knob} ${val}`);
  }

  if (faultsList.length === 0) {
    lines.push('none  (all fault knobs inactive)');
  }

  return lines.join('\n');
}

function renderWorkerReport(report = {}) {
  const sum = report.summary || {};
  const totalTasks = sum.requests ?? report.totalTasks ?? report.tasks?.length ?? 0;
  const committed = sum.succeeded ?? report.committed ?? 0;
  const rejected = sum.rejected ?? report.rejected ?? 0;
  const duration = sum.durationMs ?? report.durationMs ?? 0;
  const idHeader = report.batchId ? `batchId: ${report.batchId}` : `scenario: ${report.scenario || 'batch'}`;

  const lines = [
    `${idHeader}   duration: ${duration} ms`,
    `totalTasks: ${totalTasks}   committed: ${committed}   rejected: ${rejected}`,
    '',
    'threadId  pgBackendPid  tasksExecuted  committed  rejected'
  ];

  const workerStats = report.workerStats || sum.perWorker || [];
  for (const w of workerStats) {
    const tid = String(w.threadId || '').padEnd(9);
    const pid = String(w.pgBackendPid || w.pgPid || '').padEnd(13);
    const executed = String(w.tasksExecuted ?? w.taskCount ?? 0).padEnd(14);
    const comm = String(w.committed ?? w.succeeded ?? 0).padEnd(10);
    const rej = String(w.rejected || 0);

    lines.push(`${tid} ${pid} ${executed} ${comm} ${rej}`);
  }

  return lines.join('\n');
}

function renderLoadBalancerStats(stats = {}) {
  const lines = [
    `algorithm: ${stats.algorithm || ''}   totalRequests: ${stats.totalRequests || 0}`,
    '',
    'node  requests  share  peakActive  p50(ms)  p95(ms)'
  ];

  const nodes = stats.nodes || {};
  for (const [nid, s] of Object.entries(nodes)) {
    const node = nid.padEnd(5);
    const reqs = String(s.requests || 0).padEnd(9);
    const share = String(s.share || '0%').padEnd(6);
    const peak = String(s.peakActive || 0).padEnd(11);
    const p50 = String(s.p50Ms || 0).padEnd(8);
    const p95 = String(s.p95Ms || 0);

    lines.push(`${node} ${reqs} ${share} ${peak} ${p50} ${p95}`);
  }

  return lines.join('\n');
}

module.exports = {
  renderTrace,
  renderRpcResult,
  renderClocksTable,
  renderBerkeleySync,
  renderEventOrdering,
  renderReplicationStatus,
  renderBanner,
  renderClusterTable,
  renderTransactionHistory,
  renderInvariantsReport,
  renderFaultsTable,
  renderWorkerReport,
  renderLoadBalancerStats
};

