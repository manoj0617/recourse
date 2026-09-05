import { describe, expect, it } from 'vitest';
import { evaluate } from './gate.js';
import { GateError, assertAllowToken, mintAllowToken, type AllowToken } from './verdict.js';
import { cartFingerprint } from '../ap2/checkout.js';
import {
  MERCHANT,
  NOW,
  OTHER_MERCHANT,
  makeAuth,
  makeCheckout,
  makeContext,
  makeHistory,
  stubJudge,
} from '../testing/fixtures.js';

const merchants = { type: 'checkout.allowed_merchants', allowed: [MERCHANT] };
const budget = { type: 'payment.budget', max: 800000, currency: 'INR' };
const intent = { type: 'recourse.semantic_intent', goal: 'a quiet hotel near the venue' };

describe('evaluate', () => {
  it('allows a purchase that satisfies every constraint', async () => {
    const verdict = await evaluate(
      makeAuth([merchants], [budget, intent]),
      makeContext({ judge: stubJudge() }),
      'txn_1',
    );
    expect(verdict.action).toBe('allow');
    expect(verdict.classification).toBe('conforming');
    expect(verdict.constraints).toHaveLength(3);
  });

  it('denies an expired authorisation before evaluating anything else', async () => {
    const verdict = await evaluate(
      makeAuth([merchants], [budget], { exp: NOW - 120 }),
      makeContext({ judge: stubJudge() }),
      'txn_1',
    );
    expect(verdict.action).toBe('deny');
    expect(verdict.classification).toBe('expired_mandate');
    // Nothing was evaluated: there is no live mandate to evaluate against.
    expect(verdict.constraints).toHaveLength(0);
  });

  it('expires on the earlier of the two mandates', async () => {
    const auth = makeAuth([merchants], [budget]);
    const halfDead = { ...auth, payment: { ...auth.payment, exp: NOW - 1 } };
    const verdict = await evaluate(halfDead, makeContext(), 'txn_1');
    expect(verdict.classification).toBe('expired_mandate');
  });

  it('reports the most severe violation as the classification', async () => {
    const verdict = await evaluate(
      makeAuth([merchants], [{ type: 'payment.budget', max: 100000, currency: 'INR' }]),
      makeContext({ checkout: makeCheckout({ merchant: OTHER_MERCHANT }) }),
      'txn_1',
    );
    // Both budget and merchant fail; merchant_substitution outranks price_drift.
    expect(verdict.action).toBe('deny');
    expect(verdict.classification).toBe('merchant_substitution');
    expect(verdict.reasons).toHaveLength(2);
  });

  it('holds rather than denying on a small budget overshoot', async () => {
    const verdict = await evaluate(
      makeAuth([], [{ type: 'payment.budget', max: 750000, currency: 'INR' }]),
      makeContext(),
      'txn_1',
    );
    expect(verdict.action).toBe('hold');
    expect(verdict.classification).toBe('price_drift');
  });

  it('holds when the model catches what the deterministic rules cannot', async () => {
    const judge = stubJudge({
      conformance: {
        status: 'ok',
        raw: '{}',
        value: {
          verdict: 'semantic_mismatch',
          clause: 'quiet',
          confidence: 0.9,
          rationale: 'the room is directly above a nightclub',
        },
      },
    });
    const verdict = await evaluate(
      makeAuth([merchants], [budget, intent]),
      makeContext({ judge }),
      'txn_1',
    );
    // Price and merchant are fine. Only the semantic constraint objects.
    expect(verdict.action).toBe('hold');
    expect(verdict.classification).toBe('semantic_mismatch');
    expect(verdict.usedNonDeterministicEvaluation).toBe(true);
  });

  it('holds when a constraint cannot be evaluated, and never treats that as a pass', async () => {
    const verdict = await evaluate(
      makeAuth([{ type: 'vendor.unknown_constraint' }], [budget]),
      makeContext(),
      'txn_1',
    );
    expect(verdict.action).toBe('hold');
    expect(verdict.classification).toBe('unsubstantiated');
  });

  it('catches a replayed cart that every other constraint permits', async () => {
    const history = makeHistory([
      { amount: 780000, at: NOW - 60, cartFingerprint: cartFingerprint(makeCheckout()) },
    ]);
    const verdict = await evaluate(
      makeAuth([merchants], [budget, { type: 'recourse.cart_replay', window_seconds: 600 }]),
      makeContext({ history, judge: stubJudge() }),
      'txn_1',
    );
    expect(verdict.action).toBe('deny');
    expect(verdict.classification).toBe('duplicate');
  });

  it('pins the judge configuration into the verdict so a ruling can be re-run', async () => {
    const verdict = await evaluate(
      makeAuth([], [intent]),
      makeContext({ judge: stubJudge() }),
      'txn_1',
    );
    expect(verdict.judge).toEqual({ model: 'stub-model', promptVersion: 'test-1' });
  });
});

describe('short-circuiting', () => {
  const denied = { type: 'payment.budget', max: 1000, currency: 'INR' };

  it('skips the model call in production when the outcome is already deny', async () => {
    const judge = stubJudge();
    await evaluate(makeAuth([], [denied, intent]), makeContext({ judge }), 'txn_1');
    expect(judge.calls).toBe(0);
  });

  // Without this, the corpus has no judge outcomes for rule-caught cases and the confusion
  // matrix silently measures the deterministic layer instead of the judge.
  it('evaluates every constraint when short-circuiting is off, as evals require', async () => {
    const judge = stubJudge();
    const verdict = await evaluate(
      makeAuth([], [denied, intent]),
      makeContext({ judge }),
      'txn_1',
      { shortCircuit: false },
    );
    expect(judge.calls).toBe(1);
    expect(verdict.constraints).toHaveLength(2);
  });
});

describe('AllowToken', () => {
  const allowVerdict = {
    action: 'allow' as const,
    transactionId: 'txn_1',
    constraints: [],
    classification: 'conforming' as const,
    reasons: [],
    evaluatedAt: NOW * 1000,
    usedNonDeterministicEvaluation: false,
  };

  it('is minted for an allow verdict', () => {
    const token = mintAllowToken(allowVerdict, makeCheckout().total, MERCHANT, 'hash');
    expect(() => assertAllowToken(token, 'refund')).not.toThrow();
  });

  it('cannot be minted for a hold or a deny', () => {
    for (const action of ['hold', 'deny'] as const) {
      expect(() =>
        mintAllowToken({ ...allowVerdict, action }, makeCheckout().total, MERCHANT, 'hash'),
      ).toThrow(GateError);
    }
  });

  // Types erase at runtime, so this is the case the compiler cannot catch on its own.
  it('rejects an object literal cast into the type', () => {
    const forged = {
      transactionId: 'txn_1',
      amount: 780000,
      payee: MERCHANT,
      verdictHash: 'hash',
      issuedAt: 0,
    } as unknown as AllowToken;
    expect(() => assertAllowToken(forged, 'createOrder')).toThrow(GateError);
  });

  it('rejects null and undefined without throwing something unhelpful', () => {
    expect(() => assertAllowToken(undefined as unknown as AllowToken, 'refund')).toThrow(GateError);
  });

  it('cannot be constructed outside the gate module', () => {
    // The `proof` symbol is module-private, so there is no literal that satisfies the type.
    // @ts-expect-error -- an object without `proof` is not an AllowToken
    const notTheType: AllowToken = {
      transactionId: 'txn_1',
      amount: makeCheckout().total,
      payee: MERCHANT,
      verdictHash: 'hash',
      issuedAt: 0,
    };
    expect(() => assertAllowToken(notTheType, 'createOrder')).toThrow(GateError);
  });
});
