/**
 * AP2 v0.2 built-in: `payment.allowed_payees`, defining permitted payees in an `allowed` array
 * of Merchant objects.
 *
 * Distinct from `checkout.allowed_merchants` and deliberately evaluated separately: the merchant
 * a cart was assembled at and the payee the money actually reaches are not always the same party,
 * and a substitution between the two is exactly the case worth catching.
 */

import { z } from 'zod';
import { merchantSchema } from '../checkout.js';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';

export const allowedPayeesSchema = z
  .object({
    type: z.literal('payment.allowed_payees'),
    allowed: z.array(merchantSchema).min(1),
  })
  .strict();

export type AllowedPayeesConstraint = z.infer<typeof allowedPayeesSchema>;

export const allowedPayees: ConstraintEvaluator<AllowedPayeesConstraint> = {
  type: 'payment.allowed_payees',
  schema: allowedPayeesSchema,
  selectivelyDisclosable: ['allowed'],
  deterministic: true,
  origin: 'ap2-v0.2',
  evaluate(constraint, ctx) {
    const payee = ctx.payment.payee;
    if (constraint.allowed.some((m) => m.id === payee.id)) {
      return satisfied(`payee ${payee.id} is on the allowed list`);
    }
    const names = constraint.allowed.map((m) => m.id).join(', ');
    return violated(
      'merchant_substitution',
      `payee ${payee.id} (${payee.name}) is not among the allowed payees: ${names}`,
    );
  },
};
