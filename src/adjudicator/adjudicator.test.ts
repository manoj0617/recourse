import { describe, expect, it } from 'vitest';
import { adjudicate, evidencePack, remediationFor } from './adjudicator.js';
import { renderChain, replay } from './replay.js';
import { Ledger } from '../ledger/ledger.js';
import type { LedgerEvent } from '../ledger/events.js';
import { paise } from '../money.js';
import { NOW, stubJudge } from '../testing/fixtures.js';

function settledChain(): LedgerEvent[] {
  const ledger = new Ledger();
  const t = { transactionId: 'txn_1' };
  ledger.append({
    ...t,
    type: 'user_prompt',
    at: NOW * 1000,
    data: { prompt: 'book me a quiet hotel under 8000 near the venue' },
  });
  ledger.append({
    ...t,
    type: 'mandate_issued',
    at: NOW * 1000 + 100,
    data: {
      constraints: [
        { type: 'payment.budget', max: 800000, currency: 'INR' },
        { type: 'recourse.semantic_intent', goal: 'a quiet hotel near the venue' },
      ],
    },
  });
  ledger.append({
    ...t,
    type: 'options_considered',
    at: NOW * 1000 + 200,
    data: { skus: ['HOTEL-014', 'HOTEL-021', 'HOTEL-033'] },
  });
  ledger.append({
    ...t,
    type: 'cart_proposed',
    at: NOW * 1000 + 300,
    data: {
      id: 'chk_1',
      merchant: 'OYO Rooms',
      total: 780000,
      items: [{ sku: 'HOTEL-021', name: 'Standard Room', quantity: 1, unitPrice: 780000 }],
    },
  });
  ledger.append({
    ...t,
    type: 'gate_verdict',
    at: NOW * 1000 + 400,
    data: { action: 'allow', classification: 'conforming', reasons: [], judgeModel: 'stub-model' },
  });
  ledger.append({
    ...t,
    type: 'rail_order_created',
    at: NOW * 1000 + 500,
    data: { orderId: 'order_1' },
  });
  ledger.append({
    ...t,
    type: 'rail_payment_captured',
    at: NOW * 1000 + 600,
    data: { paymentId: 'pay_1', amount: 780000 },
  });
  return [...ledger.all()];
}

