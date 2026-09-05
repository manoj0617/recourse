/**
 * AP2 v0.2 mandates.
 *
 * v0.2 defines two mandate types, not three. There is no Intent Mandate and no Cart Mandate --
 * those were v0.1 vocabulary, and using them would advertise that this consumes a superseded
 * version of the spec it claims to implement.
 *
 *   mandate.checkout.1       closed: binds to a merchant-signed Checkout JWT via `checkout_hash`
 *   mandate.checkout.open.1  open:   carries constraints instead of a fixed checkout
 *   mandate.payment.1        closed: `transaction_id`, `payee`, `payment_amount`, and the rest
 *
 * One inference is flagged rather than hidden: the vct for an OPEN payment mandate is written here
 * as `mandate.payment.open.1`, by symmetry with the checkout mandate. The spec states that the
 * open payment variant "may optionally include any of these properties" but the exact vct string
 * for it was not confirmed against the specification text. Everything else on this page was.
 */

import { z } from 'zod';
import { hashCompact, sign, verify } from '../crypto/jws.js';
import type { KeyPair } from '../crypto/keys.js';
import { amountSchema, merchantSchema, type Checkout } from './checkout.js';
import { rawConstraintSchema } from './constraints/registry.js';

export class MandateError extends Error {}

/** Claims every mandate carries. Times are epoch SECONDS, as in JWT. */
const baseClaims = {
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
};

export const openCheckoutMandateSchema = z
  .object({
    vct: z.literal('mandate.checkout.open.1'),
    /** `checkout.*` constraints. Evaluated by the registry, not interpreted here. */
    constraints: z.array(rawConstraintSchema),
    ...baseClaims,
  })
  .strict();
export type OpenCheckoutMandate = z.infer<typeof openCheckoutMandateSchema>;

export const closedCheckoutMandateSchema = z
  .object({
    vct: z.literal('mandate.checkout.1'),
    /** The merchant-signed Checkout, in its compact serialisation. */
    checkout_jwt: z.string().min(1),
    /** base64url SHA-256 over `checkout_jwt` exactly as serialised. */
    checkout_hash: z.string().min(1),
    ...baseClaims,
  })
  .strict();
export type ClosedCheckoutMandate = z.infer<typeof closedCheckoutMandateSchema>;

export const openPaymentMandateSchema = z
  .object({
    vct: z.literal('mandate.payment.open.1'),
    /** `payment.*` and `recourse.*` constraints. */
    constraints: z.array(rawConstraintSchema),
    ...baseClaims,
  })
  .strict();
export type OpenPaymentMandate = z.infer<typeof openPaymentMandateSchema>;

export const closedPaymentMandateSchema = z
  .object({
    vct: z.literal('mandate.payment.1'),
    transaction_id: z.string().min(1),
    payee: merchantSchema,
    /** Payment initiation service provider. Razorpay, here. */
    pisp: z.string().min(1),
    payment_amount: amountSchema,
    payment_instrument: z.string().min(1),
    /** Epoch seconds. */
    execution_date: z.number().int().nonnegative(),
    risk_data: z.record(z.unknown()).default({}),
    /** Binds the payment to the checkout it settles. */
    checkout_hash: z.string().min(1),
    ...baseClaims,
  })
  .strict();
export type ClosedPaymentMandate = z.infer<typeof closedPaymentMandateSchema>;

/**
 * What the user authorised: an open checkout mandate and an open payment mandate, held together.
 * The Gate evaluates the union of their constraints, because a decision needs both namespaces --
 * "from this merchant" lives on one and "under this much" on the other.
 */
export interface Authorisation {
  readonly checkout: OpenCheckoutMandate;
  readonly payment: OpenPaymentMandate;
}

export function constraintsOf(auth: Authorisation) {
  return [...auth.checkout.constraints, ...auth.payment.constraints];
}

/** The earlier of the two expiries. An authorisation is only as live as its shorter half. */
export function expiryOf(auth: Authorisation): number {
  return Math.min(auth.checkout.exp, auth.payment.exp);
}

// --- issuance -------------------------------------------------------------------------------

/** The merchant signs the Checkout. `checkout_hash` is taken over this exact string. */
export async function issueCheckoutJwt(
  checkout: Checkout,
  merchantKeys: KeyPair,
): Promise<string> {
  return sign({ ...checkout }, merchantKeys, 'checkout+jwt');
}

export async function issueOpenCheckoutMandate(
  constraints: readonly unknown[],
  userKeys: KeyPair,
  times: { iat: number; exp: number },
): Promise<string> {
  const mandate: OpenCheckoutMandate = openCheckoutMandateSchema.parse({
    vct: 'mandate.checkout.open.1',
    constraints,
    ...times,
  });
  return sign(mandate, userKeys, 'mandate+jwt');
}

export async function issueOpenPaymentMandate(
  constraints: readonly unknown[],
  userKeys: KeyPair,
  times: { iat: number; exp: number },
): Promise<string> {
  const mandate: OpenPaymentMandate = openPaymentMandateSchema.parse({
    vct: 'mandate.payment.open.1',
    constraints,
    ...times,
  });
  return sign(mandate, userKeys, 'mandate+jwt');
}

/**
 * Close a checkout mandate against a specific merchant-signed Checkout.
 *
 * The hash is computed over the compact JWT rather than a re-serialised object: re-serialising
 * changes key order, key order changes the hash, and the binding would then fail for a Checkout
 * nobody touched.
 */
export async function issueClosedCheckoutMandate(
  checkoutJwt: string,
  userKeys: KeyPair,
  times: { iat: number; exp: number },
): Promise<string> {
  const mandate: ClosedCheckoutMandate = {
    vct: 'mandate.checkout.1',
    checkout_jwt: checkoutJwt,
    checkout_hash: hashCompact(checkoutJwt),
    ...times,
  };
  return sign(mandate, userKeys, 'mandate+jwt');
}

// --- verification ---------------------------------------------------------------------------

export type MandateVerification<T> =
  | { readonly status: 'valid'; readonly mandate: T }
  | { readonly status: 'expired'; readonly mandate: T; readonly expiredAgo: number }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Verify a mandate's signature, shape and expiry, keeping the three apart.
 *
 * `expired` is a distinct status rather than a kind of `invalid` because they mean different
 * things and deserve different handling: a bad signature is a forgery and a lapsed `exp` is an
 * authorisation that ran out. Reporting the second as the first would accuse a user of fraud for
 * being slow.
 */
export async function verifyMandate<T>(
  compact: string,
  publicKey: Uint8Array,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  nowSeconds: number,
): Promise<MandateVerification<T>> {
  let payload: unknown;
  try {
    payload = (await verify(compact, publicKey)).payload;
  } catch (cause) {
    return { status: 'invalid', reason: (cause as Error).message };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: 'invalid',
      reason: `mandate does not match its schema: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    };
  }

  const exp = (parsed.data as { exp?: number }).exp;
  if (typeof exp === 'number' && exp < nowSeconds) {
    return { status: 'expired', mandate: parsed.data, expiredAgo: nowSeconds - exp };
  }
  return { status: 'valid', mandate: parsed.data };
}

/** Confirm a closed checkout mandate is bound to the Checkout it claims. */
export function checkoutBindingHolds(mandate: ClosedCheckoutMandate): boolean {
  return hashCompact(mandate.checkout_jwt) === mandate.checkout_hash;
}
