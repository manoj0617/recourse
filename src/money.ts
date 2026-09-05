/**
 * Money is integer paise, always. No floats reach arithmetic, no floats reach the ledger,
 * and no float ever reaches Razorpay -- their API takes integer paise too.
 *
 * The brand exists so that a bare `number` cannot be passed where an amount is expected.
 * AP2's `payment.budget` constraint carries `max` as a JSON number plus a `currency`; we
 * narrow that to paise at the schema boundary (see ap2/mandate.ts) rather than trusting it.
 */

declare const paiseBrand: unique symbol;

/** An amount in integer paise. 100 paise = 1 rupee. */
export type Paise = number & { readonly [paiseBrand]: true };

export class MoneyError extends Error {}

/** Narrow a number to Paise. Throws on non-integers, negatives and non-finite values. */
export function paise(n: number): Paise {
  if (!Number.isFinite(n)) throw new MoneyError(`amount is not finite: ${n}`);
  if (!Number.isInteger(n)) throw new MoneyError(`amount is not an integer number of paise: ${n}`);
  if (n < 0) throw new MoneyError(`amount is negative: ${n}`);
  if (n > Number.MAX_SAFE_INTEGER) throw new MoneyError(`amount exceeds safe integer range: ${n}`);
  return n as Paise;
}

export const ZERO: Paise = paise(0);

/**
 * Convert rupees to paise. Accepts at most two decimal places.
 *
 * Rounding is deliberate rather than truncating: `19.99 * 100` is 1998.9999999999998 in
 * IEEE-754, and truncation would silently lose a paisa on ordinary catalogue prices.
 */
export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new MoneyError(`rupee amount is not finite: ${rupees}`);
  const scaled = Math.round(rupees * 100);
  if (Math.abs(scaled - rupees * 100) > 1e-6) {
    throw new MoneyError(`rupee amount has sub-paisa precision: ${rupees}`);
  }
  return paise(scaled);
}

export function add(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function sum(amounts: readonly Paise[]): Paise {
  return amounts.reduce<Paise>((acc, n) => add(acc, n), ZERO);
}

/** Saturating subtraction. Used for refund caps, where a negative remainder means "nothing left". */
export function subClamped(a: Paise, b: Paise): Paise {
  return paise(Math.max(0, a - b));
}

export function multiply(amount: Paise, quantity: number): Paise {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative integer: ${quantity}`);
  }
  return paise(amount * quantity);
}

export function min(...amounts: readonly Paise[]): Paise {
  if (amounts.length === 0) throw new MoneyError('min of no amounts');
  return amounts.reduce((a, b) => (a <= b ? a : b));
}

export function max(...amounts: readonly Paise[]): Paise {
  if (amounts.length === 0) throw new MoneyError('max of no amounts');
  return amounts.reduce((a, b) => (a >= b ? a : b));
}

/**
 * How far `actual` overshoots `ceiling`, as a fraction of the ceiling.
 * Returns 0 when within the ceiling. The Gate's budget tolerance is expressed in these terms.
 */
export function overshootRatio(actual: Paise, ceiling: Paise): number {
  if (ceiling === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY;
  return actual <= ceiling ? 0 : (actual - ceiling) / ceiling;
}

/** Display only. Never parse this back -- it is lossy by design (grouping separators). */
export function formatINR(amount: Paise): string {
  const rupees = Math.floor(amount / 100);
  const remainder = amount % 100;
  return `INR ${rupees.toLocaleString('en-IN')}.${String(remainder).padStart(2, '0')}`;
}
