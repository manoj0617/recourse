/**
 * Recourse extension: `recourse.semantic_intent`.
 *
 * This is the constraint the project exists for, and the only one that is not verifier-equivalent.
 *
 * AP2 v0.2 can express "under 8,000" (`payment.budget`), "from these merchants"
 * (`checkout.allowed_merchants`), and "one of these SKUs" (`checkout.line_items`). It cannot
 * express "a quiet hotel near the venue", because that is a judgement about whether a thing
 * satisfies a goal rather than a predicate over enumerable values. A 7,800 room six kilometres
 * away above a nightclub passes every AP2 constraint a user could reasonably have set, and does
 * not satisfy what they asked for.
 *
 * The extension point requires a `type`, a schema with selectively-disclosable fields, and an
 * evaluation algorithm. The algorithm here is an LLM, with the consequences handled explicitly:
 *
 *   - No judge configured  -> indeterminate, never satisfied.
 *   - Unparseable output   -> the judge escalates; indeterminate, never satisfied.
 *   - Confidence at or below the threshold -> indeterminate, never satisfied.
 *
 * There is no branch anywhere in this file that turns an evaluation failure into a pass.
 */

import { z } from 'zod';
import { formatINR } from '../../money.js';
import { computedTotal, type Checkout } from '../checkout.js';
import { indeterminate, satisfied, violated, type ConstraintEvaluator } from './types.js';

export const semanticIntentSchema = z
  .object({
    type: z.literal('recourse.semantic_intent'),
    /** The user's goal, in their own words. */
    goal: z.string().min(1),
    /**
     * Judgements at or below this confidence escalate rather than rule. Optional; when absent the
     * judge's own configured threshold applies.
     */
    confidence_threshold: z.number().min(0).max(1).optional(),
  })
  .strict();

export type SemanticIntentConstraint = z.infer<typeof semanticIntentSchema>;

/**
 * Render the cart for the model. Deliberately plain and complete: every field the judge is
 * allowed to reason over appears here, so what the model saw can be reconstructed from the
 * ledger rather than guessed at during a dispute.
 */
export function renderCart(checkout: Checkout): string {
  const lines = checkout.lineItems.map(
    (li) =>
      `- ${li.name} (sku ${li.sku}, category ${li.category}) x${li.quantity} @ ` +
      `${formatINR(li.unitPrice)}${li.description ? ` -- ${li.description}` : ''}`,
  );
  return [
    `Merchant: ${checkout.merchant.name} (${checkout.merchant.id})`,
    `Items:`,
    ...lines,
    `Total: ${formatINR(checkout.total)} (line items sum to ${formatINR(computedTotal(checkout))})`,
  ].join('\n');
}

export const semanticIntent: ConstraintEvaluator<SemanticIntentConstraint> = {
  type: 'recourse.semantic_intent',
  schema: semanticIntentSchema,
  selectivelyDisclosable: ['goal'],
  // False, and this is the honest answer to the sharpest question about this project: two
  // verifiers running this algorithm may disagree. Mitigations are reproducibility (model and
  // prompt version are pinned into the ledger), measurement (per-class precision and recall over
  // a labelled corpus) and escalation below threshold -- not a claim of determinism.
  deterministic: false,
  origin: 'recourse-extension',
  async evaluate(constraint, ctx) {
    const judge = ctx.judge;
    if (!judge) {
      return indeterminate(
        'no conformance judge is configured, so semantic intent cannot be evaluated',
      );
    }

    const outcome = await judge.conformance({
      goal: constraint.goal,
      cart: renderCart(ctx.checkout),
    });

    if (outcome.status === 'escalate') {
      return indeterminate(`judge could not produce a usable ruling: ${outcome.reason}`);
    }

    const { verdict, clause, confidence, rationale } = outcome.value;
    const threshold = constraint.confidence_threshold ?? judge.confidenceThreshold;

    if (confidence <= threshold) {
      return indeterminate(
        `judge returned ${verdict} at confidence ${confidence.toFixed(2)}, at or below the ` +
          `${threshold.toFixed(2)} threshold: ${rationale}`,
        confidence,
      );
    }

    return verdict === 'conforming'
      ? satisfied(`cart satisfies the stated goal (${clause}): ${rationale}`)
      : violated('semantic_mismatch', `${rationale} (clause relied on: ${clause})`, { confidence });
  },
};
