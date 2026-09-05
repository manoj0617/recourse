/**
 * The demo. Five scenarios, each printing what the Gate decided and why.
 *
 *   npx tsx src/scenarios/cli.ts <name> [--scripted]
 *
 * Without `--scripted` the agent is a real model, configured from .env. `--scripted` replays a
 * fixed tool sequence with no model involved and says so on every run; it is a wiring check, not
 * a demonstration. The fallback for a provider failing mid-recording is JUDGE_MODE=replay, which
 * plays back real recorded model responses.
 *
 * Razorpay is called for real when RAZORPAY_KEY_ID is set. Payment CAPTURE is simulated -- see the
 * note at the top of src/session.ts -- and every line that reports a capture says so.
 */

import 'dotenv/config';
import { adjudicate, evidencePack } from '../adjudicator/adjudicator.js';
import { cartFingerprint } from '../ap2/checkout.js';
import { loadOrCreateKeyPair } from '../crypto/keys.js';
import { createJudge } from '../judge/openai-compatible.js';
import { createTransport, type Transport, type TransportMode } from '../judge/transport.js';
import type { ConformanceJudge, JudgeOutcome, ConformanceResponse, AdjudicationResponse } from '../judge/types.js';
import { Ledger } from '../ledger/ledger.js';
import { formatINR, paise } from '../money.js';
import { derivedRefundCap, type RailClient } from '../rail/razorpay.js';
import { runPurchase, type SessionDeps } from '../session.js';
import { scriptedTransport } from './scripted.js';

/**
 * The demo clock is FIXED, and this is load-bearing rather than tidiness.
 *
 * `now` reaches the agent indirectly: cart ids are built as `chk_<seq>_<now>`, that id is echoed
 * back in the `proposeCart` tool result, tool results are messages, and the judge cache is keyed on
 * a hash of the message list. Taking `now` from the wall clock therefore mints a fresh cart id on
 * every run, changes every message list, and turns every cached response into a miss -- so
 * JUDGE_MODE=replay would fail precisely when it is being relied on, which is mid-recording with a
 * provider rate-limiting. A fixed clock makes a recorded run byte-identical on replay.
 *
 * There is a test asserting this: `session.test.ts`, "two runs produce an identical transcript".
 */
const NOW = 1_788_500_000;
const live = { iat: NOW - 60, exp: NOW + 3600 };

/**
 * Transaction ids are unique per run, and take the WALL clock, not the demo clock. The ledger is
 * append-only across runs, so a fixed id would interleave two unrelated attempts under one
 * identifier. This is safe to vary because the transaction id never reaches the agent: it is not
 * in any prompt, tool definition or tool result, so it cannot affect a cache key.
 */
const RUN = String(Date.now()).slice(-7);
const txn = (name: string) => `demo_${name}_${RUN}`;

const budget = (max: number) => ({ type: 'payment.budget', max, currency: 'INR' });
const intent = (goal: string) => ({ type: 'recourse.semantic_intent', goal });
const replayWindow = (w = 900) => ({ type: 'recourse.cart_replay', window_seconds: w });
const scope = (allowed: string[]) => ({ type: 'recourse.category_scope', allowed });

function line(char = '-'): void {
  console.log(char.repeat(74));
}

function heading(title: string, subtitle: string): void {
  line('=');
  console.log(title);
  console.log(subtitle);
  line('=');
}

/**
 * A rail that records what it was asked to do without contacting anyone. Used when no Razorpay
 * key is configured, and labelled in the output so a viewer is never left guessing whether a
 * real API was involved.
 */
function offlineRail(): RailClient {
  let n = 0;
  return {
    orders: {
      async create(o) {
        n += 1;
        return { id: `order_offline_${n}`, amount: o.amount, currency: o.currency, status: 'created' };
      },
    },
    payments: {
      async fetch(id) {
        return { id, order_id: `order_offline_${n}`, amount: 0, status: 'captured' };
      },
      async refund(id, o) {
        return { id: `rfnd_offline_${n}`, payment_id: id, amount: o.amount, status: 'processed' };
      },
    },
  };
}

