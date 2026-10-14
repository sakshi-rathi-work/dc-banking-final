// src/clocks/index.js: Clock modules exports
const { PhysicalClock, physicalClock } = require('./physicalClock');
const { LamportClock, lamportClock } = require('./lamportClock');
const { computeBerkeleySync, calculateSpread } = require('./berkeley');
const { compareEventOrdering } = require('./ordering');

module.exports = {
  PhysicalClock,
  physicalClock,
  LamportClock,
  lamportClock,
  computeBerkeleySync,
  calculateSpread,
  compareEventOrdering
};
