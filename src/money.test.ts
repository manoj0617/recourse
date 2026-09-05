import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  ZERO,
  add,
  formatINR,
  fromRupees,
  max,
  min,
  multiply,
  overshootRatio,
  paise,
  subClamped,
  sum,
} from './money.js';

describe('paise', () => {
  it('accepts non-negative integers', () => {
    expect(paise(0)).toBe(0);
    expect(paise(780000)).toBe(780000);
  });

  it('rejects fractional paise, negatives and non-finite values', () => {
    expect(() => paise(1.5)).toThrow(MoneyError);
    expect(() => paise(-1)).toThrow(MoneyError);
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('fromRupees', () => {
  it('survives the IEEE-754 cases that truncation loses a paisa on', () => {
    // 19.99 * 100 is 1998.9999999999998; truncating would yield 1998.
    expect(fromRupees(19.99)).toBe(1999);
    expect(fromRupees(8000)).toBe(800000);
    expect(fromRupees(7800.5)).toBe(780050);
  });

  it('refuses sub-paisa precision rather than silently rounding it away', () => {
    expect(() => fromRupees(10.001)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and sums', () => {
    expect(add(paise(100), paise(250))).toBe(350);
    expect(sum([paise(100), paise(250), paise(1)])).toBe(351);
    expect(sum([])).toBe(ZERO);
  });

  it('clamps subtraction at zero, because a refund remainder is never negative', () => {
    expect(subClamped(paise(500), paise(200))).toBe(300);
    expect(subClamped(paise(200), paise(500))).toBe(0);
  });

  it('multiplies only by whole quantities', () => {
    expect(multiply(paise(1999), 3)).toBe(5997);
    expect(() => multiply(paise(1999), 1.5)).toThrow(MoneyError);
    expect(() => multiply(paise(1999), -1)).toThrow(MoneyError);
  });

  it('picks min and max', () => {
    expect(min(paise(500), paise(200), paise(900))).toBe(200);
    expect(max(paise(500), paise(200), paise(900))).toBe(900);
  });
});

describe('overshootRatio', () => {
  it('is zero at or under the ceiling', () => {
    expect(overshootRatio(paise(780000), paise(800000))).toBe(0);
    expect(overshootRatio(paise(800000), paise(800000))).toBe(0);
  });

  it('measures the overshoot as a fraction of the ceiling', () => {
    expect(overshootRatio(paise(880000), paise(800000))).toBeCloseTo(0.1, 10);
    expect(overshootRatio(paise(1600000), paise(800000))).toBeCloseTo(1, 10);
  });

  it('treats any spend against a zero ceiling as unbounded overshoot', () => {
    expect(overshootRatio(paise(1), ZERO)).toBe(Number.POSITIVE_INFINITY);
    expect(overshootRatio(ZERO, ZERO)).toBe(0);
  });
});

describe('formatINR', () => {
  it('renders paise as rupees with Indian grouping', () => {
    expect(formatINR(paise(780000))).toBe('INR 7,800.00');
    expect(formatINR(paise(1999))).toBe('INR 19.99');
    expect(formatINR(paise(5))).toBe('INR 0.05');
  });
});
