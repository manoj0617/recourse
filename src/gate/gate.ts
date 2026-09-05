/**
 * The Gate: nothing reaches the payment rail without passing through here.
 *
 * Order of work, and the reasons for it:
 *
 *   1. Expiry, before anything else. An expired authorisation is not a close call.
 *   2. Deterministic constraints. They are exact, free, and two of them -- budget and payee --
 *      settle most refusals on their own.
 *   3. Non-deterministic constraints. Only `recourse.semantic_intent`, and only if the run has
 *      not already been settled by step 2 and `shortCircuit` is on.
 *
 * `shortCircuit` is on in production and OFF during evaluation. This is not a performance knob.
 * If a denial by a deterministic rule skips the judge, the corpus yields no judge outcomes for
 * rule-caught cases, and the resulting confusion matrix is silently conditioned on the
 * deterministic layer rather than measuring the judge. Evals must see every constraint on every
 * case; production should not pay for a model call whose answer cannot change the action.
 */

import { evaluateConstraint, evaluatorFor, type EvaluatedConstraint } from '../ap2/constraints/registry.js';
import type { ConstraintContext } from '../ap2/constraints/types.js';
import { constraintsOf, expiryOf, type Authorisation } from '../ap2/mandate.js';
import type { Action, ViolationClass } from '../taxonomy.js';
import { actionForClass, moreSevere, type Verdict } from './verdict.js';

export interface GateOptions {
  /**
   * Skip constraints that can no longer change the outcome. True in production, false in evals.
   * See the note at the top of this file for why this is a correctness setting, not a speed one.
   */
  readonly shortCircuit?: boolean;
}

/** Severity ranking used to pick which violation gets reported as *the* classification. */
const CLASS_SEVERITY: Readonly<Record<ViolationClass, number>> = {
  conforming: 0,
  unsubstantiated: 1,
  semantic_mismatch: 2,
  price_drift: 3,
  duplicate: 4,
  category_violation: 5,
  merchant_substitution: 6,
  expired_mandate: 7,
};

function expiredVerdict(
  transactionId: string,
  evaluatedAt: number,
  expiredAgo: number,
): Verdict {
  return {
    action: 'deny',
    transactionId,
    constraints: [],
    classification: 'expired_mandate',
    reasons: [
      `authorisation expired ${expiredAgo}s before this attempt; no constraints were evaluated ` +
        `because there is no live mandate to evaluate them against`,
    ],
    evaluatedAt,
    usedNonDeterministicEvaluation: false,
  };
}

export async function evaluate(
  auth: Authorisation,
  ctx: ConstraintContext,
  transactionId: string,
  options: GateOptions = {},
): Promise<Verdict> {
  const shortCircuit = options.shortCircuit ?? true;
  const evaluatedAt = ctx.now * 1000;

  const expiry = expiryOf(auth);
  if (expiry < ctx.now) {
    return expiredVerdict(transactionId, evaluatedAt, ctx.now - expiry);
  }

  // Deterministic first. An unregistered type sorts with the deterministic group so that an
  // unknown constraint still forces a hold rather than being deferred behind a model call.
  const all = constraintsOf(auth);
  const isDeterministic = (type: string) => evaluatorFor(type)?.deterministic ?? true;
  const ordered = [
    ...all.filter((c) => isDeterministic(c.type)),
    ...all.filter((c) => !isDeterministic(c.type)),
  ];

  const results: EvaluatedConstraint[] = [];
  let action: Action = 'allow';
  let classification: ViolationClass = 'conforming';
  const reasons: string[] = [];

  for (const raw of ordered) {
    if (shortCircuit && action === 'deny' && !isDeterministic(raw.type)) {
      // A model call cannot lift a denial, so production does not pay for one.
      continue;
    }

    const evaluated = await evaluateConstraint(raw, ctx);
    results.push(evaluated);

    const outcome = evaluated.outcome;
    if (outcome.status === 'satisfied') continue;

    if (outcome.status === 'indeterminate') {
      // Cannot be evaluated is never treated as satisfied. It escalates.
      action = moreSevere(action, 'hold');
      reasons.push(`${evaluated.type}: ${outcome.reason}`);
      continue;
    }

    action = moreSevere(action, actionForClass(outcome.classification, outcome.action));
    if (CLASS_SEVERITY[outcome.classification] > CLASS_SEVERITY[classification]) {
      classification = outcome.classification;
    }
    reasons.push(`${evaluated.type}: ${outcome.reason}`);
  }

  // An indeterminate outcome with no violation still has to be classified as something, and
  // `conforming` would be a lie -- nothing confirmed conformance. It stays `conforming` only
  // when the action is allow; otherwise the hold is reported as unsubstantiated.
  if (action !== 'allow' && classification === 'conforming') {
    classification = 'unsubstantiated';
  }

  return {
    action,
    transactionId,
    constraints: results,
    classification,
    reasons,
    judge: ctx.judge ? { model: ctx.judge.model, promptVersion: ctx.judge.promptVersion } : undefined,
    evaluatedAt,
    usedNonDeterministicEvaluation: results.some((r) => !r.deterministic),
  };
}
