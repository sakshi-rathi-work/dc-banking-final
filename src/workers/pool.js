// src/workers/pool.js: Worker thread pool manager, task distributor, and fault recovery
const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');
const { WorkerBarrier } = require('./barrier');
const { query } = require('../shared/db/pool');
const { verifyInvariants } = require('../domain/invariants');
const { logger } = require('../shared/logger');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

class WorkerPool {
  constructor(databaseUrl, maxSize = 16) {
    this.databaseUrl = databaseUrl;
    this.maxSize = Math.min(Math.max(1, maxSize), 16);
    this.workers = new Map(); // workerId -> { worker, threadId, pgPid, ready, busy }
    this.workerScript = path.join(__dirname, 'worker.js');
    this.totalTasksExecuted = 0;
  }

  async ensureWorker(workerId) {
    if (this.workers.has(workerId)) {
      const entry = this.workers.get(workerId);
      if (entry.ready) return entry;
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerScript, {
        workerData: {
          workerId,
          databaseUrl: this.databaseUrl
        }
      });

      const entry = {
        workerId,
        worker,
        threadId: null,
        pgPid: null,
        ready: false,
        busy: false
      };
      this.workers.set(workerId, entry);

      const timeout = setTimeout(() => {
        reject(new Error(`Worker ${workerId} timed out during initialization`));
      }, 10000);

      worker.on('message', (msg) => {
        if (msg && msg.type === 'ready') {
          clearTimeout(timeout);
          entry.threadId = msg.threadId;
          entry.pgPid = msg.pgPid;
          entry.ready = true;
          logger.debug({
            event: 'worker.ready',
            workerId,
            threadId: msg.threadId,
            pgPid: msg.pgPid
          });
          resolve(entry);
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        logger.error({ event: 'worker.error', workerId, error: err.message });
        this.workers.delete(workerId);
      });

      worker.on('exit', (code) => {
        clearTimeout(timeout);
        logger.warn({ event: 'worker.exit', workerId, code });
        this.workers.delete(workerId);
      });
    });
  }

  async ensureWorkers(count) {
    const targetCount = Math.min(count, this.maxSize);
    const promises = [];
    for (let i = 0; i < targetCount; i++) {
      promises.push(this.ensureWorker(i));
    }
    return Promise.all(promises);
  }

  getWorkerStats() {
    const list = [];
    for (const [id, entry] of this.workers.entries()) {
      list.push({
        workerId: id,
        threadId: entry.threadId,
        pgPid: entry.pgPid,
        busy: entry.busy,
        ready: entry.ready
      });
    }
    return list;
  }

  async runBatch({
    operations = [],
    workers = 4,
    distribution = 'static',
    holdAfterLockMs = 0,
    workerCrashOnTask = null,
    timeoutMs = 30000
  }) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'operations must be a non-empty array');
    }

    const workerCount = Math.min(workers || 4, this.maxSize);
    const activeWorkers = await this.ensureWorkers(workerCount);

    const barrier = new WorkerBarrier();
    const barrierBuffer = barrier.getBuffer();

    // Prepare normalized task list with idempotency keys
    const tasks = operations.map((op, idx) => {
      const operationName = op.type || op.operation || 'deposit';
      const key = op.idempotencyKey || `idem-batch-${Date.now()}-${idx}-${crypto.randomUUID().slice(0, 6)}`;
      const taskId = op.taskId || `task-${idx}`;
      const requestId = op.requestId || `req-batch-${idx}`;

      return {
        taskId,
        requestId,
        operation: operationName,
        params: { ...op, idempotencyKey: key },
        idempotencyKey: key,
        meta: op.meta || {}
      };
    });

    const affectedAccounts = new Set();
    for (const t of tasks) {
      if (t.params.accountId) affectedAccounts.add(t.params.accountId);
      if (t.params.fromAccountId) affectedAccounts.add(t.params.fromAccountId);
      if (t.params.toAccountId) affectedAccounts.add(t.params.toAccountId);
    }

    const startTime = process.hrtime();
    let allTaskResults = [];

    // Execute with static or dynamic distribution
    if (distribution === 'dynamic') {
      allTaskResults = await this.executeDynamic(
        activeWorkers,
        tasks,
        barrier,
        barrierBuffer,
        holdAfterLockMs,
        workerCrashOnTask,
        timeoutMs
      );
    } else {
      allTaskResults = await this.executeStatic(
        activeWorkers,
        tasks,
        barrier,
        barrierBuffer,
        holdAfterLockMs,
        workerCrashOnTask,
        timeoutMs
      );
    }

    const [s, ns] = process.hrtime(startTime);
    const durationMs = Math.round((s * 1000 + ns / 1e6) * 10) / 10;
    this.totalTasksExecuted += allTaskResults.length;

    // Build perWorker summary
    const perWorkerMap = new Map();
    for (const w of activeWorkers) {
      perWorkerMap.set(w.workerId, {
        workerId: w.workerId,
        threadId: w.threadId,
        pgPid: w.pgPid,
        taskCount: 0,
        succeeded: 0,
        rejected: 0,
        failed: 0
      });
    }

    let succeeded = 0;
    let rejected = 0;
    let failed = 0;

    for (const res of allTaskResults) {
      const pw = perWorkerMap.get(res.workerId);
      if (pw) {
        pw.taskCount++;
      }

      if (res.status === 'COMMITTED') {
        succeeded++;
        if (pw) pw.succeeded++;
      } else if (res.status === 'REJECTED') {
        rejected++;
        if (pw) pw.rejected++;
      } else {
        failed++;
        if (pw) pw.failed++;
      }
    }

    const throughputPerSec = durationMs > 0
      ? Math.round((allTaskResults.length / (durationMs / 1000)) * 10) / 10
      : allTaskResults.length;

    // Fetch updated balances
    const balancesAfter = {};
    if (affectedAccounts.size > 0) {
      const accList = Array.from(affectedAccounts);
      const accRes = await query(
        'SELECT account_id, balance, version FROM accounts WHERE account_id = ANY($1)',
        [accList]
      );
      for (const row of accRes.rows) {
        balancesAfter[row.account_id] = {
          balance: row.balance,
          version: Number(row.version)
        };
      }
    }

    // Invariant verification report
    const invariants = await verifyInvariants();

    return {
      tasks: allTaskResults,
      summary: {
        requests: tasks.length,
        succeeded,
        rejected,
        failed,
        durationMs,
        throughputPerSec,
        perWorker: Array.from(perWorkerMap.values())
      },
      balancesAfter,
      invariants
    };
  }

  async executeStatic(activeWorkers, tasks, barrier, barrierBuffer, holdAfterLockMs, workerCrashOnTask, timeoutMs) {
    const W = activeWorkers.length;
    const workerTaskBuckets = Array.from({ length: W }, () => []);

    for (let i = 0; i < tasks.length; i++) {
      workerTaskBuckets[i % W].push(tasks[i]);
    }

    const workerPromises = activeWorkers.map((entry, idx) => {
      const myTasks = workerTaskBuckets[idx];
      if (myTasks.length === 0) return Promise.resolve([]);

      return new Promise((resolve) => {
        let finished = false;

        const onMessage = (msg) => {
          if (msg && msg.type === 'batch_done' && msg.workerId === entry.workerId) {
            finished = true;
            entry.worker.off('message', onMessage);
            resolve(msg.results);
          }
        };

        const onExit = async (code) => {
          if (!finished) {
            entry.worker.off('message', onMessage);
            logger.warn({
              event: 'worker.crashed_during_batch',
              workerId: entry.workerId,
              code
            });

            // Recover and retry failed tasks with the same idempotency keys
            const replacement = await this.ensureWorker(entry.workerId);
            const retryResults = [];

            for (const task of myTasks) {
              try {
                // Execute on replacement worker
                const res = await new Promise((resResolve) => {
                  const retryHandler = (m) => {
                    if (m && m.type === 'batch_done') {
                      replacement.worker.off('message', retryHandler);
                      resResolve(m.results[0]);
                    }
                  };
                  replacement.worker.on('message', retryHandler);
                  const singleBarrier = new WorkerBarrier();
                  replacement.worker.postMessage({
                    type: 'execute_static',
                    tasks: [task],
                    barrierBuffer: singleBarrier.getBuffer(),
                    holdAfterLockMs: 0,
                    workerCrashOnTask: null
                  });
                  singleBarrier.release();
                });
                retryResults.push(res);
              } catch (retryErr) {
                retryResults.push({
                  taskId: task.taskId,
                  requestId: task.requestId,
                  workerId: entry.workerId,
                  threadId: replacement.threadId,
                  pgPid: replacement.pgPid,
                  operation: task.operation,
                  status: 'FAILED',
                  errorCode: -32015
                });
              }
            }
            resolve(retryResults);
          }
        };

        entry.worker.on('message', onMessage);
        entry.worker.once('exit', onExit);

        entry.worker.postMessage({
          type: 'execute_static',
          tasks: myTasks,
          barrierBuffer,
          holdAfterLockMs,
          workerCrashOnTask
        });
      });
    });

    // Release all workers simultaneously on the barrier
    barrier.release();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new RpcError(ERROR_CODES.INTERNAL_ERROR, `Batch timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const resultsByWorker = await Promise.race([
      Promise.all(workerPromises),
      timeoutPromise
    ]);

    return resultsByWorker.flat();
  }

  async executeDynamic(activeWorkers, tasks, barrier, barrierBuffer, holdAfterLockMs, workerCrashOnTask, timeoutMs) {
    let taskIndex = 0;
    const taskQueue = [...tasks];

    const workerPromises = activeWorkers.map((entry) => {
      return new Promise((resolve) => {
        const onMessage = (msg) => {
          if (msg && msg.workerId === entry.workerId) {
            if (msg.type === 'request_task') {
              if (taskIndex < taskQueue.length) {
                const nextTask = taskQueue[taskIndex++];
                entry.worker.postMessage({ type: 'task', task: nextTask });
              } else {
                entry.worker.postMessage({ type: 'no_more_tasks' });
              }
            } else if (msg.type === 'batch_done') {
              entry.worker.off('message', onMessage);
              resolve(msg.results);
            }
          }
        };

        entry.worker.on('message', onMessage);
        entry.worker.postMessage({
          type: 'execute_dynamic',
          barrierBuffer,
          holdAfterLockMs,
          workerCrashOnTask
        });
      });
    });

    barrier.release();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new RpcError(ERROR_CODES.INTERNAL_ERROR, `Batch timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const resultsByWorker = await Promise.race([
      Promise.all(workerPromises),
      timeoutPromise
    ]);

    return resultsByWorker.flat();
  }

  async close() {
    for (const [id, entry] of this.workers.entries()) {
      try {
        entry.worker.postMessage({ type: 'shutdown' });
      } catch (e) {
        // Ignore
      }
    }
    this.workers.clear();
  }
}

module.exports = {
  WorkerPool
};
