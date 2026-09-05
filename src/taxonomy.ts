/**
 * One taxonomy, used everywhere: constraint evaluators emit these, the adjudicator classifies into
 * these, and the corpus is labelled with these. Earlier drafts of this project carried two
 * competing lists; per-class precision and recall are meaningless against a taxonomy that shifts,
 * so there is exactly one and it lives here.
 */

import { z } from 'zod';

export const VIOLATION_CLASSES = [
  /** The purchase satisfied the mandate. The only non-violation label. */
  'conforming',
  /** Right thing, wrong price -- total exceeds what `payment.budget` allowed. */
  'price_drift',
  /** Item falls outside the categories the user scoped to. No AP2 vocabulary for this. */
  'category_violation',
  /** Price and category hold, but the item does not satisfy the stated goal. */
  'semantic_mismatch',
  /** An identical cart charged again, typically an agent retry loop. */
  'duplicate',
  /** Authorisation had lapsed before the money moved. */
  'expired_mandate',
  /** Bought from a payee the mandate did not allow. */
  'merchant_substitution',
  /**
   * The claim at issue is not established by the evidence.
   *
   * The claim differs by context, and both readings are the same predicate applied to whatever
   * was asserted:
   *   - at the Gate, the claim is "this purchase conforms". Unestablished -> hold. This is what a
   *     constraint that could not be evaluated produces: an unknown type, a malformed constraint,
   *     a semantic goal with no judge configured.
   *   - at the adjudicator, the claim is "this purchase was wrong". Unestablished -> no remedy.
   *
   * Kept as one label rather than split because it is one question -- did the evidence support
   * what was asserted -- and because a corpus cannot report per-class figures against a label
   * that means different things in different rows.
   */
  'unsubstantiated',
] as const;

export type ViolationClass = (typeof VIOLATION_CLASSES)[number];

export const violationClassSchema = z.enum(VIOLATION_CLASSES);

/**
 * What the Gate does about a verdict. Three actions, not eight -- the fine-grained class explains
 * the decision, this decides it.
 *
 * `hold` exists because the alternative to escalation is guessing, and a wrongly-blocked
 * legitimate purchase and a wrongly-allowed illegitimate one are different losses. Anything the
 * system cannot rule on confidently becomes a human's decision rather than a silent pass.
 */
export type Action = 'allow' | 'hold' | 'deny';

/**
 * Default mapping from class to action. Deliberately a policy table rather than logic: which
 * violations are worth stopping a transaction over is a business call, and a reviewer should be
 * able to read it in one place and disagree with it.
 */
export const DEFAULT_ACTION_BY_CLASS: Readonly<Record<ViolationClass, Action>> = {
  conforming: 'allow',
  // Small overshoots hold rather than deny; the size threshold lives in the budget evaluator.
  price_drift: 'hold',
  category_violation: 'deny',
  semantic_mismatch: 'hold',
  duplicate: 'deny',
  expired_mandate: 'deny',
  merchant_substitution: 'deny',
  unsubstantiated: 'hold',
};
