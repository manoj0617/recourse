/**
 * The Checkout: what the merchant offers and what the agent proposes to buy.
 *
 * In AP2 v0.2 a closed Checkout Mandate carries a merchant-signed `checkout_jwt` and binds to it
 * with `checkout_hash`. We model the Checkout as its own signed compact JWS so that the hash
 * binding is real rather than decorative -- the hash is computed over the exact serialisation the
 * merchant signed, which is why `hashCompact` takes the compact string and never an object.
 */

import { z } from 'zod';
import { paise, type Paise, multiply, sum } from '../money.js';

/** AP2 refers to payees as Merchants in `payment.allowed_payees` and `checkout.allowed_merchants`. */
export const merchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type Merchant = z.infer<typeof merchantSchema>;

/**
 * Money crosses the schema boundary here and nowhere else. AP2 carries amounts as JSON numbers
 * alongside a `currency`; we refuse anything that is not a non-negative integer of minor units
 * rather than trusting the wire.
 */
export const amountSchema = z
  .number()
  .int('amount must be an integer number of minor units (paise)')
  .nonnegative()
  .transform((n): Paise => paise(n));

export const lineItemSchema = z.object({
  /** Stable item identifier. AP2 matches these against the acceptable-item sets of an open mandate. */
  sku: z.string().min(1),
  name: z.string().min(1),
  /** Not an AP2 field. Carried so `recourse.category_scope` has something to evaluate. */
  category: z.string().min(1),
  unitPrice: amountSchema,
  quantity: z.number().int().positive(),
  /** Free text the merchant supplies. The semantic judge reasons over this. */
  description: z.string().default(''),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const checkoutSchema = z.object({
  id: z.string().min(1),
  merchant: merchantSchema,
  lineItems: z.array(lineItemSchema).min(1),
  currency: z.literal('INR'),
  /**
   * The merchant's own stated total. Kept separate from the computed total on purpose: a
   * mismatch between the two is a merchant-side defect worth surfacing, not something to paper
   * over by recomputing silently.
   */
  total: amountSchema,
  createdAt: z.number().int().positive(),
});
export type Checkout = z.infer<typeof checkoutSchema>;

/** Sum of line items. Compare against `checkout.total` rather than replacing it. */
export function computedTotal(checkout: Checkout): Paise {
  return sum(checkout.lineItems.map((li) => multiply(li.unitPrice, li.quantity)));
}

export function totalsAgree(checkout: Checkout): boolean {
  return computedTotal(checkout) === checkout.total;
}

/**
 * A stable fingerprint of what is being bought, independent of the checkout id.
 *
 * This is the point of `recourse.cart_replay`: an agent stuck in a retry loop issues a fresh
 * checkout id every attempt, so deduplicating on the id catches nothing. Sorting by SKU makes the
 * fingerprint order-independent, since an agent rebuilding a cart need not rebuild it in order.
 */
export function cartFingerprint(checkout: Checkout): string {
  const items = checkout.lineItems
    .map((li) => `${li.sku}:${li.quantity}:${li.unitPrice}`)
    .sort()
    .join('|');
  return `${checkout.merchant.id}#${items}`;
}