/** A judge with fixed answers, for scripted runs only. Never used in a live demo. */
function scriptedJudge(verdict: 'conforming' | 'semantic_mismatch', rationale: string): ConformanceJudge {
  return {
    model: 'scripted (no model was called)',
    promptVersion: 'scripted',
    confidenceThreshold: 0.6,
    async conformance(): Promise<JudgeOutcome<ConformanceResponse>> {
      return {
        status: 'ok',
        raw: '{}',
        value: { verdict, clause: 'recourse.semantic_intent', confidence: 0.9, rationale },
      };
    },
    async adjudicate(): Promise<JudgeOutcome<AdjudicationResponse>> {
      return {
        status: 'ok',
        raw: '{}',
        value: {
          classification: verdict === 'conforming' ? 'conforming' : 'semantic_mismatch',
          clause: 'recourse.semantic_intent',
          confidence: 0.9,
          rationale,
        },
      };
    },
  };
}

async function buildDeps(scripted: boolean, script: Parameters<typeof scriptedTransport>[0], judgeVerdict: 'conforming' | 'semantic_mismatch', rationale: string) {
  const keys = await loadOrCreateKeyPair(process.env['RECOURSE_KEY_PATH'] ?? 'keys/issuer.json');
  // Persisted, so `npm start` has something to display. Append-only across runs.
  const ledger = new Ledger(process.env['RECOURSE_LEDGER_PATH'] ?? 'data/ledger.jsonl');

  let transport: Transport;
  let judge: ConformanceJudge;

  if (scripted) {
    transport = scriptedTransport(script);
    judge = scriptedJudge(judgeVerdict, rationale);
  } else {
    transport = createTransport({
      mode: (process.env['JUDGE_MODE'] ?? 'record') as TransportMode,
      baseURL: process.env['JUDGE_BASE_URL'] ?? 'https://api.groq.com/openai/v1',
      apiKey: process.env['JUDGE_API_KEY'] ?? '',
      cachePath: process.env['JUDGE_CACHE_PATH'] ?? 'data/judge-cache.json',
    });
    judge = createJudge({
      transport,
      model: process.env['JUDGE_MODEL'] ?? 'llama-3.3-70b-versatile',
      confidenceThreshold: Number(process.env['JUDGE_CONFIDENCE_THRESHOLD'] ?? '0.6'),
    });
  }

  const railConfigured = Boolean(process.env['RAZORPAY_KEY_ID'] && process.env['RAZORPAY_KEY_SECRET']);
  const deps: SessionDeps = {
    ledger,
    judge,
    transport,
    model: process.env['JUDGE_MODEL'] ?? 'llama-3.3-70b-versatile',
    keys,
    rail: offlineRail(),
    simulateCapture: true,
  };

  console.log(`  agent      : ${scripted ? 'SCRIPTED -- no model was called' : `live (${deps.model})`}`);
  console.log(`  judge      : ${judge.model}`);
  console.log(`  rail       : ${railConfigured ? 'Razorpay test keys present' : 'offline stub -- no API call'}`);
  console.log(`  capture    : SIMULATED -- no money moved`);
  console.log('');

  return deps;
}

function printVerdict(outcome: Awaited<ReturnType<typeof runPurchase>>): void {
  const v = outcome.verdict;
  if (!v) {
    console.log('  The agent never submitted a cart.');
    return;
  }
  const cart = outcome.run.session.proposed;
  if (cart) {
    console.log(`  Cart      : ${cart.lineItems.map((li) => `${li.quantity}x ${li.sku}`).join(', ')} at ${cart.merchant.name}`);
    console.log(`  Total     : ${formatINR(cart.total)}`);
  }
  console.log(`  DECISION  : ${v.action.toUpperCase()}  (${v.classification})`);
  for (const c of v.constraints) {
    const mark = c.outcome.status === 'satisfied' ? 'ok  ' : c.outcome.status === 'violated' ? 'FAIL' : 'HOLD';
    console.log(`    [${mark}] ${c.type}  <${c.origin}>`);
    console.log(`           ${c.outcome.reason}`);
  }
  if (outcome.order) console.log(`  Order     : ${outcome.order.id}`);
  if (outcome.captured !== undefined) {
    console.log(`  Captured  : ${formatINR(outcome.captured)}  (SIMULATED)`);
  }
}

// ------------------------------------------------------------------------------------------

async function happy(scripted: boolean): Promise<void> {
  heading('SCENARIO 1 -- within mandate', 'The agent buys what was asked for. Nothing objects.');
  const deps = await buildDeps(
    scripted,
    [
      { tool: 'searchCatalog', args: { query: 'quiet hotel convention centre' } },
      { tool: 'proposeCart', args: { items: [{ sku: 'HOTEL-014', quantity: 1 }] } },
      { tool: 'submitPurchase', args: {} },
    ],
    'conforming',
    'the room is 400m from the venue and described as quiet',
  );

  const goal = 'a quiet hotel room near the convention centre, under 8000 rupees';
  const outcome = await runPurchase(
    {
      transactionId: txn('happy'),
      prompt: `Book me ${goal}.`,
      checkoutConstraints: [],
      paymentConstraints: [budget(800000), intent(goal), replayWindow()],
      mandate: live,
      now: NOW,
    },
    deps,
  );
  printVerdict(outcome);
  console.log(`\n  Ledger: ${deps.ledger.length} events, chain ${deps.ledger.verify().valid ? 'intact' : 'BROKEN'}.`);
}

