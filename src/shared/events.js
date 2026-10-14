// src/shared/events.js: Event logger for event_log table and trace propagation
// Specification: PROJECT.md Section 12.2, Section 17.3

const { physicalClock } = require('../clocks/physicalClock');
const { lamportClock } = require('../clocks/lamportClock');
const { query } = require('./db/pool');
const { logger } = require('./logger');

// In-memory fallback/buffer (used on coordinator or when DB pool is not attached)
const inMemoryEvents = [];
const MAX_IN_MEMORY_EVENTS = 1000;

/**
 * Record an event into event_log table and in-memory buffer.
 *
 * @param {Object} options
 * @param {string} options.eventType - Name of the event (e.g. 'rpc.received', 'db.commit', 'clock.adjust')
 * @param {string} [options.requestId] - Associated request ID
 * @param {string} [options.txnId] - Associated transaction UUID
 * @param {string} [options.peer] - Remote peer identifier if applicable
 * @param {Object} [options.detail] - Extra event detail
 * @param {Object} [options.client] - Optional pg client (for use inside transactions)
 * @param {boolean} [options.lamportTick=false] - Whether this is a local event that ticks Lamport clock
 * @returns {Promise<Object>} The recorded event record
 */
async function recordEvent(options = {}) {
  const {
    eventType,
    requestId = null,
    txnId = null,
    peer = null,
    detail = null,
    client = null,
    lamportTick = false
  } = options;

  if (lamportTick) {
    lamportClock.tick();
  }

  const lamport = lamportClock.get();
  const physicalTs = physicalClock.now();
  const nowIso = new Date(physicalTs).toISOString();

  const eventRecord = {
    ts: nowIso,
    physical_ts: physicalTs,
    lamport,
    event_type: eventType,
    request_id: requestId,
    txn_id: txnId,
    peer,
    detail: detail || null
  };

  // Keep in in-memory ring buffer
  inMemoryEvents.push(eventRecord);
  if (inMemoryEvents.length > MAX_IN_MEMORY_EVENTS) {
    inMemoryEvents.shift();
  }

  // Attempt DB persistence if a client or active DB pool exists
  try {
    const detailJson = detail ? JSON.stringify(detail) : null;
    const queryFn = client ? client.query.bind(client) : query;

    const res = await queryFn(`
      INSERT INTO event_log (physical_ts, lamport, event_type, request_id, txn_id, peer, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, ts;
    `, [physicalTs, lamport, eventType, requestId, txnId, peer, detailJson]);

    if (res && res.rows && res.rows[0]) {
      eventRecord.id = Number(res.rows[0].id);
      eventRecord.ts = res.rows[0].ts;
    }
  } catch (err) {
    // If coordinator has no DB or during startup/teardown, ignore DB insert failure
    logger.debug({ event: 'event_log.db_skip', reason: err.message, eventType });
  }

  return eventRecord;
}

/**
 * Query events from DB or memory buffer.
 *
 * @param {Object} options
 * @param {string} [options.requestId]
 * @param {number} [options.limit=100]
 * @param {string|number} [options.since]
 * @param {Object} [options.client]
 * @returns {Promise<Array<Object>>}
 */
async function queryEvents(options = {}) {
  const {
    requestId = null,
    limit = 100,
    since = null,
    client = null
  } = options;

  try {
    const queryFn = client ? client.query.bind(client) : query;
    let sql = `
      SELECT id, ts, physical_ts, lamport, event_type, request_id, txn_id, peer, detail
      FROM event_log
    `;
    const params = [];
    const conditions = [];

    if (requestId) {
      params.push(requestId);
      conditions.push(`(request_id = $${params.length} OR detail->>'traceId' = $${params.length} OR detail->>'reqId' = $${params.length})`);
    }

    if (since) {
      params.push(Number(since));
      conditions.push(`physical_ts >= $${params.length}`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    if (requestId) {
      sql += ` ORDER BY id ASC LIMIT $${params.length + 1};`;
    } else {
      sql += ` ORDER BY id DESC LIMIT $${params.length + 1};`;
    }
    params.push(Math.min(limit, 500));

    const res = await queryFn(sql, params);
    const rows = requestId ? res.rows : res.rows.reverse();
    return rows.map(r => ({
      id: Number(r.id),
      ts: r.ts,
      physical_ts: Number(r.physical_ts),
      lamport: Number(r.lamport),
      event_type: r.event_type,
      request_id: r.request_id,
      txn_id: r.txn_id,
      peer: r.peer,
      detail: r.detail
    }));
  } catch (err) {
    // Fall back to in-memory buffer (e.g. on coordinator)
    let list = [...inMemoryEvents];
    if (requestId) {
      list = list.filter(e => e.request_id === requestId || (e.detail && (e.detail.traceId === requestId || e.detail.reqId === requestId)));
    }
    if (since) {
      list = list.filter(e => e.physical_ts >= Number(since));
    }
    return list.slice(-limit);
  }
}

function clearInMemoryEvents() {
  inMemoryEvents.length = 0;
}

module.exports = {
  recordEvent,
  queryEvents,
  clearInMemoryEvents
};
