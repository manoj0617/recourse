/**
 * Recourse extension: `recourse.cart_replay`.
 *
 * Why it exists, stated precisely, because `payment.budget` looks like it already covers this and
 * does not: budget accumulation catches repeated spend once the total breaches `max`. It cannot
 * catch an agent that charges the same 500 cart four times inside an 8,000 budget. Every
 * individual charge is authorised, the cumulative total is authorised, and the user has still been
 * billed four times for one thing. AP2 has no constraint for it.
 *
 * The fingerprint is over merchant and sorted (SKU, quantity, price) tuples, never the checkout
 * id -- an agent in a retry loop mints a fresh checkout id on every attempt, so deduplicating on
 * the id catches exactly nothing. See `cartFingerprint` in ../checkout.ts.
 */

import { z } from 'zod';
import { cartFingerprint } from '../checkout.js';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';

export const cartReplaySchema = z
  .object({
    type: z.literal('recourse.cart_replay'),
    /**
     * How long an identical cart stays suspicious. A window rather than "ever" because buying
     * the same groceries next week is ordinary, and buying them again ninety seconds later is not.
     */
    window_seconds: z.number().int().positive(),
  })
  .strict();

export type CartReplayConstraint = z.infer<typeof cartReplaySchema>;

export const cartReplay: ConstraintEvaluator<CartReplayConstraint> = {
  type: 'recourse.cart_replay',
  schema: cartReplaySchema,
  selectivelyDisclosable: ['window_seconds'],
  deterministic: true,
  origin: 'recourse-extension',
  evaluate(constraint, ctx) {
    const fingerprint = cartFingerprint(ctx.checkout);
    const since = ctx.now - constraint.window_seconds;
    const priors = ctx.history.closedPayments.filter(
      (p) => p.at > since && p.cartFingerprint === fingerprint,
    );

    if (priors.length === 0) {
      return satisfied(
        `no identical cart settled in the last ${constraint.window_seconds}s ` +
          `(fingerprint ${fingerprint})`,
      );
    }

    const agoSeconds = Math.max(...priors.map((p) => ctx.now - p.at));
    return violated(
      'duplicate',
      `an identical cart was already settled ${priors.length} time(s) within the last ` +
        `${constraint.window_seconds}s, most recently ${agoSeconds}s ago ` +
        `(fingerprint ${fingerprint})`,
    );
  },
};
