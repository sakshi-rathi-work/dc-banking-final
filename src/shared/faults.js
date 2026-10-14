// src/shared/faults.js: In-memory fault injection registry
const { RpcError, ERROR_CODES } = require('../contracts/errors');

class FaultRegistry {
  constructor() {
    this.faults = {};
  }

  isEnabled() {
    return process.env.ENABLE_FAULT_INJECTION === 'true';
  }

  setFault(knob, value) {
    if (!this.isEnabled()) {
      throw new RpcError(
        ERROR_CODES.INVALID_REQUEST,
        'Fault injection is disabled (ENABLE_FAULT_INJECTION is false)'
      );
    }
    this.faults[knob] = value;
  }

  getFault(knob) {
    if (!this.isEnabled()) return null;
    return this.faults[knob] !== undefined ? this.faults[knob] : null;
  }

  getFaults() {
    if (!this.isEnabled()) return {};
    return { ...this.faults };
  }

  clearFaults() {
    this.faults = {};
  }
}

const faults = new FaultRegistry();

module.exports = {
  faults
};
