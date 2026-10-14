// src/workers/worker.js: Worker thread isolate for concurrent transaction execution
const { parentPort, workerData, threadId } = require('worker_threads');
const { Pool } = require('pg');
const { executeBankOperation } = require('../txn/executor');
const { WorkerBarrier } = require('./barrier');

async function runWorker() {
  const { workerId, databaseUrl } = workerData;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  let client = null;
  let pgPid = null;

  try {
    client = await pool.connect();
    const pidRes = await client.query('SELECT pg_backend_pid() AS pid');
    pgPid = pidRes.rows[0].pid;
  } catch (err) {
    if (parentPort) {
      parentPort.postMessage({ type: 'error', workerId, error: err.message });
    }
    return;
  }

  // Notify parent that this worker is ready with its thread identity and backend PID
  parentPort.postMessage({
    type: 'ready',
    workerId,
    threadId,
    pgPid
  });

  async function executeTask(task, holdAfterLockMs, workerCrashOnTask, releaseNs) {
    const tStartNs = process.hrtime.bigint();
    const meta = {
      ...(task.meta || {}),
      holdAfterLockMs,
      workerCrashOnTask,
      taskId: task.taskId,
      workerId,
      threadId,
      pgPid
    };

    let status = 'FAILED';
    let errorCode = null;
    let lsn = null;
    let balanceAfter = null;
    let lockWaitMs = 0;
    let result = null;

    try {
      result = await executeBankOperation(task.operation, task.params, meta, client);
      status = result.status || 'COMMITTED';
      lsn = result.lsn || null;
      balanceAfter = result.balance || result.toBalance || null;
      lockWaitMs = result.lockWaitMs || 0;
    } catch (err) {
      status = (result && result.status === 'REJECTED') ? 'REJECTED' : (err.code === -32002 ? 'REJECTED' : 'FAILED');
      errorCode = err.code || -32603;
      if (err.data) {
        balanceAfter = err.data.balance || null;
        lsn = err.data.lsn || null;
        lockWaitMs = err.data.lockWaitMs || 0;
      }
    }

    const tEndNs = process.hrtime.bigint();
    return {
      taskId: task.taskId,
      requestId: task.requestId,
      workerId,
      threadId,
      pgPid,
      operation: task.operation,
      status,
      errorCode,
      lsn,
      balanceAfter,
      lockWaitMs,
      duplicate: result ? (result.duplicate || false) : false,
      tStartNs: Number(tStartNs - releaseNs),
      tEndNs: Number(tEndNs - releaseNs),
      durationMs: Number(tEndNs - tStartNs) / 1e6
    };
  }

  parentPort.on('message', async (msg) => {
    if (!msg) return;

    if (msg.type === 'execute_static') {
      const { tasks, barrierBuffer, holdAfterLockMs, workerCrashOnTask } = msg;
      const releaseNs = WorkerBarrier.wait(barrierBuffer);
      const results = [];

      for (const task of tasks) {
        const res = await executeTask(task, holdAfterLockMs, workerCrashOnTask, releaseNs);
        results.push(res);
      }

      parentPort.postMessage({
        type: 'batch_done',
        workerId,
        results
      });
    } else if (msg.type === 'execute_dynamic') {
      const { barrierBuffer, holdAfterLockMs, workerCrashOnTask } = msg;
      const releaseNs = WorkerBarrier.wait(barrierBuffer);
      const results = [];

      const handleNextTask = () => {
        return new Promise((resolve) => {
          const onTask = async (taskMsg) => {
            if (taskMsg.type === 'task') {
              const res = await executeTask(taskMsg.task, holdAfterLockMs, workerCrashOnTask, releaseNs);
              results.push(res);
              parentPort.postMessage({ type: 'request_task', workerId });
            } else if (taskMsg.type === 'no_more_tasks') {
              parentPort.off('message', onTask);
              resolve();
            }
          };
          parentPort.on('message', onTask);
          parentPort.postMessage({ type: 'request_task', workerId });
        });
      };

      await handleNextTask();
      parentPort.postMessage({
        type: 'batch_done',
        workerId,
        results
      });
    } else if (msg.type === 'shutdown') {
      if (client) {
        client.release();
      }
      await pool.end();
      process.exit(0);
    }
  });
}

if (!require('worker_threads').isMainThread) {
  runWorker().catch((err) => {
    console.error('Worker thread uncaught exception:', err);
    process.exit(1);
  });
}

module.exports = {
  runWorker
};
