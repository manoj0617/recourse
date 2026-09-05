/**
 * Shared test fixtures. Not part of the running system.
 *
 * The stub judge exists so that every test in this repository runs with no network access at all.
 * Real model behaviour is measured by the eval harness against a labelled corpus, which is a
 * different question from whether the plumbing is correct, and mixing the two produces a test
 * suite that fails for reasons unrelated to the code.
 */

import type { z } from 'zod';
import { checkoutSchema, type Checkout } from '../ap2/checkout.js';
import type { ConstraintContext, MandateHistory } from '../ap2/constraints/types.js';
import type { Authorisation } from '../ap2/mandate.js';
import type {
  AdjudicationResponse,
  ConformanceJudge,
  ConformanceResponse,
  JudgeOutcome,
} from '../judge/types.js';
import { paise, type Paise } from '../money.js';

export const NOW = 1_757_000_000;

export const MERCHANT = { id: 'mrc_taj', name: 'Taj Hotels' };
export const OTHER_MERCHANT = { id: 'mrc_grey', name: 'Grey Market Stays' };

/**
 * Overrides are the schema's INPUT shape, not its output: amounts arrive as plain numbers and
 * become `Paise` on the way through `parse`. Taking `Partial<Checkout>` here would force every
 * test to brand its own literals, which is ceremony that tests nothing.
 */
export function makeCheckout(
  overrides: Partial<z.input<typeof checkoutSchema>> = {},
): Checkout {
  const base = {
    id: 'chk_1',
    merchant: MERCHANT,
    currency: 'INR' as const,
    createdAt: NOW,
    lineItems: [
      {
        sku: 'HOTEL-014',
        name: 'Deluxe Room, 1 night',
        category: 'accommodation',
        unitPrice: 780000,
        quantity: 1,
        description: 'Quiet room on the ninth floor, 400m from the convention centre.',
      },
    ],
    total: 780000,
  };
  return checkoutSchema.parse({ ...base, ...overrides });
}

export function makeHistory(
  closed: readonly { amount: number; at: number; cartFingerprint: string }[] = [],
): MandateHistory {
  return {
    closedPayments: closed.map((c) => ({
      amount: paise(c.amount) as Paise,
      at: c.at,
      cartFingerprint: c.cartFingerprint,
    })),
  };
}

export function makeContext(overrides: Partial<ConstraintContext> = {}): ConstraintContext {
  const checkout = overrides.checkout ?? makeCheckout();
  return {
    checkout,
    payment: { amount: checkout.total, payee: checkout.merchant, currency: 'INR' },
    now: NOW,
    history: makeHistory(),
    judge: undefined,
    ...overrides,
  };
}

/** An authorisation carrying whatever constraints a test wants to exercise. */
export function makeAuth(
  checkoutConstraints: readonly unknown[],
  paymentConstraints: readonly unknown[],
  times: { iat?: number; exp?: number } = {},
): Authorisation {
  const iat = times.iat ?? NOW - 60;
  const exp = times.exp ?? NOW + 3600;
  return {
    checkout: {
      vct: 'mandate.checkout.open.1',
      constraints: checkoutConstraints as { type: string }[],
      iat,
      exp,
    },
    payment: {
      vct: 'mandate.payment.open.1',
      constraints: paymentConstraints as { type: string }[],
      iat,
      exp,
    },
  };
}

export interface StubJudgeOptions {
  readonly conformance?: JudgeOutcome<ConformanceResponse>;
  readonly adjudication?: JudgeOutcome<AdjudicationResponse>;
  readonly confidenceThreshold?: number;
}

export function stubJudge(options: StubJudgeOptions = {}): ConformanceJudge & { calls: number } {
  const judge = {
    model: 'stub-model',
    promptVersion: 'test-1',
    confidenceThreshold: options.confidenceThreshold ?? 0.6,
    calls: 0,
    async conformance(): Promise<JudgeOutcome<ConformanceResponse>> {
      judge.calls += 1;
      return (
        options.conformance ?? {
          status: 'ok',
          raw: '{}',
          value: {
            verdict: 'conforming',
            clause: 'recourse.semantic_intent',
            confidence: 0.9,
            rationale: 'stub judge approves',
          },
        }
      );
    },
    async adjudicate(): Promise<JudgeOutcome<AdjudicationResponse>> {
      judge.calls += 1;
      return (
        options.adjudication ?? {
          status: 'ok',
          raw: '{}',
          value: {
            classification: 'conforming',
            clause: 'recourse.semantic_intent',
            confidence: 0.9,
            rationale: 'stub judge finds the purchase conforming',
          },
        }
      );
    },
  };
  return judge;
}
