/**
 * What goes into the chain.
 *
 * The set is chosen so that a dispute can be replayed without consulting anything outside the
 * ledger: what the user asked for, what they authorised, what the agent considered, what it chose,
 * what the Gate decided and why, what the rail did, and what happened afterwards. If an event type
 * is missing here, that part of the story cannot be reconstructed later, which is the whole
 * failure mode this component exists to prevent.
 */

import { z } from 'zod';

export const EVENT_TYPES = [
  /** The user's instruction, in their words. */
  'user_prompt',
  /** An AP2 mandate was issued, with its constraints. Stores the compact JWS. */
  'mandate_issued',
  /** What the agent looked at before choosing. Without this, "it had no better option" is unfalsifiable. */
  'options_considered',
  /** The cart the agent settled on. */
  'cart_proposed',
  /** The Gate's ruling: action, per-constraint outcomes, and the judge configuration used. */
  'gate_verdict',
  /** A Razorpay order was created. Only ever after an allow verdict. */
  'rail_order_created',
  /** A payment reached a terminal state at the rail. */
  'rail_payment_captured',
  /** A webhook arrived and its signature was verified. */
  'webhook_received',
  /** The user contested a payment. */
  'dispute_opened',
  /** The adjudicator's ruling on a dispute. */
  'adjudication',
  /** A refund was executed, with the cap that bounded it. */
  'refund_issued',
  /** Something needed a human. Recorded so the exception list is a query, not a guess. */
  'escalated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z.enum(EVENT_TYPES);

/** The body of an event, before it is chained. */
export const eventInputSchema = z.object({
  type: eventTypeSchema,
  /** Groups every event belonging to one purchase attempt. */
  transactionId: z.string().min(1),
  /** Epoch milliseconds. Supplied by the caller so replays are reproducible. */
  at: z.number().int().nonnegative(),
  /** Event-specific payload. Deliberately unconstrained: the chain records, it does not interpret. */
  data: z.record(z.unknown()),
});

export type EventInput = z.infer<typeof eventInputSchema>;

/** An event after it has been chained. `hash` covers every other field, `prevHash` included. */
export const eventSchema = eventInputSchema.extend({
  seq: z.number().int().nonnegative(),
  prevHash: z.string(),
  hash: z.string(),
});

export type LedgerEvent = z.infer<typeof eventSchema>;
