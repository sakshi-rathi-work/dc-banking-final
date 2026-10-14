// src/domain/validators.js: Input validation for banking contracts
const { isValidMoneyString, compareMoney, formatMoney } = require('./money');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

const ACCOUNT_ID_REGEX = /^ACC-[0-9]{4,}$/;

function validateAccountId(id, fieldName = 'accountId') {
  if (typeof id !== 'string' || !ACCOUNT_ID_REGEX.test(id.trim())) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      `Invalid ${fieldName}: "${id}". Must match format ACC-0001`
    );
  }
  return id.trim();
}

function validateHolderName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      'holderName must be a string between 1 and 100 characters'
    );
  }
  return name.trim();
}

function validateAmount(amountStr, maxAmount = '1000000.00') {
  if (!isValidMoneyString(amountStr)) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      `Invalid amount: "${amountStr}". Must be positive decimal string with up to 2 decimal places`
    );
  }
  const formatted = formatMoney(amountStr);
  if (compareMoney(formatted, maxAmount) > 0) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      `Amount ${formatted} exceeds maximum allowed policy limit of ${maxAmount}`
    );
  }
  return formatted;
}

function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.trim().length > 128) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      'idempotencyKey must be a non-empty string up to 128 characters'
    );
  }
  return key.trim();
}

module.exports = {
  ACCOUNT_ID_REGEX,
  validateAccountId,
  validateHolderName,
  validateAmount,
  validateIdempotencyKey
};
