// src/workers/barrier.js: SharedArrayBuffer barrier for simultaneous worker thread release
// Section 16.2: Barrier synchronization via Atomics.wait / Atomics.notify

class WorkerBarrier {
  constructor() {
    this.buffer = new SharedArrayBuffer(4);
    this.array = new Int32Array(this.buffer);
    this.array[0] = 0;
  }

  getBuffer() {
    return this.buffer;
  }

  reset() {
    Atomics.store(this.array, 0, 0);
  }

  release() {
    Atomics.store(this.array, 0, 1);
    Atomics.notify(this.array, 0);
  }

  static wait(buffer) {
    if (!buffer) return process.hrtime.bigint();
    const arr = new Int32Array(buffer);
    Atomics.wait(arr, 0, 0);
    return process.hrtime.bigint();
  }
}

module.exports = {
  WorkerBarrier
};
