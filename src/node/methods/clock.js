// src/node/methods/clock.js: RPC methods for clock inspection, manipulation, and event retrieval
// Specification: PROJECT.md Section 13.3, Section 17

const { METHOD_NAMES, validateMethodParams } = require('../../contracts/methods');
const { physicalClock } = require('../../clocks/physicalClock');
const { lamportClock } = require('../../clocks/lamportClock');
const { recordEvent, queryEvents } = require('../../shared/events');

function registerClockMethods(rpcServer, config) {
  // clock.get
  rpcServer.register(METHOD_NAMES.CLOCK_GET, async () => {
    const clockInfo = physicalClock.getTime();
    return {
      nodeId: config.nodeId,
      ...clockInfo,
      lamport: lamportClock.get()
    };
  });

  // clock.setOffset
  rpcServer.register(METHOD_NAMES.CLOCK_SET_OFFSET, async (params, meta) => {
    validateMethodParams(METHOD_NAMES.CLOCK_SET_OFFSET, params);

    const clockInfo = physicalClock.setOffset(params.offsetMs, params.driftPpm || 0);

    await recordEvent({
      eventType: 'clock.set_offset',
      requestId: meta ? meta.traceId : null,
      detail: {
        offsetMs: params.offsetMs,
        driftPpm: params.driftPpm || 0
      }
    });

    return {
      nodeId: config.nodeId,
      ...clockInfo,
      lamport: lamportClock.get()
    };
  });

  // clock.adjust
  rpcServer.register(METHOD_NAMES.CLOCK_ADJUST, async (params, meta) => {
    validateMethodParams(METHOD_NAMES.CLOCK_ADJUST, params);

    const adjustInfo = physicalClock.adjust(params.deltaMs);

    await recordEvent({
      eventType: 'clock.adjust',
      requestId: meta ? meta.traceId : null,
      detail: {
        deltaMs: params.deltaMs,
        syncId: params.syncId || null,
        newOffsetMs: adjustInfo.newOffsetMs
      }
    });

    return {
      nodeId: config.nodeId,
      ...adjustInfo,
      lamport: lamportClock.get()
    };
  });

  // clock.events
  rpcServer.register(METHOD_NAMES.CLOCK_EVENTS, async (params) => {
    const events = await queryEvents({
      requestId: params.requestId,
      limit: params.limit || 100,
      since: params.since
    });

    return {
      nodeId: config.nodeId,
      events
    };
  });
}

module.exports = {
  registerClockMethods
};
