// src/domain/money.js: Decimal string validation and formatting for money
// Rule: Money amounts are ALWAYS decimal strings, NEVER JavaScript Numbers.

const MONEY_REGEX = /^\d{1,12}(\.\d{1,2})?$/;

function isValidMoneyString(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (!MONEY_REGEX.test(trimmed)) return false;
  // Must be strictly greater than 0
  const cents = moneyStringToCents(trimmed);
  return cents > 0n;
}

function moneyStringToCents(str) {
  const parts = str.trim().split('.');
  const whole = BigInt(parts[0] || '0');
  let fracStr = parts[1] || '';
  if (fracStr.length === 0) fracStr = '00';
  else if (fracStr.length === 1) fracStr = fracStr + '0';
  else fracStr = fracStr.slice(0, 2);
  const frac = BigInt(fracStr);
  return whole * 100n + frac;
}

function centsToMoneyString(cents) {
  const isNegative = cents < 0n;
  const abs = isNegative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac < 10n ? '0' + frac.toString() : frac.toString();
  return (isNegative ? '-' : '') + whole.toString() + '.' + fracStr;
}

function formatMoney(str) {
  if (!isValidMoneyString(str)) {
    throw new Error(`Invalid money string: "${str}"`);
  }
  const cents = moneyStringToCents(str);
  return centsToMoneyString(cents);
}

function compareMoney(aStr, bStr) {
  const centsA = moneyStringToCents(aStr);
  const centsB = moneyStringToCents(bStr);
  if (centsA < centsB) return -1;
  if (centsA > centsB) return 1;
  return 0;
}

module.exports = {
  MONEY_REGEX,
  isValidMoneyString,
  moneyStringToCents,
  centsToMoneyString,
  formatMoney,
  compareMoney
};
