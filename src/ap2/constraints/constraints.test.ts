import { describe, expect, it } from 'vitest';
import { evaluateConstraint } from './registry.js';
import { HOLD_OVERSHOOT_TOLERANCE } from './budget.js';
import { cartFingerprint } from '../checkout.js';
import {
  MERCHANT,
  NOW,
  OTHER_MERCHANT,
  makeCheckout,
  makeContext,
  makeHistory,
  stubJudge,
} from '../../testing/fixtures.js';

describe('checkout.allowed_merchants', () => {
  const constraint = { type: 'checkout.allowed_merchants', allowed: [MERCHANT] };

  it('is satisfied by an allowed merchant', async () => {
    const r = await evaluateConstraint(constraint, makeContext());
    expect(r.outcome.status).toBe('satisfied');
    expect(r.origin).toBe('ap2-v0.2');
  });

  it('reports a substitution', async () => {
    const checkout = makeCheckout({ merchant: OTHER_MERCHANT });
    const r = await evaluateConstraint(constraint, makeContext({ checkout }));
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'merchant_substitution' });
  });
});

describe('payment.allowed_payees', () => {
  it('catches money going somewhere the cart did not', async () => {
    const ctx = makeContext({
      payment: { amount: makeCheckout().total, payee: OTHER_MERCHANT, currency: 'INR' },
    });
    const r = await evaluateConstraint(
      { type: 'payment.allowed_payees', allowed: [MERCHANT] },
      ctx,
    );
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'merchant_substitution' });
  });
});

describe('payment.budget', () => {
  const budget = (max: number) => ({ type: 'payment.budget', max, currency: 'INR' });

  it('allows a payment inside the ceiling', async () => {
    const r = await evaluateConstraint(budget(800000), makeContext());
    expect(r.outcome.status).toBe('satisfied');
  });

  // The spec rule this implements: requested + sum(previously closed) MUST be <= max.
  it('sums previously closed payments rather than checking each in isolation', async () => {
    const history = makeHistory([
      { amount: 300000, at: NOW - 500, cartFingerprint: 'a' },
      { amount: 300000, at: NOW - 400, cartFingerprint: 'b' },
    ]);
    // 7,800 alone is under the 8,000 ceiling; with 6,000 already spent it is not.
    const r = await evaluateConstraint(budget(800000), makeContext({ history }));
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'price_drift' });
    if (r.outcome.status === 'violated') expect(r.outcome.reason).toMatch(/already settled/);
  });

  it('holds a small overshoot and denies a large one', async () => {
    const justOver = Math.floor(780000 / (1 + HOLD_OVERSHOOT_TOLERANCE)) + 1;
    const held = await evaluateConstraint(budget(justOver), makeContext());
    expect(held.outcome).toMatchObject({ status: 'violated', action: 'hold' });

    const denied = await evaluateConstraint(budget(100000), makeContext());
    expect(denied.outcome).toMatchObject({ status: 'violated', action: 'deny' });
  });

  // A budget in a currency this build cannot settle is a refusal, not a question for a human:
  // comparing 8,000 USD against a total in paise would be arithmetic on incomparable numbers.
  it('denies on a currency mismatch instead of comparing incomparable numbers', async () => {
    const r = await evaluateConstraint(
      { type: 'payment.budget', max: 800000, currency: 'USD' },
      makeContext(),
    );
    expect(r.outcome).toMatchObject({
      status: 'violated',
      classification: 'price_drift',
      action: 'deny',
    });
  });

  it('escalates a currency that is not a currency code at all', async () => {
    const r = await evaluateConstraint(
      { type: 'payment.budget', max: 800000, currency: 'rupees' },
      makeContext(),
    );
    expect(r.outcome.status).toBe('indeterminate');
  });
});

