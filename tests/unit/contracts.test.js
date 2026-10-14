// tests/unit/contracts.test.js: Unit tests for contract method parameter validation
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateMethodParams, METHOD_NAMES } = require('../../src/contracts/methods');
const { RpcError, ERROR_CODES } = require('../../src/contracts/errors');

describe('Contracts and Parameter Validation', () => {
  it('validates bank.createAccount params', () => {
    // Valid
    assert.doesNotThrow(() => {
      validateMethodParams(METHOD_NAMES.BANK_CREATE_ACCOUNT, {
        holderName: 'Alice',
        idempotencyKey: 'idem-1'
      });
    });

    // Invalid holderName
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.BANK_CREATE_ACCOUNT, {
        holderName: '',
        idempotencyKey: 'idem-1'
      });
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);

    // Missing idempotencyKey
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.BANK_CREATE_ACCOUNT, {
        holderName: 'Alice'
      });
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);
  });

  it('validates bank.deposit and bank.withdraw params', () => {
    // Valid
    assert.doesNotThrow(() => {
      validateMethodParams(METHOD_NAMES.BANK_DEPOSIT, {
        accountId: 'ACC-0001',
        amount: '500.00',
        idempotencyKey: 'idem-2'
      });
    });

    // Invalid accountId format
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.BANK_DEPOSIT, {
        accountId: 'bad-id',
        amount: '500.00',
        idempotencyKey: 'idem-2'
      });
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);

    // Invalid amount (negative)
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.BANK_WITHDRAW, {
        accountId: 'ACC-0001',
        amount: '-50.00',
        idempotencyKey: 'idem-2'
      });
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);
  });

  it('validates bank.transfer distinct accounts', () => {
    // Same account
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.BANK_TRANSFER, {
        fromAccountId: 'ACC-0001',
        toAccountId: 'ACC-0001',
        amount: '100.00',
        idempotencyKey: 'idem-3'
      });
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);

    // Distinct accounts: valid
    assert.doesNotThrow(() => {
      validateMethodParams(METHOD_NAMES.BANK_TRANSFER, {
        fromAccountId: 'ACC-0001',
        toAccountId: 'ACC-0002',
        amount: '100.00',
        idempotencyKey: 'idem-3'
      });
    });
  });

  it('validates worker.runBatch params', () => {
    // Valid with scenario
    assert.doesNotThrow(() => {
      validateMethodParams(METHOD_NAMES.WORKER_RUN_BATCH, {
        scenario: 'parallel-withdrawals'
      });
    });

    // Valid with operations array
    assert.doesNotThrow(() => {
      validateMethodParams(METHOD_NAMES.WORKER_RUN_BATCH, {
        operations: [{ type: 'deposit', accountId: 'ACC-0001', amount: '100.00' }]
      });
    });

    // Invalid: neither scenario nor operations
    assert.throws(() => {
      validateMethodParams(METHOD_NAMES.WORKER_RUN_BATCH, {});
    }, (err) => err instanceof RpcError && err.code === ERROR_CODES.INVALID_PARAMS);
  });
});
