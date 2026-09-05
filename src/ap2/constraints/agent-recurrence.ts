/**
 * AP2 v0.2 built-in: `payment.agent_recurrence`, with `type`, a `frequency` enum and an optional
 * `max_occurrences`.
 *
 * Two things this constraint governs: how often the mandate may be reused, and how many times in
 * total. A breach of either surfaces as `duplicate` in the taxonomy, because both mean "a charge
 * happened that should not have happened again". That mapping is a judgement call, so it is
 * written down here rather than left implicit in the code.
 */

import { z } from 'zod';
import { satisfied, violated, type ConstraintEvaluator, type MandateHistory } from './types.js';

export const RECURRENCE_FREQUENCIES = [
  'ON_DEMAND',
  'DAILY',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUALLY',
] as const;

export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** Period length in seconds. ON_DEMAND has no period: it constrains total count only. */
const PERIOD_SECONDS: Readonly<Record<Exclude<RecurrenceFrequency, 'ON_DEMAND'>, number>> = {
  DAILY: 86_400,
  WEEKLY: 604_800,
  BIWEEKLY: 1_209_600,
  MONTHLY: 2_592_000,
  QUARTERLY: 7_776_000,
  ANNUALLY: 31_536_000,
};

export const agentRecurrenceSchema = z
  .object({
    type: z.literal('payment.agent_recurrence'),
    frequency: z.enum(RECURRENCE_FREQUENCIES),
    max_occurrences: z.number().int().positive().optional(),
  })
  .strict();

export type AgentRecurrenceConstraint = z.infer<typeof agentRecurrenceSchema>;

function occurrencesSince(history: MandateHistory, since: number): number {
  return history.closedPayments.filter((p) => p.at > since).length;
}

export const agentRecurrence: ConstraintEvaluator<AgentRecurrenceConstraint> = {
  type: 'payment.agent_recurrence',
  schema: agentRecurrenceSchema,
  selectivelyDisclosable: ['frequency', 'max_occurrences'],
  deterministic: true,
  origin: 'ap2-v0.2',
  evaluate(constraint, ctx) {
    const total = ctx.history.closedPayments.length;

    if (constraint.max_occurrences !== undefined && total + 1 > constraint.max_occurrences) {
      return violated(
        'duplicate',
        `this would be use ${total + 1} of a mandate limited to ` +
          `${constraint.max_occurrences} occurrence(s)`,
      );
    }

    if (constraint.frequency === 'ON_DEMAND') {
      return satisfied(
        `ON_DEMAND imposes no periodic limit; ${total} prior use(s) within any occurrence cap`,
      );
    }

    // One use per period is the reading of a frequency given without an explicit per-period
    // count: a MONTHLY mandate authorises a monthly charge, not unlimited charges within a month.
    const used = occurrencesSince(ctx.history, ctx.now - PERIOD_SECONDS[constraint.frequency]);
    if (used >= 1) {
      return violated(
        'duplicate',
        `mandate is ${constraint.frequency} and has already been used ` +
          `${used} time(s) in the current period`,
      );
    }
    return satisfied(`no prior use in the current ${constraint.frequency} period`);
  },
};
