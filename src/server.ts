/**
 * The console: start a purchase, watch the Gate decide, dispute the result.
 *
 * Server-rendered HTML, no client-side JavaScript, no build step. Progress during a live run is
 * shown with a `<meta http-equiv="refresh">` on the transaction page: the ledger is append-only and
 * events land as they happen, so each poll shows one more step. That is a better thing to film than
 * a spinner, and it costs nothing.
 *
 * Rendering lives in `src/views/`. This file is routes, state and the run lifecycle; it builds no
 * HTML of its own beyond assembling the pieces those modules return.
 *
 * On "read-only": this console cannot edit or delete anything, and that is the property that
 * matters. It CAN start a new purchase, which appends through exactly the same path the CLI uses --
 * appending a transaction is not mutating history. The tamper view computes a corrupted chain on a
 * COPY in memory and never writes it.
 *
 * The rail is the offline stub and capture is simulated, the same as the CLI, and every page that
 * reports a capture says so.
 *
 *   npm start        # reads RECOURSE_LEDGER_PATH
 */

import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { adjudicate, evidencePack } from './adjudicator/adjudicator.js';
import { renderChain, replay } from './adjudicator/replay.js';
import { loadOrCreateKeyPair, type KeyPair } from './crypto/keys.js';
import { createJudge } from './judge/openai-compatible.js';
import { createTransport, type TransportMode } from './judge/transport.js';
import { Ledger } from './ledger/ledger.js';
import type { LedgerEvent } from './ledger/events.js';
import { paise, type Paise } from './money.js';
import { runPurchase } from './session.js';
import { DEMO_NOW, SCENARIOS, budget } from './scenarios/definitions.js';
import type { RailClient } from './rail/razorpay.js';
import { escapeHtml, page } from './views/html.js';
import { breakableId, chainLine, decisionPill, simBadge, statusClass, verdictBlock } from './views/format.js';
import { constraintTable } from './views/constraints.js';
import { renderSteps } from './views/steps.js';
import { eventsTable } from './views/events.js';
import { adjudicationBlock } from './views/pack.js';

const LEDGER_PATH = process.env['RECOURSE_LEDGER_PATH'] ?? 'data/ledger.jsonl';
const PORT = Number(process.env['PORT'] ?? '3000');
const MODEL = process.env['JUDGE_MODEL'] ?? 'llama-3.3-70b-versatile';

function loadLedger(): Ledger | null {
  if (!existsSync(LEDGER_PATH)) return null;
  return new Ledger(LEDGER_PATH);
}

function allEvents(): readonly LedgerEvent[] {
  return loadLedger()?.all() ?? [];
}

/** The ceiling this transaction was actually authorised under, read back out of the ledger. */
function budgetMaxOf(events: readonly LedgerEvent[], id: string): Paise {
  const issued = events.find((e) => e.transactionId === id && e.type === 'mandate_issued');
  const constraints = issued?.data['constraints'];
  if (!Array.isArray(constraints)) return paise(0);
  const found = (constraints as { type?: string; max?: unknown }[]).find(
    (c) => c.type === 'payment.budget',
  );
  return typeof found?.max === 'number' ? paise(found.max) : paise(0);
}

// --- live runs ---------------------------------------------------------------------------------

type RunState = { status: 'running' } | { status: 'done' } | { status: 'error'; message: string };

/** In-flight work, so the transaction page knows whether to keep polling. */
const runs = new Map<string, RunState>();

/** No API call. Mirrors the CLI, so the console cannot quietly move real money. */
function offlineRail(): RailClient {
  let n = 0;
  return {
    orders: {
      async create(o) {
        n += 1;
        return { id: `order_web_${n}`, amount: o.amount, currency: o.currency, status: 'created' };
      },
    },
    payments: {
      async fetch(id) {
        return { id, order_id: `order_web_${n}`, amount: 0, status: 'captured' };
      },
      async refund(id, o) {
        return { id: `rfnd_web_${n}`, payment_id: id, amount: o.amount, status: 'processed' };
      },
    },
  };
}

function buildJudgeAndTransport() {
  const transport = createTransport({
    mode: (process.env['JUDGE_MODE'] ?? 'record') as TransportMode,
    baseURL: process.env['JUDGE_BASE_URL'] ?? 'https://api.groq.com/openai/v1',
    apiKey: process.env['JUDGE_API_KEY'] ?? '',
    cachePath: process.env['JUDGE_CACHE_PATH'] ?? 'data/judge-cache.json',
  });
  const judge = createJudge({
    transport,
    model: MODEL,
    confidenceThreshold: Number(process.env['JUDGE_CONFIDENCE_THRESHOLD'] ?? '0.6'),
  });
  return { transport, judge };
}