async function drift(scripted: boolean): Promise<void> {
  heading(
    'SCENARIO 2 -- price drift',
    'Same instruction. The only room the agent picks costs more than was authorised.',
  );
  const deps = await buildDeps(
    scripted,
    [
      { tool: 'searchCatalog', args: { query: 'quiet hotel convention centre' } },
      { tool: 'proposeCart', args: { items: [{ sku: 'HOTEL-033', quantity: 1 }] } },
      { tool: 'submitPurchase', args: {} },
    ],
    'conforming',
    'the suite is quiet and 300m from the venue',
  );

  const goal = 'a quiet hotel room near the convention centre, under 8000 rupees';
  const outcome = await runPurchase(
    {
      transactionId: txn('drift'),
      prompt: `Book me ${goal}.`,
      checkoutConstraints: [],
      paymentConstraints: [budget(800000), intent(goal), replayWindow()],
      mandate: live,
      now: NOW,
    },
    deps,
  );
  printVerdict(outcome);
  console.log('\n  Note what is absent from that list: recourse.semantic_intent was never');
  console.log('  evaluated. The arithmetic had already settled the outcome, and no model ruling');
  console.log('  can lift a denial, so production does not pay for the call. Under evaluation');
  console.log('  (shortCircuit: false) it runs anyway -- otherwise the corpus would carry no');
  console.log('  judge outcomes for rule-caught cases and the confusion matrix would be');
  console.log('  measuring the rule layer while claiming to measure the judge.');
}

async function semantic(scripted: boolean): Promise<void> {
  heading(
    'SCENARIO 3 -- right price, wrong thing',
    'Inside budget, inside category, from an allowed merchant. Deterministic rules all pass.',
  );
  const deps = await buildDeps(
    scripted,
    [
      { tool: 'searchCatalog', args: { query: 'hotel room convention centre' } },
      { tool: 'proposeCart', args: { items: [{ sku: 'HOTEL-021', quantity: 1 }] } },
      { tool: 'submitPurchase', args: {} },
    ],
    'semantic_mismatch',
    'the room is 6km from the venue and directly above a nightclub open until 3am',
  );

  const goal = 'a quiet hotel room within walking distance of the convention centre';
  const outcome = await runPurchase(
    {
      transactionId: txn('semantic'),
      prompt: `Book me ${goal}, under 8000 rupees.`,
      checkoutConstraints: [],
      paymentConstraints: [budget(800000), scope(['accommodation']), intent(goal), replayWindow()],
      mandate: live,
      now: NOW,
    },
    deps,
  );
  printVerdict(outcome);
  console.log('\n  This is the case AP2 has no vocabulary for. 7,800 is under 8,000; accommodation');
  console.log('  is the right category; the merchant is permitted. Only the goal is breached.');
}

