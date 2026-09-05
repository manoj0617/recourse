/**
 * AP2 v0.2 built-in: `payment.budget`, with properties `type`, `max` and `currency`.
 *
 * The evaluation rule is the spec's, quoted so a reader can check this implementation against it:
 *
 *   "Evaluating the budget requires tracking the total amount spent using this Payment Mandate.
 *    For this constraint to evaluate as true, the requested amount plus the total sum of amounts
 *    from previously closed Payment Mandates MUST be less than or equal to `max`. After approval,
 *    the amount MUST be added to the accumulated total for future evaluation."
 *
 * Accumulation is the part that is easy to skip and expensive to skip: a mandate with an 8,000
 * ceiling that never sums prior spend authorises 8,000 per transaction rather than in total.
 */

import { z } from 'zod';
import { formatINR, overshootRatio, paise, sum, type Paise } from '../../money.js';
import { amountSchema } from '../checkout.js';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';

/**
 * Cumulative overshoot at or below this fraction of the ceiling holds for a human; anything
 * larger is denied outright.
 *
 * This threshold is a policy choice, not a fact. The right value depends on the cost asymmetry
 * between blocking a legitimate purchase and allowing an illegitimate one, which differs by
 * merchant and by ticket size. It is a named constant so that disagreeing with it is a one-line
 * change, and so a reviewer can find it without reading the algorithm.
 */
export const HOLD_OVERSHOOT_TOLERANCE = 0.1;

export const budgetSchema = z
  .object({
    type: z.literal('payment.budget'),
    max: amountSchema,
    /**
     * Any ISO-4217 code, not just INR. AP2 types this as a string, and pinning it to the one
     * currency this build settles would make a foreign-currency budget fail to parse -- which
     * escalates, when the correct answer is a flat refusal. A mandate denominated in a currency
     * we cannot settle is not an ambiguous case needing a human; it is a mismatch.
     */
    currency: z.string().length(3),
  })
  .strict();

export type BudgetConstraint = z.infer<typeof budgetSchema>;

export const budget: ConstraintEvaluator<BudgetConstraint> = {
  type: 'payment.budget',
  schema: budgetSchema,
  selectivelyDisclosable: ['max'],
  deterministic: true,
  origin: 'ap2-v0.2',
  evaluate(constraint, ctx) {
    if (ctx.payment.currency !== constraint.currency) {
      return violated(
        'price_drift',
        `payment currency ${ctx.payment.currency} does not match budget currency ${constraint.currency}`,
        { action: 'deny' },
      );
    }

    const alreadySpent: Paise = sum(ctx.history.closedPayments.map((p) => p.amount));
    const requested = ctx.payment.amount;
    const cumulative = paise(alreadySpent + requested);

    if (cumulative <= constraint.max) {
      return satisfied(
        `${formatINR(requested)} plus ${formatINR(alreadySpent)} already settled is within the ` +
          `${formatINR(constraint.max)} budget`,
      );
    }

    const overshoot = overshootRatio(cumulative, constraint.max);
    const detail =
      `${formatINR(requested)} plus ${formatINR(alreadySpent)} already settled is ` +
      `${formatINR(paise(cumulative - constraint.max))} over the ` +
      `${formatINR(constraint.max)} budget (${(overshoot * 100).toFixed(1)}% over)`;

    // Severity varies inside a single class, so the action is set explicitly here rather than
    // taken from the default policy table. The boundary is a choice; see the constant above.
    return overshoot <= HOLD_OVERSHOOT_TOLERANCE
      ? violated('price_drift', `${detail}; within hold tolerance, escalating`, { action: 'hold' })
      : violated('price_drift', `${detail}; beyond hold tolerance`, { action: 'deny' });
  },
};
