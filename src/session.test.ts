import { describe, expect, it } from 'vitest';
import { runPurchase, type SessionDeps } from './session.js';
import { generateKeyPair } from './crypto/keys.js';
import { Ledger } from './ledger/ledger.js';
import type { AssistantMessage, ChatRequest, Transport } from './judge/transport.js';
import { cacheKey } from './judge/transport.js';
import { stubJudge } from './testing/fixtures.js';

const CLOCK = 1_788_500_000;

/** Replays a fixed tool sequence and records every request it was given. */
function recordingTransport(): Transport & { requests: ChatRequest[] } {
  const turns: AssistantMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'searchCatalog', arguments: JSON.stringify({ query: 'quiet hotel' }) },
        },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'proposeCart',
            arguments: JSON.stringify({ items: [{ sku: 'HOTEL-014', quantity: 1 }] }),
          },
        },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c3', type: 'function', function: { name: 'submitPurchase', arguments: '{}' } },
      ],
    },
    { role: 'assistant', content: 'Booked.' },
  ];

  let i = 0;
  const t = {
    mode: 'replay' as const,
    liveCalls: 0,
    requests: [] as ChatRequest[],
    async chat(request: ChatRequest): Promise<AssistantMessage> {
      t.requests.push(request);
      const turn = turns[i] ?? { role: 'assistant' as const, content: 'Booked.' };
      i += 1;
      return turn;
    },
    async complete(request: ChatRequest): Promise<string> {
      return (await t.chat(request)).content ?? '';
    },
  };
  return t;
}

/** A rail that answers without contacting anyone. */
function offlineRail() {
  return {
    orders: {
      async create(o: { amount: number; currency: string }) {
        return { id: 'order_test_1', amount: o.amount, currency: o.currency, status: 'created' };
      },
    },
    payments: {
      async fetch(id: string) {
        return { id, order_id: 'order_test_1', amount: 0, status: 'captured' };
      },
      async refund(id: string, o: { amount: number }) {
        return { id: 'rfnd_test_1', payment_id: id, amount: o.amount, status: 'processed' };
      },
    },
  };
}

async function deps(transport: Transport): Promise<SessionDeps> {
  return {
    ledger: new Ledger(),
    judge: stubJudge(),
    transport,
    model: 'test-model',
    keys: await generateKeyPair(),
    rail: offlineRail(),
    simulateCapture: true,
  };
}

const BUDGET_800 = { type: 'payment.budget', max: 800000, currency: 'INR' };
const TIGHT_BUDGET = { type: 'payment.budget', max: 1000, currency: 'INR' };
const INTENT = {
  type: 'recourse.semantic_intent',
  goal: 'a quiet hotel room near the venue',
};

const request = (transactionId: string) => ({
  transactionId,
  prompt: 'Book me a quiet hotel room near the venue, under 8000 rupees.',
  checkoutConstraints: [],
  paymentConstraints: [BUDGET_800, INTENT] as readonly { type: string }[],
  mandate: { iat: CLOCK - 60, exp: CLOCK + 3600 },
  now: CLOCK,
});

describe('runPurchase', () => {
  it('writes the whole story to the ledger in order, and the chain holds', async () => {
    const d = await deps(recordingTransport());
    const outcome = await runPurchase(request('txn_1'), d);

    expect(outcome.verdict?.action).toBe('allow');
    expect(d.ledger.verify().valid).toBe(true);
    expect(d.ledger.all().map((e) => e.type)).toEqual([
      'user_prompt',
      'mandate_issued',
      'options_considered',
      'cart_proposed',
      'gate_verdict',
      'rail_order_created',
      'rail_payment_captured',
    ]);
  });

  it('records what the agent looked at, so "it had no better option" is checkable', async () => {
    const d = await deps(recordingTransport());
    await runPurchase(request('txn_1'), d);
    const considered = d.ledger.all().find((e) => e.type === 'options_considered');
    // Whatever the search actually surfaced -- the point is that it was recorded at all, not
    // which rooms a substring search happened to rank.
    expect(considered?.data['skus']).toContain('HOTEL-014');
    expect((considered?.data['skus'] as string[]).length).toBeGreaterThan(1);
  });

  it('marks a simulated capture as simulated', async () => {
    const d = await deps(recordingTransport());
    await runPurchase(request('txn_1'), d);
    const capture = d.ledger.all().find((e) => e.type === 'rail_payment_captured');
    expect(capture?.data['simulated']).toBe(true);
  });

  /**
   * The property the emergency fallback depends on.
   *
   * A recorded run is replayable only if a later run asks the provider byte-identical questions.
   * `now` reaches the agent through cart ids echoed in tool results, so a wall-clock `now` mints a
   * fresh cart id per run, changes every message list, and turns every cached response into a miss
   * -- the replay cache would then fail exactly when it is reached for, mid-recording.
   */
  it('produces an identical transcript on a second run, so the replay cache hits', async () => {
    const first = recordingTransport();
    const second = recordingTransport();
    await runPurchase(request('txn_first'), await deps(first));
    // A different transaction id on purpose: it must not reach the agent.
    await runPurchase(request('txn_second'), await deps(second));

    expect(second.requests).toHaveLength(first.requests.length);
    for (const [i, req] of first.requests.entries()) {
      expect(JSON.stringify(second.requests[i]?.messages)).toBe(JSON.stringify(req.messages));
      expect(cacheKey(second.requests[i] as ChatRequest)).toBe(cacheKey(req));
    }
  });

  it('does not reach the rail when the Gate refuses', async () => {
    const transport = recordingTransport();
    const d = await deps(transport);
    let railCalled = false;
    const outcome = await runPurchase(
      {
        ...request('txn_deny'),
        paymentConstraints: [TIGHT_BUDGET] as readonly { type: string }[],
      },
      {
        ...d,
        rail: {
          orders: {
            async create() {
              railCalled = true;
              throw new Error('the rail must not be reached on a refusal');
            },
          },
          payments: {
            async fetch() {
              throw new Error('unused');
            },
            async refund() {
              throw new Error('unused');
            },
          },
        },
      },
    );

    expect(outcome.verdict?.action).toBe('deny');
    expect(outcome.token).toBeUndefined();
    expect(railCalled).toBe(false);
    expect(d.ledger.all().some((e) => e.type === 'escalated')).toBe(true);
  });
});