describe('replay', () => {
  it('reconstructs the transaction from the chain alone', () => {
    const r = replay(settledChain());
    expect(r.transactionId).toBe('txn_1');
    expect(r.chain.valid).toBe(true);
    expect(r.goal).toBe('a quiet hotel near the venue');
    expect(r.constraints.map((c) => c.type)).toEqual([
      'payment.budget',
      'recourse.semantic_intent',
    ]);
    expect(r.optionsConsidered).toContain('HOTEL-033');
    expect(r.cart?.total).toBe(780000);
    expect(r.capturedAmount).toBe(780000);
    expect(r.refunded).toBe(0);
  });

  it('states absent facts as absent rather than dropping them', () => {
    const rendered = renderChain(replay([]));
    expect(rendered).toMatch(/User instruction: \(not recorded\)/);
    expect(rendered).toMatch(/Cart: \(not recorded\)/);
    expect(rendered).toMatch(/nothing captured/);
  });

  // Regression. A slice of a hash chain is not a chain: the sliced events have non-contiguous
  // `seq` values and their `prevHash` links point at other transactions' events. Verifying the
  // slice reported a break in an intact log, which made the adjudicator decline every dispute in
  // any ledger holding more than one transaction.
  it('verifies the whole log and then filters, not the other way round', () => {
    const ledger = Ledger.fromEvents(settledChain());
    ledger.append({
      transactionId: 'txn_2',
      type: 'user_prompt',
      at: NOW * 1000 + 800,
      data: { prompt: 'an unrelated purchase' },
    });
    ledger.append({
      transactionId: 'txn_1',
      type: 'dispute_opened',
      at: NOW * 1000 + 900,
      data: { complaint: 'noisy' },
    });

    const r = replay(ledger.all(), 'txn_1');
    expect(r.chain.valid).toBe(true);
    expect(r.transactionId).toBe('txn_1');
    // Only txn_1's events are reconstructed, even though the whole log was verified.
    expect(r.events.every((e) => e.transactionId === 'txn_1')).toBe(true);
    expect(r.events).toHaveLength(8);
    expect(r.capturedAmount).toBe(780000);
  });

  it('still catches a real break when several transactions share the log', async () => {
    const ledger = Ledger.fromEvents(settledChain());
    ledger.append({
      transactionId: 'txn_2',
      type: 'user_prompt',
      at: NOW * 1000 + 800,
      data: { prompt: 'an unrelated purchase' },
    });
    const events = ledger.all().map((e) => ({ ...e }));
    const target = events[1] as LedgerEvent;
    events[1] = { ...target, data: { ...target.data, tampered: true } };

    // The break is in txn_1, and a dispute about txn_2 must still refuse to be ruled on:
    // integrity is a property of the log, not of one transaction inside it.
    const ruling = await adjudicate(
      { events, transactionId: 'txn_2', complaint: 'x', budgetMax: paise(800000) },
      stubJudge(),
    );
    expect(ruling.status).toBe('escalated');
  });

  it('accumulates prior refunds so a payment cannot be returned twice', () => {
    const events = settledChain();
    const ledger = Ledger.fromEvents(events);
    ledger.append({
      transactionId: 'txn_1',
      type: 'refund_issued',
      at: NOW * 1000 + 700,
      data: { amount: 300000 },
    });
    expect(replay(ledger.all()).refunded).toBe(300000);
  });
});

describe('remediationFor', () => {
  const facts = { captured: paise(780000), budgetMax: paise(800000) };

  it('awards nothing when the purchase conformed', () => {
    expect(remediationFor('conforming', facts).award).toBe(0);
  });

  // The class that lets a dispute fail. Without it every complaint wins by construction.
  it('awards nothing when the complaint is unsubstantiated', () => {
    expect(remediationFor('unsubstantiated', facts).award).toBe(0);
  });

  it('returns only the excess on price drift, because the purchase itself was authorised', () => {
    const drifted = { captured: paise(950000), budgetMax: paise(800000) };
    expect(remediationFor('price_drift', drifted).award).toBe(150000);
  });

  it('returns nothing on price drift when the capture was within the ceiling', () => {
    expect(remediationFor('price_drift', facts).award).toBe(0);
  });

  it('returns the whole charge for violations that were not authorised in substance', () => {
    for (const c of [
      'duplicate',
      'expired_mandate',
      'merchant_substitution',
      'category_violation',
      'semantic_mismatch',
    ] as const) {
      expect(remediationFor(c, facts).award).toBe(780000);
    }
  });
});

