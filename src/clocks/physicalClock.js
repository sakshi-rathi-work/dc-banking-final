// src/clocks/physicalClock.js: Application-Managed Physical Clock with Offset, Drift, and Monotonic Guard
// Specification: PROJECT.md Section 17.1
// physicalNow() = max(lastIssued, Date.now() + offsetMs + driftPpm * 1e-6 * (Date.now() - t0))

class PhysicalClock {
  constructor(options = {}) {
    this.offsetMs = Number(options.offsetMs || 0);
    this.driftPpm = Number(options.driftPpm || 0);
    this.t0 = Date.now();
    this.lastIssued = 0;
    this.nodeId = options.nodeId || process.env.NODE_ID || 'coordinator';
  }

  /**
   * Returns raw application-managed clock time without monotonic guard
   */
  rawTime() {
    const sysNow = Date.now();
    const elapsed = sysNow - this.t0;
    const driftDelta = this.driftPpm * 1e-6 * elapsed;
    return Math.round(sysNow + this.offsetMs + driftDelta);
  }

  /**
   * Returns current application-managed physical timestamp in milliseconds.
   * Monotonic guard ensures non-decreasing timestamps even after backward adjustments.
   */
  now() {
    const raw = this.rawTime();
    const current = Math.max(this.lastIssued, raw);
    this.lastIssued = current;
    return current;
  }

  /**
   * Return full clock status object for inspection and Berkeley synchronization
   */
  getTime() {
    const raw = this.rawTime();
    return {
      nodeId: this.nodeId,
      physicalTs: raw,
      offsetMs: this.offsetMs,
      driftPpm: this.driftPpm,
      iso: new Date(raw).toISOString()
    };
  }

  /**
   * Change offset and drift at runtime (PROJECT.md clock.setOffset)
   */
  setOffset(offsetMs, driftPpm = 0) {
    this.offsetMs = Number(offsetMs);
    this.driftPpm = Number(driftPpm || 0);
    this.t0 = Date.now();
    this.lastIssued = 0;
    return this.getTime();
  }

  /**
   * Add a delta adjustment to current offset (PROJECT.md clock.adjust)
   * Backward adjustments are absorbed by the monotonic guard in now().
   */
  adjust(deltaMs) {
    const oldOffset = this.offsetMs;
    this.offsetMs += Number(deltaMs);
    this.t0 = Date.now();
    return {
      oldOffsetMs: oldOffset,
      newOffsetMs: this.offsetMs,
      deltaMs: Number(deltaMs),
      ...this.getTime()
    };
  }

  /**
   * Reset clock state (for testing)
   */
  reset(offsetMs = 0, driftPpm = 0) {
    this.offsetMs = Number(offsetMs);
    this.driftPpm = Number(driftPpm);
    this.t0 = Date.now();
    this.lastIssued = 0;
    return this.getTime();
  }
}

// Default process-wide singleton physical clock initialized from environment
const defaultPhysicalClock = new PhysicalClock({
  offsetMs: parseInt(process.env.CLOCK_OFFSET_MS || process.env.COORDINATOR_CLOCK_OFFSET_MS || '0', 10),
  driftPpm: parseFloat(process.env.CLOCK_DRIFT_PPM || '0'),
  nodeId: process.env.NODE_ID || 'coordinator'
});

module.exports = {
  PhysicalClock,
  physicalClock: defaultPhysicalClock
};
