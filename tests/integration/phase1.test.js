// tests/integration/phase1.test.js: Phase 1 Core Banking Integration Tests
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { callRpc } = require('../../src/shared/rpc/client');
const { RpcError } = require('../../src/contracts/errors');

describe('Phase 1: Core Banking Engine and Invariants', () => {
  const nodeA = 'http://localhost:3001';
  const nodeB = 'http://localhost:3002';

  let acc1Id = null;
  let acc2Id = null;

  before(async () => {
    await callRpc(nodeA, 'cluster.clearFaults', {}).catch(() => {});
    await callRpc(nodeB, 'cluster.clearFaults', {}).catch(() => {});
  });

  it('rejects mutating writes on non-primary node B with NOT_PRIMARY', async () => {
    let failed = false;
    try {
      await callRpc(nodeB, 'bank.createAccount', {
        holderName: 'Alice',
        idempotencyKey: `idem-b-create-${Date.now()}`
      });
    } catch (err) {
      failed = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, -32005, 'Error code must be NOT_PRIMARY (-32005)');
      assert.equal(err.data.leaderHint, 'a', 'Leader hint must be "a"');
    }
    assert.ok(failed, 'Write on node B must fail with NOT_PRIMARY');
  });

  it('creates accounts on primary node A with opening deposits', async () => {
    const res1 = await callRpc(nodeA, 'bank.createAccount', {
      holderName: 'Alice',
      openingDeposit: '1000.00',
      idempotencyKey: `idem-create-acc1-${Date.now()}`
    });

    assert.ok(res1.accountId.startsWith('ACC-'));
    assert.equal(res1.holderName, 'Alice');
    assert.equal(res1.balance, '1000.00');
    assert.ok(res1.lsn > 0);
    acc1Id = res1.accountId;

    const res2 = await callRpc(nodeA, 'bank.createAccount', {
      holderName: 'Bob',
      idempotencyKey: `idem-create-acc2-${Date.now()}`
    });

    assert.ok(res2.accountId.startsWith('ACC-'));
    assert.equal(res2.holderName, 'Bob');
    assert.equal(res2.balance, '0.00');
    acc2Id = res2.accountId;
  });

  it('deposits funds into account', async () => {
    const depositKey = `idem-dep-${Date.now()}`;
    const res = await callRpc(nodeA, 'bank.deposit', {
      accountId: acc1Id,
      amount: '500.00',
      idempotencyKey: depositKey
    });

    assert.equal(res.status, 'COMMITTED');
    assert.equal(res.balance, '1500.00');
    assert.equal(res.duplicate, false);
    assert.ok(res.lsn > 0);

    // Idempotent retry: resend same key
    const retryRes = await callRpc(nodeA, 'bank.deposit', {
      accountId: acc1Id,
      amount: '500.00',
      idempotencyKey: depositKey
    });

    assert.equal(retryRes.status, 'COMMITTED');
    assert.equal(retryRes.balance, '1500.00');
    assert.equal(retryRes.duplicate, true);

    // Verify balance is still 1500.00 via bank.getBalance
    const bal = await callRpc(nodeA, 'bank.getBalance', { accountId: acc1Id });
    assert.equal(bal.balance, '1500.00');
  });

  it('rejects key reuse with different payload (IDEMPOTENCY_KEY_REUSED)', async () => {
    const reuseKey = `idem-reuse-${Date.now()}`;
    await callRpc(nodeA, 'bank.deposit', {
      accountId: acc1Id,
      amount: '100.00',
      idempotencyKey: reuseKey
    });

    let failed = false;
    try {
      await callRpc(nodeA, 'bank.deposit', {
        accountId: acc1Id,
        amount: '200.00', // Different amount!
        idempotencyKey: reuseKey
      });
    } catch (err) {
      failed = true;
      assert.equal(err.code, -32004, 'Must throw IDEMPOTENCY_KEY_REUSED (-32004)');
    }
    assert.ok(failed, 'Reusing key with different amount must be rejected');
  });

  it('withdraws funds from account', async () => {
    const res = await callRpc(nodeA, 'bank.withdraw', {
      accountId: acc1Id,
      amount: '300.00',
      idempotencyKey: `idem-wth-${Date.now()}`
    });

    assert.equal(res.status, 'COMMITTED');
    assert.equal(res.balance, '1300.00');
  });

  it('rejects overdrafts and records REJECTED transaction with reason', async () => {
    const overdraftKey = `idem-overdraft-${Date.now()}`;
    let failed = false;

    try {
      await callRpc(nodeA, 'bank.withdraw', {
        accountId: acc1Id,
        amount: '5000.00', // Account only has 1300.00
        idempotencyKey: overdraftKey
      });
    } catch (err) {
      failed = true;
      assert.equal(err.code, -32002, 'Must return INSUFFICIENT_FUNDS (-32002)');
      assert.equal(err.data.status, 'REJECTED');
      assert.equal(err.data.rejectReason, 'INSUFFICIENT_FUNDS');
      assert.equal(err.data.balance, '1300.00');
    }
    assert.ok(failed, 'Overdraft withdrawal must fail');

    // Verify balance is unchanged
    const bal = await callRpc(nodeA, 'bank.getBalance', { accountId: acc1Id });
    assert.equal(bal.balance, '1300.00');

    // Verify history contains REJECTED transaction
    const hist = await callRpc(nodeA, 'bank.getHistory', { accountId: acc1Id, limit: 5 });
    const rejectedTxn = hist.transactions.find(t => t.idempotencyKey === overdraftKey);
    assert.ok(rejectedTxn, 'History must contain recorded REJECTED transaction');
    assert.equal(rejectedTxn.status, 'REJECTED');
    assert.equal(rejectedTxn.rejectReason, 'INSUFFICIENT_FUNDS');

    // Verify retry returns stored REJECTED result
    let retryFailed = false;
    try {
      await callRpc(nodeA, 'bank.withdraw', {
        accountId: acc1Id,
        amount: '5000.00',
        idempotencyKey: overdraftKey
      });
    } catch (err) {
      retryFailed = true;
      assert.equal(err.code, -32002);
      assert.equal(err.data.duplicate, true);
    }
    assert.ok(retryFailed, 'Overdraft retry must return duplicate REJECTED result');
  });

  it('transfers money atomically between two accounts', async () => {
    // Current balances: acc1 = 1300.00, acc2 = 0.00
    const transferKey = `idem-xfer-${Date.now()}`;
    const res = await callRpc(nodeA, 'bank.transfer', {
      fromAccountId: acc1Id,
      toAccountId: acc2Id,
      amount: '400.00',
      idempotencyKey: transferKey
    });

    assert.equal(res.status, 'COMMITTED');
    assert.equal(res.fromBalance, '900.00');
    assert.equal(res.toBalance, '400.00');

    const bal1 = await callRpc(nodeA, 'bank.getBalance', { accountId: acc1Id });
    const bal2 = await callRpc(nodeA, 'bank.getBalance', { accountId: acc2Id });
    assert.equal(bal1.balance, '900.00');
    assert.equal(bal2.balance, '400.00');
  });

  it('rejects transfer with insufficient funds as REJECTED', async () => {
    let failed = false;
    try {
      await callRpc(nodeA, 'bank.transfer', {
        fromAccountId: acc1Id,
        toAccountId: acc2Id,
        amount: '99999.00',
        idempotencyKey: `idem-xfer-overdraft-${Date.now()}`
      });
    } catch (err) {
      failed = true;
      assert.equal(err.code, -32002);
      assert.equal(err.data.status, 'REJECTED');
    }
    assert.ok(failed, 'Overdraft transfer must fail');

    // Balances unchanged
    const bal1 = await callRpc(nodeA, 'bank.getBalance', { accountId: acc1Id });
    assert.equal(bal1.balance, '900.00');
  });

  it('passes all banking invariants (I1-I12) and verifies gap-free hash chain', async () => {
    const report = await callRpc(nodeA, 'admin.verifyInvariants', {});
    assert.equal(report.pass, true, 'All invariants must pass');
    assert.equal(report.checks.I1_noNegativeBalance.pass, true);
    assert.equal(report.checks.I8_ledgerBalanceAgreement.pass, true);
    assert.equal(report.checks.I9_moneyConservation.pass, true);
    assert.equal(report.checks.I10_gapFreeHashChain.pass, true);
    assert.equal(report.checks.I11_epochFencing.pass, true);

    const checksum = await callRpc(nodeA, 'admin.stateChecksum', {});
    assert.ok(checksum.checksum);
    assert.ok(checksum.lastLsn > 0);
  });

  it('persists all balances and history across container restarts', async () => {
    const beforeChecksum = await callRpc(nodeA, 'admin.stateChecksum', {});

    console.log('Restarting postgres-a and bank-node-a...');
    execSync('docker compose restart postgres-a', { stdio: 'inherit' });
    let pgReady = false;
    const pgStart = Date.now();
    while (Date.now() - pgStart < 15000) {
      try {
        const out = execSync('docker compose ps postgres-a --format json', { encoding: 'utf8' });
        if (out.includes('healthy')) {
          pgReady = true;
          break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }

    execSync('docker compose restart bank-node-a', { stdio: 'inherit' });

    // Wait for node A to become healthy again
    let ready = false;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        const res = await fetch('http://localhost:3001/health');
        if (res.ok) {
          ready = true;
          break;
        }
      } catch (err) {}
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ready, 'Node A must recover after restart');

    const afterChecksum = await callRpc(nodeA, 'admin.stateChecksum', {});
    assert.equal(afterChecksum.checksum, beforeChecksum.checksum, 'State checksum must match after restart');
    assert.equal(afterChecksum.lastLsn, beforeChecksum.lastLsn, 'Last LSN must match after restart');

    const bal1 = await callRpc(nodeA, 'bank.getBalance', { accountId: acc1Id });
    assert.equal(bal1.balance, '900.00');

    const invReport = await callRpc(nodeA, 'admin.verifyInvariants', {});
    assert.equal(invReport.pass, true, 'Invariants must pass after restart');
  });
});
