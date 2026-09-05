/**
 * The constraint extension point, made concrete.
 *
 * AP2 v0.2 states that defining a new constraint requires three things: "A uniquely defined
 * `type`. A Schema, including which fields are selectively disclosable. The evaluation algorithm."
 * A `ConstraintEvaluator` is exactly that triple, and the registry is the set of them a verifier
 * knows how to evaluate. AP2's five built-ins and Recourse's three extensions implement the same
 * interface, so nothing in the Gate can tell them apart -- which is the point.
 */

import type { z } from 'zod';
import type { Paise } from '../../money.js';
import type { Checkout, Merchant } from '../checkout.js';
import type { Action, ViolationClass } from '../../taxonomy.js';
import type { ConformanceJudge } from '../../judge/types.js';

/** What is being proposed, as opposed to what was authorised. */
export interface PaymentRequest {
  readonly amount: Paise;
  readonly payee: Merchant;
  readonly currency: 'INR';
}

/**
 * Everything already settled under this mandate. One record serves three constraints:
 * `payment.budget` sums the amounts, `payment.agent_recurrence` counts them and reads their
 * timestamps, and `recourse.cart_replay` compares fingerprints.
 */
export interface MandateHistory {
  readonly closedPayments: readonly {
    readonly amount: Paise;
    /** Epoch seconds. */
    readonly at: number;
    readonly cartFingerprint: string;
  }[];
}

export interface ConstraintContext {
  readonly checkout: Checkout;
  readonly payment: PaymentRequest;
  /** Epoch seconds. Injected rather than read from the clock so evaluation is reproducible. */
  readonly now: number;
  readonly history: MandateHistory;
  /** Only `recourse.semantic_intent` uses this. Absent means that constraint cannot be evaluated. */
  readonly judge?: ConformanceJudge | undefined;
}

/**
 * Three outcomes, not two.
 *
 * `indeterminate` is the reason this system does not fail open. A constraint that cannot be
 * evaluated -- no judge configured, a model that returned unparseable output twice, confidence
 * below threshold -- returns `indeterminate`, and the Gate turns that into a hold for a human.
 * Nothing anywhere converts an evaluation failure into a pass.
 */
export type ConstraintOutcome =
  | { readonly status: 'satisfied'; readonly reason: string }
  | {
      readonly status: 'violated';
      readonly reason: string;
      readonly classification: ViolationClass;
      /** 0..1 where the algorithm is probabilistic; absent where it is deterministic. */
      readonly confidence?: number;
      /**
       * Overrides DEFAULT_ACTION_BY_CLASS for this outcome. Used where severity varies within a
       * single class -- a budget overshoot of 2% and one of 300% are both `price_drift`, and only
       * the second is worth refusing outright. An evaluator that sets this must say why.
       */
      readonly action?: Action;
    }
  | {
      readonly status: 'indeterminate';
      readonly reason: string;
      readonly confidence?: number;
    };

export interface ConstraintEvaluator<C = unknown> {
  /** The uniquely defined `type`, e.g. `payment.budget` or `recourse.semantic_intent`. */
  readonly type: string;
  /**
   * The schema. The input side is `unknown` rather than `C` because schemas parse untrusted wire
   * data and may transform on the way in -- amounts arrive as JSON numbers and leave as `Paise`.
   */
  readonly schema: z.ZodType<C, z.ZodTypeDef, unknown>;
  /**
   * Which fields of this constraint are selectively disclosable, per AP2's requirement that an
   * extension declare them. Recorded honestly: selective disclosure is not implemented in this
   * codebase (see crypto/jws.ts), so this documents intent for a real deployment and nothing more.
   */
  readonly selectivelyDisclosable: readonly string[];
  /** True when two independent verifiers are guaranteed to reach the same outcome. */
  readonly deterministic: boolean;
  /** Where the constraint came from. Used by the README and the mapping doc, and by no logic. */
  readonly origin: 'ap2-v0.2' | 'recourse-extension';
  /** The evaluation algorithm. */
  evaluate(constraint: C, ctx: ConstraintContext): ConstraintOutcome | Promise<ConstraintOutcome>;
}

/**
 * A registry holds evaluators for constraints of different shapes, so the concrete constraint type
 * has to be erased somewhere. It is erased here, once, rather than with `any` at each use site.
 * `evaluate` takes `never` so that the only way to call it is through the registry, which parses
 * the constraint against `schema` first.
 */
export interface AnyConstraintEvaluator {
  readonly type: string;
  readonly schema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  readonly selectivelyDisclosable: readonly string[];
  readonly deterministic: boolean;
  readonly origin: ConstraintEvaluator['origin'];
  evaluate(
    constraint: never,
    ctx: ConstraintContext,
  ): ConstraintOutcome | Promise<ConstraintOutcome>;
}

export const satisfied = (reason: string): ConstraintOutcome => ({ status: 'satisfied', reason });

export const violated = (
  classification: ViolationClass,
  reason: string,
  extra: { readonly confidence?: number; readonly action?: Action } = {},
): ConstraintOutcome => ({
  status: 'violated',
  classification,
  reason,
  ...(extra.confidence === undefined ? {} : { confidence: extra.confidence }),
  ...(extra.action === undefined ? {} : { action: extra.action }),
});

export const indeterminate = (reason: string, confidence?: number): ConstraintOutcome =>
  confidence === undefined
    ? { status: 'indeterminate', reason }
    : { status: 'indeterminate', reason, confidence };
