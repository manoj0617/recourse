import { describe, expect, it, vi } from 'vitest';
import { runAgent } from './agent.js';
import { executeTool, newSession } from './tools.js';
import type { AssistantMessage, Transport } from '../judge/transport.js';
import type { Verdict } from '../gate/verdict.js';
import { NOW } from '../testing/fixtures.js';

function call(name: string, args: unknown, id = `call_${name}`) {
  return {
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

/**
 * Replays a fixed sequence of assistant turns. No network.
 *
 * Past the end of the script it repeats the last turn, so a script ending in a tool call models a
 * model that will not stop -- which is what the exhaustion guard has to survive.
 */
function scriptedAgent(turns: readonly AssistantMessage[]): Transport & { seen: number } {
  const t = {
    mode: 'replay' as const,
    liveCalls: 0,
    seen: 0,
    async chat(): Promise<AssistantMessage> {
      const turn = turns[t.seen] ?? turns.at(-1) ?? { role: 'assistant' as const, content: 'done' };
      t.seen += 1;
      return turn;
    },
    async complete(): Promise<string> {
      return (await t.chat()).content ?? '';
    },
  };
  return t;
}

const allow: Verdict = {
  action: 'allow',
  transactionId: 'txn_1',
  constraints: [],
  classification: 'conforming',
  reasons: [],
  evaluatedAt: NOW * 1000,
  usedNonDeterministicEvaluation: false,
};

const deny: Verdict = {
  ...allow,
  action: 'deny',
  classification: 'price_drift',
  reasons: ['payment.budget: 74,500 over the 1,500 budget'],
};

describe('tools', () => {
  const ctx = (submit = vi.fn(async () => allow)) => ({
    session: newSession(),
    now: NOW,
    submit,
  });

  it('searches the catalogue and records what was looked at', async () => {
    const c = ctx();
    const out = await executeTool('searchCatalog', JSON.stringify({ query: 'notebook' }), c);
    expect(out).toMatch(/STAT-001/);
    // The trap: a laptop is also a "notebook".
    expect(out).toMatch(/ELEC-011/);
    expect(c.session.inspected.length).toBeGreaterThan(0);
  });

  it('builds a cart without checking anything the Gate is responsible for', async () => {
    const c = ctx();
    // 7,45,000 paise of laptop against any plausible stationery budget. Nothing objects here.
    const out = await executeTool(
      'proposeCart',
      JSON.stringify({ items: [{ sku: 'ELEC-011', quantity: 1 }] }),
      c,
    );
    expect(out).toMatch(/Not yet purchased/);
    expect(c.session.proposed?.total).toBe(7_450_000);
  });

  it('lets the agent propose absurd quantities, because that is the Gate\'s call', async () => {
    const c = ctx();
    await executeTool('proposeCart', JSON.stringify({ items: [{ sku: 'STAT-002', quantity: 99 }] }), c);
    expect(c.session.proposed?.total).toBe(18000 * 99);
  });

  it('refuses only what a Checkout cannot represent', async () => {
    const c = ctx();
    const spanning = await executeTool(
      'proposeCart',
      JSON.stringify({ items: [{ sku: 'STAT-001', quantity: 1 }, { sku: 'HOTEL-014', quantity: 1 }] }),
      c,
    );
    expect(spanning).toMatch(/cannot span merchants/);

    const unknown = await executeTool(
      'proposeCart',
      JSON.stringify({ items: [{ sku: 'NOPE-000', quantity: 1 }] }),
      c,
    );
    expect(unknown).toMatch(/no catalogue item/);
  });

  it('will not submit before a cart exists', async () => {
    const submit = vi.fn(async () => allow);
    const out = await executeTool('submitPurchase', '{}', ctx(submit));
    expect(out).toMatch(/no cart has been proposed/);
    expect(submit).not.toHaveBeenCalled();
  });

  it('routes submission through the injected Gate and reports the decision verbatim', async () => {
    const submit = vi.fn(async () => deny);
    const c = ctx(submit);
    await executeTool('proposeCart', JSON.stringify({ items: [{ sku: 'STAT-001', quantity: 1 }] }), c);
    const out = await executeTool('submitPurchase', '{}', c);
    expect(submit).toHaveBeenCalledOnce();
    expect(out).toMatch(/DENY \(price_drift\)/);
    expect(out).toMatch(/over the 1,500 budget/);
  });

  it('returns tool errors as text for the model to read rather than throwing', async () => {
    expect(await executeTool('proposeCart', 'not json', ctx())).toMatch(/not valid JSON/);
    expect(await executeTool('noSuchTool', '{}', ctx())).toMatch(/no tool named/);
  });
});

describe('runAgent', () => {
  it('runs search, propose and submit, then stops', async () => {
    const transport = scriptedAgent([
      call('searchCatalog', { query: 'notebook pens' }),
      call('proposeCart', { items: [{ sku: 'STAT-001', quantity: 1 }] }),
      call('submitPurchase', {}),
      { role: 'assistant', content: 'Bought one A5 notebook.' },
    ]);
    const submit = vi.fn(async () => allow);
    const run = await runAgent({
      transport,
      model: 'm',
      prompt: 'buy me a notebook',
      submit,
      now: NOW,
    });

    expect(run.verdict?.action).toBe('allow');
    expect(run.session.proposals).toHaveLength(1);
    expect(run.exhausted).toBe(false);
  });

  // Letting the agent retry after a refusal is how a retry loop is born.
  it('stops on a denial instead of trying again', async () => {
    const transport = scriptedAgent([
      call('proposeCart', { items: [{ sku: 'ELEC-011', quantity: 1 }] }),
      call('submitPurchase', {}),
      { role: 'assistant', content: 'The purchase was refused.' },
      call('proposeCart', { items: [{ sku: 'ELEC-011', quantity: 1 }] }),
    ]);
    const submit = vi.fn(async () => deny);
    const run = await runAgent({ transport, model: 'm', prompt: 'buy a laptop', submit, now: NOW });

    expect(submit).toHaveBeenCalledOnce();
    expect(run.verdict?.action).toBe('deny');
    expect(run.session.proposals).toHaveLength(1);
  });

  it('reports exhaustion rather than looping forever', async () => {
    const transport = scriptedAgent([call('searchCatalog', { query: 'pens' })]);
    const run = await runAgent({
      transport,
      model: 'm',
      prompt: 'buy pens',
      submit: vi.fn(async () => allow),
      now: NOW,
      maxTurns: 3,
    });
    expect(run.exhausted).toBe(true);
    expect(run.verdict).toBeUndefined();
  });

  it('stops when the model replies without calling a tool', async () => {
    const transport = scriptedAgent([{ role: 'assistant', content: 'I need more information.' }]);
    const run = await runAgent({
      transport,
      model: 'm',
      prompt: 'buy something',
      submit: vi.fn(async () => allow),
      now: NOW,
    });
    expect(run.turns).toBe(0);
    expect(run.verdict).toBeUndefined();
  });
});