let keysPromise: Promise<KeyPair> | undefined;
function keys(): Promise<KeyPair> {
  keysPromise ??= loadOrCreateKeyPair(process.env['RECOURSE_KEY_PATH'] ?? 'keys/issuer.json');
  return keysPromise;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- index -------------------------------------------------------------------------------------

app.get('/', (_req, res) => {
  const events = allEvents();
  const ledger = loadLedger();
  const ids = [...new Set(events.map((e) => e.transactionId))].reverse();

  const options = Object.values(SCENARIOS)
    .map(
      (s) =>
        `<option value="${s.name}"${s.name === 'unguarded' ? ' selected' : ''}>` +
        `${escapeHtml(s.title)} - ${escapeHtml(s.subtitle)}</option>`,
    )
    .join('');

  const rows = ids
    .map((id) => {
      const r = replay(events, id);
      const state = runs.get(id);
      const action = state?.status === 'running' ? 'running' : (r.verdict?.action ?? 'no verdict');
      return `<tr>
        <td class="mono"><a class="plain" href="/t/${encodeURIComponent(id)}">${breakableId(id)}</a></td>
        <td>${escapeHtml(r.cart?.merchant ?? '-')}</td>
        <td class="num">${r.cart ? (r.cart.total / 100).toFixed(2) : '-'}</td>
        <td>${decisionPill(action)}</td>
        <td>${escapeHtml(r.verdict?.classification ?? '-')}</td>
        <td class="hash">${r.events.length}</td>
      </tr>`;
    })
    .join('');

  const chain = ledger?.verify();
  const chainText = !chain
    ? '<span class="faint">no ledger yet</span>'
    : chain.valid
      ? `chain <span class="ok">INTACT</span> <span class="faint">across ${chain.length} events</span>` +
        `<span class="hash">head ${escapeHtml(chain.head.slice(0, 32))}...</span>`
      : `chain <span class="bad">BROKEN at event ${chain.brokenAt}</span>` +
        `<span class="bad">${escapeHtml(chain.reason)}</span>`;

  res.send(
    page(
      'Recourse console',
      `<h1>Recourse</h1>
       <p class="sub">An adjudication layer for agent-initiated payments.</p>
       <div class="stat-strip"><span>${events.length} events</span><span>${ids.length} transaction(s)</span>${chainText}</div>

       <h2>Start a purchase</h2>
       <form method="post" action="/run">
         <label for="scenario">scenario</label>
         <select id="scenario" name="scenario">${options}</select>
         <div class="row">
           <div><label for="prompt">override the instruction (optional)</label>
             <input type="text" id="prompt" name="prompt"
               placeholder="blank = the scenario's own instruction"></div>
           <div><label for="max">override the ceiling, rupees (optional)</label>
             <input type="number" id="max" name="max" min="1"
               placeholder="blank = the scenario's ceiling"></div>
         </div>
         <div class="notice">
           <strong>The agent is a live model (${escapeHtml(MODEL)}) with no guardrails.</strong>
           <p>The ceiling lives on the mandate, never the instruction, so the agent cannot see or
              police it -- the Gate is its only route to the rail. The rail itself is an offline
              stub; capture is ${simBadge()}</p>
         </div>
         <button type="submit">Run it</button>
       </form>

       <h2>Transactions</h2>
       <table>
         <colgroup><col style="width:26%"><col style="width:16%"><col style="width:11%">
           <col style="width:12%"><col><col style="width:8%"></colgroup>
         <tr><th>id</th><th>merchant</th><th>total</th><th>decision</th><th>class</th><th>events</th></tr>
       ${rows || '<tr><td colspan="6" class="empty">nothing recorded yet</td></tr>'}</table>`,
    ),
  );
});

// --- start a run -------------------------------------------------------------------------------

app.post('/run', (req, res) => {
  const body = req.body as { scenario?: string; prompt?: string; max?: string };
  const def = SCENARIOS[body.scenario ?? 'unguarded'] ?? SCENARIOS['unguarded'];
  if (!def) {
    res.status(400).send(page('Bad request', '<h1>unknown scenario</h1>'));
    return;
  }

  const id = `web_${def.name}_${Date.now().toString().slice(-7)}`;
  const prompt = body.prompt?.trim() ? body.prompt.trim() : def.prompt;

  // An overridden ceiling replaces payment.budget and nothing else, so the rest of the scenario's
  // constraints stay exactly as tuned.
  const rupees = Number(body.max ?? '');
  const paymentConstraints =
    Number.isFinite(rupees) && rupees > 0
      ? [
          budget(Math.round(rupees * 100)),
          ...def.paymentConstraints.filter((c) => c.type !== 'payment.budget'),
        ]
      : def.paymentConstraints;

  runs.set(id, { status: 'running' });

  // Fire and forget. The page polls the ledger, which the run appends to as it goes.
  void (async () => {
    try {
      const { transport, judge } = buildJudgeAndTransport();
      await runPurchase(
        {
          transactionId: id,
          prompt,
          checkoutConstraints: def.checkoutConstraints,
          paymentConstraints,
          mandate: { iat: DEMO_NOW - 60, exp: DEMO_NOW + 3600 },
          now: DEMO_NOW,
        },
        {
          ledger: new Ledger(LEDGER_PATH),
          judge,
          transport,
          model: MODEL,
          keys: await keys(),
          rail: offlineRail(),
          simulateCapture: true,
        },
      );
      runs.set(id, { status: 'done' });
    } catch (cause) {
      runs.set(id, { status: 'error', message: (cause as Error).message });
    }
  })();

  res.redirect(303, `/t/${encodeURIComponent(id)}`);
});

// --- one transaction ---------------------------------------------------------------------------

app.get('/t/:id', (req, res) => {
  const id = req.params.id;
  const all = allEvents();
  const events = all.filter((e) => e.transactionId === id);
  const state = runs.get(id);

  if (events.length === 0 && !state) {
    res
      .status(404)
      .send(page('Not found', `<h1>${escapeHtml(id)}</h1><p class="empty">No events.</p>`));
    return;
  }

  const running = state?.status === 'running';
  const r = replay(all, id);

  const banner = running
    ? `<div class="banner running"><strong>Running.</strong> The agent is searching the catalogue
       and assembling a cart. Events appear below as they are written to the ledger; this page
       refreshes every two seconds until the Gate rules.</div>`
    : state?.status === 'error'
      ? `<div class="banner error"><strong>The run failed.</strong> ${escapeHtml(state.message)}</div>`
      : '';

  const settled = events.some((e) => e.type === 'rail_payment_captured');
  const ruled = events.some((e) => e.type === 'adjudication');

  // Stated next to the money, not only in the events table: the capture is not real.
  const captureNotice = settled
    ? `<div class="notice"><strong>A payment was captured for this transaction.</strong>
         <p>Orders are created against Razorpay test keys for real. Completing a payment needs a
            human in a browser, so the capture here is ${simBadge()}</p></div>`
    : '';

  const disputeForm =
    settled && !ruled && !running
      ? `<h2>Dispute this payment</h2>
         <form method="post" action="/t/${encodeURIComponent(id)}/dispute">
           <label for="complaint">what went wrong</label>
           <input type="text" id="complaint" name="complaint"
             value="The room faced overnight construction work. I could not sleep.">
           <p class="sub" style="margin:12px 0 10px">
             The chain is replayed and ruled on afresh. The adjudicator is not bound by what the
             Gate decided at the time, and refuses to rule at all on a chain that does not verify.
           </p>
           <button type="submit">Adjudicate</button>
         </form>`
      : '';

  const tamperForm = !running
    ? `<h2>Tamper check</h2>
       <form method="post" action="/t/${encodeURIComponent(id)}/tamper">
         <p class="sub" style="margin:0 0 10px">
           Alters one event in a copy held in memory and re-verifies. Nothing is written; the
           stored ledger is untouched.
         </p>
         <button type="submit">Alter the cart total and re-verify</button>
       </form>`
    : '';

  res.send(
    page(
      `Recourse ${id}`,
      `<h1>${breakableId(id)}</h1>
       <p class="sub"><a href="/">back</a> &middot; ${escapeHtml(chainLine(r))}</p>
       ${banner}
       ${renderSteps(events, { running, ...(r.verdict ? { verdictAction: r.verdict.action } : {}) })}
       <p class="instruction">${escapeHtml(r.prompt ?? '(no instruction recorded)')}</p>
       <p class="goal"><span>authorised goal:</span> ${escapeHtml(r.goal ?? '(none)')}</p>
       ${verdictBlock(r)}
       ${captureNotice}
       ${constraintTable(all, id)}
       ${adjudicationBlock(events)}
       ${eventsTable(events)}
       <details class="evidence-raw"><summary>plain-text reconstruction</summary>
         <pre>${escapeHtml(renderChain(r))}</pre></details>
       ${disputeForm}
       ${tamperForm}`,
      running ? 2 : undefined,
    ),
  );
});

// --- dispute -----------------------------------------------------------------------------------

app.post('/t/:id/dispute', (req, res) => {
  const id = req.params.id;
  const complaint =
    (req.body as { complaint?: string }).complaint?.trim() ||
    'This purchase was not what I asked for.';

  runs.set(id, { status: 'running' });

  void (async () => {
    try {
      const { judge } = buildJudgeAndTransport();
      const ledger = new Ledger(LEDGER_PATH);
      const budgetMax = budgetMaxOf(ledger.all(), id);

      ledger.append({ transactionId: id, type: 'dispute_opened', at: Date.now(), data: { complaint } });

      const ruling = await adjudicate(
        { events: ledger.all(), transactionId: id, complaint, budgetMax },
        judge,
      );

      ledger.append({
        transactionId: id,
        type: 'adjudication',
        at: Date.now(),
        data: {
          status: ruling.status,
          ...(ruling.status === 'ruled'
            ? {
                classification: ruling.classification,
                confidence: ruling.confidence,
                award: ruling.remediation.award,
              }
            : { reason: ruling.reason }),
          judgeModel: ruling.judge.model,
          pack: evidencePack(ruling),
        },
      });
      runs.set(id, { status: 'done' });
    } catch (cause) {
      runs.set(id, { status: 'error', message: (cause as Error).message });
    }
  })();

  res.redirect(303, `/t/${encodeURIComponent(id)}`);
});

// --- tamper check ------------------------------------------------------------------------------

app.post('/t/:id/tamper', (req, res) => {
  const id = req.params.id;
  const all = allEvents();
  const target = all.findIndex((e) => e.transactionId === id && e.type === 'cart_proposed');

  if (target === -1) {
    res
      .status(400)
      .send(page('Nothing to alter', '<h1>no cart_proposed event in this transaction</h1>'));
    return;
  }

  // A COPY. The stored ledger is never touched.
  const copy = all.map((e) => ({ ...e }));
  const original = copy[target] as LedgerEvent;
  copy[target] = { ...original, data: { ...original.data, total: 100 } };

  const before = Ledger.fromEvents(all).verify();
  const after = Ledger.fromEvents(copy).verify();

  res.send(
    page(
      `Tamper check ${id}`,
      `<h1>Tamper check</h1>
       <p class="sub"><a href="/t/${encodeURIComponent(id)}">back to ${breakableId(id)}</a></p>
       <div class="notice"><strong>Computed on a copy held in memory.</strong>
         <p>The stored ledger was not modified. Nothing on this console can edit or delete a
            recorded event.</p></div>

       <h2>Before</h2>
       <p>${
         before.valid
           ? `<span class="ok">INTACT</span> <span class="faint">across ${before.length} events</span>`
           : '<span class="bad">already broken</span>'
       }</p>

       <h2>The edit</h2>
       <p>event ${original.seq} (<code>cart_proposed</code>): total
          <strong>${escapeHtml(String(original.data['total']))}</strong> &rarr; <strong>100</strong></p>

       <h2>After</h2>
       ${
         after.valid
           ? '<p class="bad">Chain still verifies. That should not happen.</p>'
           : `<p><span class="bad">CHAIN BROKEN at event ${after.brokenAt}</span></p>
              <pre class="sub">${escapeHtml(after.reason)}</pre>`
       }

       <div class="notice danger"><strong>What this does and does not prove.</strong>
         <p><strong>It does:</strong> an edit to a settled row is detected, and the row is named.</p>
         <p><strong>It does not:</strong> an attacker who rewrites EVERY row recomputes every hash
            and produces a chain that verifies. So does truncating the tail. Detecting either needs
            an anchor held outside the log, which is not implemented. See
            <code>docs/threat-model.md</code>.</p></div>`,
    ),
  );
});

app.get('/t/:id/evidence', (req, res) => {
  const all = allEvents();
  if (!all.some((e) => e.transactionId === req.params.id)) {
    res.status(404).type('text/plain').send('no events for that transaction');
    return;
  }
  res.type('text/plain').send(renderChain(replay(all, req.params.id)));
});

app.listen(PORT, () => {
  console.log(`Recourse console on http://localhost:${PORT}`);
  console.log(`  ledger : ${LEDGER_PATH}${existsSync(LEDGER_PATH) ? '' : '  (not present yet)'}`);
  console.log(`  agent  : live (${MODEL}); rail is an offline stub, capture is simulated`);
  console.log('  history is append-only: nothing here can edit or delete a recorded event');
});

export { app, statusClass };
