/**
 * The conformance judge: the evaluation algorithm behind `recourse.semantic_intent`, and the
 * classifier behind post-dispute adjudication.
 *
 * This is the one component that is not verifier-equivalent. AP2's extension point assumes an
 * independent verifier can re-run a constraint's algorithm and reach the same answer; the five
 * built-in constraints are deterministic and satisfy that, and this one does not. The honest
 * response, implemented rather than asserted:
 *
 *   1. `model` and `promptVersion` are pinned into every ledger event, so a run is at least
 *      reproducible even though it is not deterministic.
 *   2. Correctness is reported as per-class precision and recall over a labelled corpus, never
 *      claimed outright.
 *   3. Anything below `confidenceThreshold`, and anything that fails to parse, escalates to a
 *      human. There is no path from an unusable model response to an allowed payment.
 */

import { z } from 'zod';
import { violationClassSchema } from '../taxonomy.js';

/** Strict: unknown keys are a contract failure, not something to ignore. */
export const conformanceResponseSchema = z
  .object({
    /** Whether the cart satisfies the stated goal. */
    verdict: z.enum(['conforming', 'semantic_mismatch']),
    /** The specific mandate clause or constraint the judgement rests on. */
    clause: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
  })
  .strict();
export type ConformanceResponse = z.infer<typeof conformanceResponseSchema>;

export const adjudicationResponseSchema = z
  .object({
    classification: violationClassSchema,
    clause: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
  })
  .strict();
export type AdjudicationResponse = z.infer<typeof adjudicationResponseSchema>;

/**
 * A judge never throws for an unusable answer and never returns a default. It either produces a
 * validated response or says the case needs a human.
 */
export type JudgeOutcome<T> =
  | { readonly status: 'ok'; readonly value: T; readonly raw: string }
  | { readonly status: 'escalate'; readonly reason: string; readonly raw?: string };

export interface ConformanceInput {
  /** The natural-language goal from the `recourse.semantic_intent` constraint. */
  readonly goal: string;
  /** The cart, rendered for the model by the caller. */
  readonly cart: string;
}

export interface AdjudicationInput {
  /** The replayed evidence chain, rendered for the model by the caller. */
  readonly chain: string;
  readonly goal: string;
  /** What the user says is wrong. */
  readonly complaint: string;
}

export interface ConformanceJudge {
  /** Pinned into ledger events so a decision can be re-run against the same configuration. */
  readonly model: string;
  readonly promptVersion: string;
  /** Outcomes at or below this confidence escalate instead of ruling. */
  readonly confidenceThreshold: number;

  conformance(input: ConformanceInput): Promise<JudgeOutcome<ConformanceResponse>>;
  adjudicate(input: AdjudicationInput): Promise<JudgeOutcome<AdjudicationResponse>>;
}