describe('payment.agent_recurrence', () => {
  it('enforces max_occurrences across the mandate lifetime', async () => {
    const history = makeHistory([{ amount: 1000, at: NOW - 100000, cartFingerprint: 'a' }]);
    const r = await evaluateConstraint(
      { type: 'payment.agent_recurrence', frequency: 'ON_DEMAND', max_occurrences: 1 },
      makeContext({ history }),
    );
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'duplicate' });
  });

  it('allows an ON_DEMAND mandate with occurrences remaining', async () => {
    const r = await evaluateConstraint(
      { type: 'payment.agent_recurrence', frequency: 'ON_DEMAND', max_occurrences: 5 },
      makeContext({ history: makeHistory([{ amount: 1, at: NOW - 10, cartFingerprint: 'a' }]) }),
    );
    expect(r.outcome.status).toBe('satisfied');
  });

  it('treats a MONTHLY mandate as one use per period', async () => {
    const recent = makeHistory([{ amount: 1000, at: NOW - 86_400, cartFingerprint: 'a' }]);
    const r = await evaluateConstraint(
      { type: 'payment.agent_recurrence', frequency: 'MONTHLY' },
      makeContext({ history: recent }),
    );
    expect(r.outcome.status).toBe('violated');

    const old = makeHistory([{ amount: 1000, at: NOW - 5_000_000, cartFingerprint: 'a' }]);
    const r2 = await evaluateConstraint(
      { type: 'payment.agent_recurrence', frequency: 'MONTHLY' },
      makeContext({ history: old }),
    );
    expect(r2.outcome.status).toBe('satisfied');
  });
});

describe('checkout.line_items', () => {
  it('matches a required set against a cart unit', async () => {
    const r = await evaluateConstraint(
      { type: 'checkout.line_items', line_items: [{ acceptable_items: ['HOTEL-014'] }] },
      makeContext(),
    );
    expect(r.outcome.status).toBe('satisfied');
  });

  // The reason this is a matching and not a per-item `includes` check.
  it('does not let one unit satisfy two required sets', async () => {
    const r = await evaluateConstraint(
      {
        type: 'checkout.line_items',
        line_items: [{ acceptable_items: ['HOTEL-014'] }, { acceptable_items: ['HOTEL-014'] }],
      },
      makeContext(),
    );
    expect(r.outcome.status).toBe('violated');
  });

  it('treats quantity as capacity, so two units fill two sets', async () => {
    const checkout = makeCheckout({
      lineItems: [
        {
          sku: 'HOTEL-014',
          name: 'Deluxe Room',
          category: 'accommodation',
          unitPrice: 390000,
          quantity: 2,
          description: '',
        },
      ],
      total: 780000,
    });
    const r = await evaluateConstraint(
      {
        type: 'checkout.line_items',
        line_items: [{ acceptable_items: ['HOTEL-014'] }, { acceptable_items: ['HOTEL-014'] }],
      },
      makeContext({ checkout }),
    );
    expect(r.outcome.status).toBe('satisfied');
  });

  // The case a greedy first-fit gets wrong: assigning HOTEL-014 to the permissive set first
  // strands the restrictive set, even though a valid complete assignment exists.
  it('finds an assignment a greedy pass would miss', async () => {
    const checkout = makeCheckout({
      lineItems: [
        { sku: 'HOTEL-014', name: 'Room', category: 'accommodation', unitPrice: 390000, quantity: 1, description: '' },
        { sku: 'CAB-002', name: 'Airport cab', category: 'transport', unitPrice: 390000, quantity: 1, description: '' },
      ],
      total: 780000,
    });
    const r = await evaluateConstraint(
      {
        type: 'checkout.line_items',
        line_items: [
          { acceptable_items: ['HOTEL-014', 'CAB-002'] },
          { acceptable_items: ['HOTEL-014'] },
        ],
      },
      makeContext({ checkout }),
    );
    expect(r.outcome.status).toBe('satisfied');
  });

  it('refuses a cart padded with items outside every acceptable set', async () => {
    const checkout = makeCheckout({
      lineItems: [
        { sku: 'HOTEL-014', name: 'Room', category: 'accommodation', unitPrice: 390000, quantity: 1, description: '' },
        { sku: 'BAR-099', name: 'Minibar', category: 'food', unitPrice: 390000, quantity: 1, description: '' },
      ],
      total: 780000,
    });
    const r = await evaluateConstraint(
      { type: 'checkout.line_items', line_items: [{ acceptable_items: ['HOTEL-014'] }] },
      makeContext({ checkout }),
    );
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'category_violation' });
  });
});