describe('adjudicate', () => {
  const budgetMax = paise(800000);

  it('rules and sizes the remedy', async () => {
    const judge = stubJudge({
      adjudication: {
        status: 'ok',
        raw: '{}',
        value: {
          classification: 'semantic_mismatch',
          clause: 'quiet',
          confidence: 0.9,
          rationale: 'the room is directly above a nightclub',
        },
      },
    });
    const ruling = await adjudicate(
      { events: settledChain(), complaint: 'it was above a nightclub', budgetMax },
      judge,
    );

    expect(ruling.status).toBe('ruled');
    if (ruling.status === 'ruled') {
      expect(ruling.classification).toBe('semantic_mismatch');
      expect(ruling.remediation.award).toBe(780000);
    }
  });

  // The demo beat: mutate one row and the adjudicator refuses to rule at all.
  it('refuses to rule on a chain that does not verify', async () => {
    const events = settledChain().map((e) => ({ ...e }));
    const target = events[6] as LedgerEvent;
    events[6] = { ...target, data: { ...target.data, amount: 78000 } };

    const judge = stubJudge();
    const ruling = await adjudicate(
      { events, complaint: 'I was overcharged', budgetMax },
      judge,
    );

    expect(ruling.status).toBe('escalated');
    if (ruling.status === 'escalated') {
      expect(ruling.reason).toMatch(/does not verify/);
    }
    // The model is never even consulted about altered evidence.
    expect(judge.calls).toBe(0);
  });

  it('escalates when the model cannot produce a usable ruling', async () => {
    const judge = stubJudge({
      adjudication: { status: 'escalate', reason: 'unparseable output twice' },
    });
    const ruling = await adjudicate(
      { events: settledChain(), complaint: 'x', budgetMax },
      judge,
    );
    expect(ruling.status).toBe('escalated');
  });

  it('escalates a low-confidence ruling rather than acting on it', async () => {
    const judge = stubJudge({
      confidenceThreshold: 0.8,
      adjudication: {
        status: 'ok',
        raw: '{}',
        value: {
          classification: 'semantic_mismatch',
          clause: 'quiet',
          confidence: 0.4,
          rationale: 'hard to say',
        },
      },
    });
    const ruling = await adjudicate(
      { events: settledChain(), complaint: 'x', budgetMax },
      judge,
    );
    expect(ruling.status).toBe('escalated');
    if (ruling.status === 'escalated') expect(ruling.reason).toMatch(/threshold/);
  });

  // Note what this case also demonstrates: dropping the LAST event leaves a chain that still
  // verifies, because a truncated prefix is internally consistent. Tail truncation is only
  // detectable against an anchor held outside the log. See docs/threat-model.md.
  it('rules with a zero remedy when the chain shows nothing was captured', async () => {
    const events = settledChain().filter((e) => e.type !== 'rail_payment_captured');
    const ruling = await adjudicate(
      { events, complaint: 'x', budgetMax },
      stubJudge({
        adjudication: {
          status: 'ok',
          raw: '{}',
          value: {
            classification: 'semantic_mismatch',
            clause: 'quiet',
            confidence: 0.9,
            rationale: 'y',
          },
        },
      }),
    );
    expect(ruling.status).toBe('ruled');
    if (ruling.status === 'ruled') {
      expect(ruling.replayed.chain.valid).toBe(true);
      expect(ruling.replayed.capturedAmount).toBeUndefined();
      // Nothing was taken, so there is nothing to give back, whatever the classification.
      expect(ruling.remediation.award).toBe(0);
    }
  });
});

describe('evidencePack', () => {
  it('states the ruling, the remedy, the model, and the whole chain', async () => {
    const judge = stubJudge({
      adjudication: {
        status: 'ok',
        raw: '{}',
        value: {
          classification: 'semantic_mismatch',
          clause: 'quiet',
          confidence: 0.91,
          rationale: 'the room is above a nightclub',
        },
      },
    });
    const ruling = await adjudicate(
      { events: settledChain(), complaint: 'noisy', budgetMax: paise(800000) },
      judge,
    );
    const pack = evidencePack(ruling);

    expect(pack).toMatch(/Classification: semantic_mismatch/);
    expect(pack).toMatch(/Remedy: INR 7,800\.00/);
    expect(pack).toMatch(/stub-model/);
    expect(pack).toMatch(/not verifier-equivalent/);
    expect(pack).toMatch(/HOTEL-021/);
    expect(pack).toMatch(/Head hash:/);
  });

  it('says plainly that an escalation applied no remedy', async () => {
    const events = settledChain().map((e) => ({ ...e }));
    const target = events[3] as LedgerEvent;
    events[3] = { ...target, data: { ...target.data, total: 1 } };
    const pack = evidencePack(
      await adjudicate({ events, complaint: 'x', budgetMax: paise(800000) }, stubJudge()),
    );
    expect(pack).toMatch(/No automatic remedy was applied/);
    expect(pack).toMatch(/chain BROKEN/);
  });
});