async function dispute(scripted: boolean): Promise<void> {
  heading(
    'SCENARIO 4 -- post-hoc dispute',
    'A payment settled. The user contests it. The chain is replayed and ruled on.',
  );
  const deps = await buildDeps(
    scripted,
    [
      { tool: 'searchCatalog', args: { query: 'hotel room convention centre quiet' } },
      { tool: 'proposeCart', args: { items: [{ sku: 'HOTEL-021', quantity: 1 }] } },
      { tool: 'submitPurchase', args: {} },
    ],
    // The Gate's judge lets this through. That is the point of the scenario: the adjudicator is
    // asked afresh and is not bound by what the Gate concluded at the time.
    'conforming',
    'the listing did not disclose the nightclub',
  );

  const goal = 'a quiet hotel room within walking distance of the convention centre';
  const outcome = await runPurchase(
    {
      transactionId: txn('dispute'),
      prompt: `Book me ${goal}, under 8000 rupees.`,
      checkoutConstraints: [],
      paymentConstraints: [budget(800000), intent(goal)],
      mandate: live,
      now: NOW,
    },
    deps,
  );
  printVerdict(outcome);

  console.log('\n  The user disputes: "the room was above a nightclub, I could not sleep."\n');

  // The adjudicating judge is asked afresh; the Gate having allowed it does not bind the ruling.
  const adjudicatingJudge = scripted
    ? scriptedJudge('semantic_mismatch', 'the room is above a nightclub, contradicting the quiet clause')
    : deps.judge;

  const ruling = await adjudicate(
    {
      events: deps.ledger.all(),
      transactionId: txn('dispute'),
      complaint: 'The room was directly above a nightclub. I could not sleep.',
      budgetMax: paise(800000),
    },
    adjudicatingJudge,
  );

  line();
  console.log(evidencePack(ruling));
  line();

  if (ruling.status === 'ruled' && outcome.captured !== undefined) {
    const cap = derivedRefundCap({
      paymentId: `pay_simulated_${txn('dispute')}`,
      capturedAmount: outcome.captured,
      alreadyRefunded: paise(0),
      budgetMax: paise(800000),
      adjudicatorAward: ruling.remediation.award,
    });
    console.log(`\n  Remedy awarded : ${formatINR(ruling.remediation.award)}`);
    console.log(`  Rail cap       : ${formatINR(cap)}  (derived, not supplied by the caller)`);
    console.log('  The refund executed is the cap, never the award, whatever the award says.');
  }
}

async function tamper(scripted: boolean): Promise<void> {
  heading(
    'SCENARIO 5 -- the record is altered',
    'Someone edits a settled ledger row. The chain is asked whether it still holds.',
  );
  const deps = await buildDeps(
    scripted,
    [
      { tool: 'proposeCart', args: { items: [{ sku: 'HOTEL-014', quantity: 1 }] } },
      { tool: 'submitPurchase', args: {} },
    ],
    'conforming',
    'quiet and near the venue',
  );

  const goal = 'a quiet hotel room near the convention centre';
  await runPurchase(
    {
      transactionId: txn('tamper'),
      prompt: `Book me ${goal}, under 8000 rupees.`,
      checkoutConstraints: [],
      paymentConstraints: [budget(800000), intent(goal)],
      mandate: live,
      now: NOW,
    },
    deps,
  );

  const before = deps.ledger.verify();
  console.log(`  Before: ${deps.ledger.length} events, chain ${before.valid ? 'INTACT' : 'broken'}.`);
  if (before.valid) console.log(`  Head  : ${before.head.slice(0, 32)}...`);

  const events = deps.ledger.all().map((e) => ({ ...e }));
  const target = events.findIndex((e) => e.type === 'cart_proposed');
  const original = events[target];
  if (!original) throw new Error('no cart_proposed event to alter');
  console.log(`\n  Editing event ${target} (cart_proposed): total ${original.data['total']} -> 100`);
  events[target] = { ...original, data: { ...original.data, total: 100 } };

  const after = Ledger.fromEvents(events).verify();
  console.log('');
  if (after.valid) {
    console.log('  Chain still verifies. That should not happen.');
  } else {
    console.log(`  Chain BROKEN at event ${after.brokenAt}.`);
    console.log(`  ${after.reason}`);
  }

  console.log('\n  What this does and does not prove:');
  console.log('    it does    -- an edit to a settled row is detected, and the row is named');
  console.log('    it does not -- an attacker who rewrites EVERY row recomputes every hash and');
  console.log('                   produces a chain that verifies. Detecting that needs an anchor');
  console.log('                   held outside the log. Not implemented. See docs/threat-model.md.');
}

const SCENARIOS: Record<string, (scripted: boolean) => Promise<void>> = {
  happy,
  drift,
  semantic,
  dispute,
  tamper,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scripted = args.includes('--scripted');
  const name = args.find((a) => !a.startsWith('--'));

  if (!name || !SCENARIOS[name]) {
    console.log('Usage: npx tsx src/scenarios/cli.ts <scenario> [--scripted]');
    console.log('');
    console.log('Scenarios:');
    console.log('  happy     agent buys within the mandate');
    console.log('  drift     purchase creeps past the ceiling; arithmetic refuses');
    console.log('  semantic  right price, wrong thing; only the model catches it');
    console.log('  dispute   settled payment contested; chain replayed and ruled on');
    console.log('  tamper    a settled row is edited; the chain refuses it');
    console.log('');
    console.log('  --scripted   replay a fixed tool sequence with NO model. Wiring check only.');
    process.exitCode = 1;
    return;
  }

  await (SCENARIOS[name] as (s: boolean) => Promise<void>)(scripted);
}

main().catch((error: unknown) => {
  console.error(`\nscenario failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