describe('recourse.category_scope', () => {
  it('allows items inside the scope and refuses items outside it', async () => {
    const ok = await evaluateConstraint(
      { type: 'recourse.category_scope', allowed: ['accommodation'] },
      makeContext(),
    );
    expect(ok.outcome.status).toBe('satisfied');

    const bad = await evaluateConstraint(
      { type: 'recourse.category_scope', allowed: ['stationery'] },
      makeContext(),
    );
    expect(bad.outcome).toMatchObject({ status: 'violated', classification: 'category_violation' });
    expect(bad.origin).toBe('recourse-extension');
  });

  it('honours a denied list', async () => {
    const r = await evaluateConstraint(
      { type: 'recourse.category_scope', denied: ['accommodation'] },
      makeContext(),
    );
    expect(r.outcome.status).toBe('violated');
  });

  it('escalates a scope that constrains nothing rather than passing it', async () => {
    const r = await evaluateConstraint({ type: 'recourse.category_scope' }, makeContext());
    expect(r.outcome.status).toBe('indeterminate');
  });
});

describe('recourse.cart_replay', () => {
  const constraint = { type: 'recourse.cart_replay', window_seconds: 600 };

  it('passes a cart never seen before', async () => {
    const r = await evaluateConstraint(constraint, makeContext());
    expect(r.outcome.status).toBe('satisfied');
  });

  // The failure budget accumulation cannot catch: same cart, four times, still inside the ceiling.
  it('catches an identical cart charged again inside the window', async () => {
    const fingerprint = cartFingerprint(makeCheckout());
    const history = makeHistory([{ amount: 780000, at: NOW - 90, cartFingerprint: fingerprint }]);
    const r = await evaluateConstraint(constraint, makeContext({ history }));
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'duplicate' });
  });

  it('ignores an identical cart from outside the window', async () => {
    const fingerprint = cartFingerprint(makeCheckout());
    const history = makeHistory([{ amount: 780000, at: NOW - 6000, cartFingerprint: fingerprint }]);
    const r = await evaluateConstraint(constraint, makeContext({ history }));
    expect(r.outcome.status).toBe('satisfied');
  });

  it('fingerprints contents, not the checkout id, so a retry loop cannot evade it', () => {
    const a = makeCheckout({ id: 'chk_attempt_1' });
    const b = makeCheckout({ id: 'chk_attempt_2' });
    expect(cartFingerprint(a)).toBe(cartFingerprint(b));
  });
});

describe('recourse.semantic_intent', () => {
  const constraint = { type: 'recourse.semantic_intent', goal: 'a quiet hotel near the venue' };

  it('is satisfied when the judge rules conforming above threshold', async () => {
    const judge = stubJudge();
    const r = await evaluateConstraint(constraint, makeContext({ judge }));
    expect(r.outcome.status).toBe('satisfied');
    expect(r.deterministic).toBe(false);
  });

  it('is violated when the judge finds a mismatch', async () => {
    const judge = stubJudge({
      conformance: {
        status: 'ok',
        raw: '{}',
        value: {
          verdict: 'semantic_mismatch',
          clause: 'quiet',
          confidence: 0.88,
          rationale: 'the room is above a nightclub',
        },
      },
    });
    const r = await evaluateConstraint(constraint, makeContext({ judge }));
    expect(r.outcome).toMatchObject({ status: 'violated', classification: 'semantic_mismatch' });
  });

  // Fail-closed, asserted three ways.
  it('escalates when no judge is configured', async () => {
    const r = await evaluateConstraint(constraint, makeContext());
    expect(r.outcome.status).toBe('indeterminate');
  });

  it('escalates when the judge cannot produce a usable ruling', async () => {
    const judge = stubJudge({
      conformance: { status: 'escalate', reason: 'model returned unparseable output twice' },
    });
    const r = await evaluateConstraint(constraint, makeContext({ judge }));
    expect(r.outcome.status).toBe('indeterminate');
  });

  it('escalates a low-confidence ruling instead of acting on it', async () => {
    const judge = stubJudge({
      confidenceThreshold: 0.8,
      conformance: {
        status: 'ok',
        raw: '{}',
        value: { verdict: 'conforming', clause: 'quiet', confidence: 0.5, rationale: 'unsure' },
      },
    });
    const r = await evaluateConstraint(constraint, makeContext({ judge }));
    expect(r.outcome.status).toBe('indeterminate');
  });
});

describe('unknown constraint types', () => {
  // AP2 requires a verifier to evaluate EACH constraint. Skipping one silently downgrades an
  // authorisation the user actually expressed, so an unknown type escalates.
  it('escalate rather than being ignored', async () => {
    const r = await evaluateConstraint({ type: 'vendor.something_new' }, makeContext());
    expect(r.outcome.status).toBe('indeterminate');
    expect(r.origin).toBe('unknown');
  });
});
