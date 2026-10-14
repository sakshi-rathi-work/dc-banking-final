// tests/unit/money.test.js: Unit tests for decimal string money manipulation and floating point ban
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isValidMoneyString,
  moneyStringToCents,
  centsToMoneyString,
  formatMoney,
  compareMoney
} = require('../../src/domain/money');

describe('Money Validation and Precision', () => {
  it('accepts valid decimal money strings', () => {
    assert.equal(isValidMoneyString('500'), true);
    assert.equal(isValidMoneyString('500.00'), true);
    assert.equal(isValidMoneyString('0.50'), true);
    assert.equal(isValidMoneyString('1000000.00'), true);
    assert.equal(isValidMoneyString('12.3'), true);
  });

  it('rejects invalid, negative, or zero money strings', () => {
    assert.equal(isValidMoneyString('0'), false);
    assert.equal(isValidMoneyString('0.00'), false);
    assert.equal(isValidMoneyString('-500.00'), false);
    assert.equal(isValidMoneyString('abc'), false);
    assert.equal(isValidMoneyString('500.000'), false); // More than 2 decimal places
    assert.equal(isValidMoneyString(''), false);
    assert.equal(isValidMoneyString(null), false);
    assert.equal(isValidMoneyString(500), false); // Numbers not allowed
  });

  it('converts to cents and formats back accurately', () => {
    const cents = moneyStringToCents('1234.56');
    assert.equal(cents, 123456n);
    assert.equal(centsToMoneyString(cents), '1234.56');
    assert.equal(formatMoney('500'), '500.00');
    assert.equal(formatMoney('500.5'), '500.50');
  });

  it('compares money amounts correctly without floating point errors', () => {
    assert.equal(compareMoney('100.00', '50.00'), 1);
    assert.equal(compareMoney('50.00', '100.00'), -1);
    assert.equal(compareMoney('50.00', '50.00'), 0);
    assert.equal(compareMoney('0.10', '0.05'), 1);
  });

  it('Invariant I2: verifies no Number()/parseFloat() conversion on money in src/domain and src/txn', () => {
    const dirs = ['src/domain', 'src/txn'];
    const forbiddenPatterns = [
      /parseFloat\s*\(/,
      /Number\s*\(\s*(amount|balance|money|cents)/i
    ];

    for (const dir of dirs) {
      const fullDir = path.resolve(__dirname, '../../', dir);
      const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.js'));

      for (const file of files) {
        const content = fs.readFileSync(path.join(fullDir, file), 'utf8');
        for (const pattern of forbiddenPatterns) {
          const match = content.match(pattern);
          assert.equal(
            match,
            null,
            `Forbidden floating point conversion found in ${dir}/${file}: ${match ? match[0] : ''}`
          );
        }
      }
    }
  });
});
