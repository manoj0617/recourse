/**
 * The set of constraint types this verifier knows how to evaluate.
 *
 * AP2 v0.2 requires that a verifier "verify that the closed [Mandate] conforms to all of the
 * Constraints by evaluating each Constraint". "Each" is the load-bearing word: a constraint whose
 * type this build does not recognise cannot be skipped, because skipping it silently downgrades
 * an authorisation the user actually expressed. An unknown type is `indeterminate`, which the Gate
 * turns into a hold. That is the whole reason a registry exists here instead of a switch.
 */

import { z } from 'zod';
import { allowedMerchants } from './allowed-merchants.js';
import { allowedPayees } from './allowed-payees.js';
import { agentRecurrence } from './agent-recurrence.js';
import { budget } from './budget.js';
import { cartReplay } from './cart-replay.js';
import { categoryScope } from './category-scope.js';
import { lineItems } from './line-items.js';
import { semanticIntent } from './semantic-intent.js';
import {
  indeterminate,
  type AnyConstraintEvaluator,
  type ConstraintContext,
  type ConstraintOutcome,
} from './types.js';

/** AP2 v0.2 built-ins, implemented rather than invented. */
export const AP2_EVALUATORS: readonly AnyConstraintEvaluator[] = [
  allowedMerchants,
  lineItems,
  budget,
  agentRecurrence,
  allowedPayees,
];

/** Recourse extensions, defined through AP2's documented extension point. */
export const RECOURSE_EVALUATORS: readonly AnyConstraintEvaluator[] = [
  semanticIntent,
  categoryScope,
  cartReplay,
];

export const ALL_EVALUATORS: readonly AnyConstraintEvaluator[] = [
  ...AP2_EVALUATORS,
  ...RECOURSE_EVALUATORS,
];

const BY_TYPE = new Map<string, AnyConstraintEvaluator>(
  ALL_EVALUATORS.map((e) => [e.type, e]),
);

export function evaluatorFor(type: string): AnyConstraintEvaluator | undefined {
  return BY_TYPE.get(type);
}

/**
 * A constraint as it appears on the wire: an object with a `type`, whose remaining shape is the
 * business of the evaluator registered for that type. Kept loose here on purpose -- a mandate
 * carrying a constraint we cannot parse must still round-trip through the ledger intact so that a
 * later build, or a human, can read what the user actually authorised.
 */
export const rawConstraintSchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

export type RawConstraint = z.infer<typeof rawConstraintSchema>;

export interface EvaluatedConstraint {
  readonly type: string;
  readonly outcome: ConstraintOutcome;
  /** False for `recourse.semantic_intent`; true for everything else. */
  readonly deterministic: boolean;
  readonly origin: AnyConstraintEvaluator['origin'] | 'unknown';
}

/**
 * Evaluate one constraint. Every failure mode below resolves to `indeterminate`, never to
 * `satisfied`:
 *   - no evaluator registered for the type
 *   - the constraint does not match its own schema
 *   - the evaluator throws
 */
export async function evaluateConstraint(
  raw: RawConstraint,
  ctx: ConstraintContext,
): Promise<EvaluatedConstraint> {
  const evaluator = evaluatorFor(raw.type);
  if (!evaluator) {
    return {
      type: raw.type,
      deterministic: true,
      origin: 'unknown',
      outcome: indeterminate(
        `no evaluator is registered for constraint type "${raw.type}"; this verifier cannot ` +
          `confirm the mandate was honoured, so the decision is escalated rather than assumed`,
      ),
    };
  }

  const parsed = evaluator.schema.safeParse(raw);
  if (!parsed.success) {
    return {
      type: raw.type,
      deterministic: evaluator.deterministic,
      origin: evaluator.origin,
      outcome: indeterminate(
        `constraint "${raw.type}" does not match its schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      ),
    };
  }

  try {
    const outcome = await evaluator.evaluate(parsed.data as never, ctx);
    return {
      type: raw.type,
      deterministic: evaluator.deterministic,
      origin: evaluator.origin,
      outcome,
    };
  } catch (cause) {
    return {
      type: raw.type,
      deterministic: evaluator.deterministic,
      origin: evaluator.origin,
      outcome: indeterminate(
        `evaluator for "${raw.type}" threw: ${(cause as Error).message}`,
      ),
    };
  }
}
