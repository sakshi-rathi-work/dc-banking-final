// src/shared/logger.js: Structured JSON logging with pino
const pino = require('pino');

function createLogger(defaultBindings = {}) {
  const logLevel = process.env.LOG_LEVEL || 'info';

  const logger = pino({
    level: logLevel,
    base: {
      pid: process.pid,
      hostname: require('os').hostname(),
      nodeId: process.env.NODE_ID || 'coordinator',
      ...defaultBindings
    },
    timestamp: () => `,"ts":${Date.now()}`,
    formatters: {
      level: (label) => ({ level: label })
    }
  });

  return logger;
}

const defaultLogger = createLogger();

module.exports = {
  createLogger,
  logger: defaultLogger
};
