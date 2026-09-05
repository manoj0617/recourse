/**
 * The payment rail. This is the only file in the project that moves money.
 *
 * Two properties are enforced here rather than asked for in a comment:
 *
 *   1. Nothing charges without a Gate verdict. Every mutating function requires an `AllowToken`,
 *      which cannot be constructed outside gate/verdict.ts, and asserts it at runtime because
 *      types erase. A call site that has not been through the Gate does not compile, and one that
 *      casts its way past the compiler fails before a request is built.
 *
 *   2. A refund cap is derived, never accepted. `refund` takes the facts -- what was captured,
 *      what the mandate allowed, what the adjudicator awarded, what has already been returned --
 *      and computes the bound itself. A cap supplied by the caller is a cap the caller can widen,
 *      which makes it decoration.
 *
 * The Razorpay SDK is reached through a narrow `RailClient` interface so the whole module is
 * testable offline. Razorpay also publishes an MCP server; it is deliberately not wired into the
 * agent, because giving the shopping agent direct rail access is precisely what the Gate exists
 * to prevent. See docs/threat-model.md.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { min, subClamped, type Paise } from '../money.js';
import { assertAllowToken, type AllowToken } from '../gate/verdict.js';

export class RailError extends Error {}

export interface RailOrder {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
}

export interface RailPayment {
  readonly id: string;
  readonly order_id: string;
  readonly amount: number;
  readonly status: string;
  readonly amount_refunded?: number;
}

export interface RailRefund {
  readonly id: string;
  readonly payment_id: string;
  readonly amount: number;
  readonly status: string;
}

/** The slice of the Razorpay SDK this project uses. */
export interface RailClient {
  orders: {
    create(options: {
      amount: number;
      currency: string;
      receipt: string;
      notes?: Record<string, string>;
    }): Promise<RailOrder>;
  };
  payments: {
    fetch(paymentId: string): Promise<RailPayment>;
    refund(paymentId: string, options: { amount: number; notes?: Record<string, string> }): Promise<RailRefund>;
  };
}

/**
 * Create an order for exactly the amount the Gate authorised.
 *
 * The amount comes off the token rather than from a parameter. Passing it separately would allow
 * a verdict for 7,800 to be spent as 78,000 by a caller that got its arguments in the wrong order,
 * and no test would catch it.
 */
export async function createOrder(
  client: RailClient,
  token: AllowToken,
  receipt: string,
): Promise<RailOrder> {
  assertAllowToken(token, 'createOrder');
  return client.orders.create({
    amount: token.amount,
    currency: 'INR',
    receipt,
    notes: {
      recourse_transaction_id: token.transactionId,
      recourse_verdict: token.verdictHash,
    },
  });
}

export async function fetchPayment(client: RailClient, paymentId: string): Promise<RailPayment> {
  return client.payments.fetch(paymentId);
}

/** Everything needed to bound a refund. All of it comes from the ledger or the rail, not a caller. */
export interface RefundBasis {
  readonly paymentId: string;
  /** What the rail says was actually captured. */
  readonly capturedAmount: Paise;
  /** What has already been returned against this payment. */
  readonly alreadyRefunded: Paise;
  /** `payment.budget.max` from the mandate that authorised the purchase. */
  readonly budgetMax: Paise;
  /** What the adjudicator ruled the user is owed. */
  readonly adjudicatorAward: Paise;
}

/**
 * The most that may be returned: the smallest of what is left of the capture, what the mandate
 * ever authorised, and what the adjudicator awarded.
 *
 * The mandate ceiling is in here as a second bound rather than because it is expected to bind --
 * a capture should never exceed the budget that authorised it. If it ever does, that is a defect
 * upstream, and this is where it stops being compounded by refunding the excess.
 */
export function derivedRefundCap(basis: RefundBasis): Paise {
  const remaining = subClamped(basis.capturedAmount, basis.alreadyRefunded);
  return min(remaining, basis.budgetMax, basis.adjudicatorAward);
}

/**
 * Execute a refund bounded by `derivedRefundCap`.
 *
 * Requires an allow token: a refund moves money, and every money movement in this system is
 * something the Gate ruled on. The token here attests to the adjudication that authorised the
 * remediation, not to the original purchase.
 */
export async function refund(
  client: RailClient,
  token: AllowToken,
  basis: RefundBasis,
): Promise<RailRefund> {
  assertAllowToken(token, 'refund');

  const amount = derivedRefundCap(basis);
  if (amount <= 0) {
    throw new RailError(
      `refund of ${basis.paymentId} would be zero after applying the derived cap ` +
        `(captured ${basis.capturedAmount}, already refunded ${basis.alreadyRefunded}, ` +
        `award ${basis.adjudicatorAward}); no request was sent`,
    );
  }

  return client.payments.refund(basis.paymentId, {
    amount,
    notes: { recourse_transaction_id: token.transactionId, recourse_verdict: token.verdictHash },
  });
}

/**
 * Verify a Razorpay webhook signature: HMAC-SHA256 over the RAW request body, hex encoded.
 *
 * Implemented directly rather than through the SDK helper so that the comparison is explicitly
 * timing-safe and so the raw-body requirement is visible. The body must be the exact bytes
 * received -- a body that has been through `JSON.parse` and back will not verify, and the
 * resulting "invalid signature" would send someone hunting for the wrong bug.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret) throw new RailError('no webhook secret configured; refusing to accept the webhook');

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}
