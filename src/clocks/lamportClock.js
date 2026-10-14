// src/clocks/lamportClock.js: Lamport Logical Clock
// Specification: PROJECT.md Section 17.3
// Local event: value += 1
// Send (RPC request/response): value += 1, attach to _meta.lamport
// Receive: value = max(value, msg.lamport) + 1

class LamportClock {
  constructor(initialValue = 0) {
    this.value = Number(initialValue || 0);
  }

  /**
   * Return current Lamport logical timestamp
   */
  get() {
    return this.value;
  }

  /**
   * Advance clock for a local event or before sending a message
   * Rule: value += 1
   */
  tick() {
    this.value += 1;
    return this.value;
  }

  /**
   * Update clock upon receiving a message carrying a remote Lamport timestamp
   * Rule: value = max(value, msg.lamport) + 1
   */
  update(msgLamport) {
    const remote = Number(msgLamport || 0);
    this.value = Math.max(this.value, remote) + 1;
    return this.value;
  }

  /**
   * Set or reset Lamport clock (for testing)
   */
  set(val) {
    this.value = Number(val || 0);
    return this.value;
  }
}

// Default process-wide singleton Lamport clock
const defaultLamportClock = new LamportClock(0);

module.exports = {
  LamportClock,
  lamportClock: defaultLamportClock
};
