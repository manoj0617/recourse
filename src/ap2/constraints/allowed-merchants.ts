/**
 * AP2 v0.2 built-in: `checkout.allowed_merchants`.
 * "Constrains the possible merchants for this Checkout Mandate."
 *
 * This constraint is AP2's, not ours. It is implemented here, not invented here.
 */

import { z } from 'zod';
import { merchantSchema } from '../checkout.js';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';

export const allowedMerchantsSchema = z
  .object({
    type: z.literal('checkout.allowed_merchants'),
    allowed: z.array(merchantSchema).min(1),
  })
  .strict();

export type AllowedMerchantsConstraint = z.infer<typeof allowedMerchantsSchema>;

export const allowedMerchants: ConstraintEvaluator<AllowedMerchantsConstraint> = {
  type: 'checkout.allowed_merchants',
  schema: allowedMerchantsSchema,
  selectivelyDisclosable: ['allowed'],
  deterministic: true,
  origin: 'ap2-v0.2',
  evaluate(constraint, ctx) {
    const actual = ctx.checkout.merchant;
    if (constraint.allowed.some((m) => m.id === actual.id)) {
      return satisfied(`checkout merchant ${actual.id} is on the allowed list`);
    }
    const names = constraint.allowed.map((m) => m.id).join(', ');
    return violated(
      'merchant_substitution',
      `checkout merchant ${actual.id} (${actual.name}) is not among the allowed merchants: ${names}`,
    );
  },
};
