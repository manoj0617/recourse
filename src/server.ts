/**
 * The console: a read-only view of the ledger, and a replay viewer for one transaction.
 *
 * Server-rendered HTML with no client-side JavaScript and no build step. This is a deliberate
 * downgrade from a React app under a fixed time budget -- what a reviewer needs from this screen
 * is to read a chain and see where it breaks, and a framework contributes nothing to that.
 *
 * Read-only on purpose. Nothing here can authorise, refund or alter anything: a console that can
 * mutate the ledger it is displaying undermines the property the ledger exists to provide. Runs
 * are started from the scenario CLI.
 *
 *   npm start        # reads RECOURSE_LEDGER_PATH
 */

import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { evidencePack } from './adjudicator/adjudicator.js';
import { renderChain, replay } from './adjudicator/replay.js';
import { Ledger } from './ledger/ledger.js';
import type { LedgerEvent } from './ledger/events.js';

const LEDGER_PATH = process.env['RECOURSE_LEDGER_PATH'] ?? 'data/ledger.jsonl';
const PORT = Number(process.env['PORT'] ?? '3000');

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         margin: 0; padding: 24px; max-width: 1000px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .08em; }
  .sub { opacity: .65; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 5px 10px 5px 0; vertical-align: top;
           border-bottom: 1px solid rgba(128,128,128,.25); }
  th { font-weight: 600; opacity: .7; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0;
        border-left: 3px solid rgba(128,128,128,.35); padding-left: 12px; }
  a { color: inherit; }
  .ok { color: #1a7f37; font-weight: 600; }
  .bad { color: #c1121f; font-weight: 600; }
  .hold { color: #b45309; font-weight: 600; }
  .hash { opacity: .55; }
  .empty { opacity: .6; padding: 24px 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function statusClass(action: string): string {
  return action === 'allow' ? 'ok' : action === 'deny' ? 'bad' : 'hold';
}

function loadLedger(): Ledger | null {
  if (!existsSync(LEDGER_PATH)) return null;
  return new Ledger(LEDGER_PATH);
}

const app = express();

app.get('/', (_req, res) => {
  const ledger = loadLedger();
  if (!ledger) {
    res.send(
      page(
        'Recourse console',
        `<h1>Recourse</h1><p class="sub">No ledger at <code>${escapeHtml(LEDGER_PATH)}</code>.</p>
         <p class="empty">Run a scenario first, for example:<br>
         <code>npx tsx src/scenarios/cli.ts semantic</code></p>`,
      ),
    );
    return;
  }

  const chain = ledger.verify();
  const events = ledger.all();
  const ids = [...new Set(events.map((e) => e.transactionId))];

  const rows = ids
    .map((id) => {
      const r = replay(events, id);
      const action = r.verdict?.action ?? 'no verdict';
      return `<tr>
        <td><a href="/t/${encodeURIComponent(id)}">${escapeHtml(id)}</a></td>
        <td>${escapeHtml(r.cart?.merchant ?? '-')}</td>
        <td>${r.cart ? (r.cart.total / 100).toFixed(2) : '-'}</td>
        <td class="${statusClass(action)}">${escapeHtml(action.toUpperCase())}</td>
        <td>${escapeHtml(r.verdict?.classification ?? '-')}</td>
        <td>${r.events.length}</td>
      </tr>`;
    })
    .join('');

  res.send(
    page(
      'Recourse console',
      `<h1>Recourse</h1>
       <p class="sub">${events.length} events across ${ids.length} transaction(s) &middot;
         chain ${chain.valid ? '<span class="ok">INTACT</span>' : `<span class="bad">BROKEN at event ${chain.brokenAt}</span>`}
         ${chain.valid ? `<br><span class="hash">head ${escapeHtml(chain.head)}</span>` : `<br><span class="bad">${escapeHtml(chain.reason)}</span>`}
       </p>
       <h2>Transactions</h2>
       <table><tr><th>id</th><th>merchant</th><th>total</th><th>decision</th><th>class</th><th>events</th></tr>
       ${rows || '<tr><td colspan="6" class="empty">nothing recorded yet</td></tr>'}</table>`,
    ),
  );
});

app.get('/t/:id', (req, res) => {
  const ledger = loadLedger();
  const id = req.params.id;
  const all: readonly LedgerEvent[] = ledger?.all() ?? [];
  const events = all.filter((e) => e.transactionId === id);

  if (events.length === 0) {
    res.status(404).send(page('Not found', `<h1>${escapeHtml(id)}</h1><p class="empty">No events.</p>`));
    return;
  }

  const r = replay(all, id);
  const rows = events
    .map(
      (e) => `<tr>
        <td>${e.seq}</td>
        <td>${escapeHtml(e.type)}</td>
        <td><pre>${escapeHtml(JSON.stringify(e.data, null, 1))}</pre></td>
        <td class="hash">${escapeHtml(e.hash.slice(0, 10))}</td>
      </tr>`,
    )
    .join('');

  res.send(
    page(
      `Recourse ${id}`,
      `<h1>${escapeHtml(id)}</h1>
       <p class="sub"><a href="/">back</a> &middot; chain
         ${r.chain.valid ? '<span class="ok">intact</span>' : `<span class="bad">BROKEN at ${r.chain.brokenAt}</span>`}</p>
       <h2>Reconstruction</h2>
       <pre>${escapeHtml(renderChain(r))}</pre>
       <h2>Events</h2>
       <table><tr><th>#</th><th>type</th><th>data</th><th>hash</th></tr>${rows}</table>`,
    ),
  );
});

/** Plain-text evidence pack, so it can be piped or pasted without reformatting. */
app.get('/t/:id/evidence', (req, res) => {
  const ledger = loadLedger();
  const all = ledger?.all() ?? [];
  if (!all.some((e) => e.transactionId === req.params.id)) {
    res.status(404).type('text/plain').send('no events for that transaction');
    return;
  }
  // No ruling here: this endpoint shows the evidence a ruling would be made from, not a ruling.
  // Adjudication runs from the scenario CLI, because it costs a model call.
  res.type('text/plain').send(renderChain(replay(all, req.params.id)));
});

app.listen(PORT, () => {
  console.log(`Recourse console on http://localhost:${PORT}`);
  console.log(`  ledger : ${LEDGER_PATH}${existsSync(LEDGER_PATH) ? '' : '  (not present yet)'}`);
  console.log('  read-only: nothing here can authorise, refund or alter anything');
});

export { app, evidencePack };
