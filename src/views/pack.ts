/**
 * The adjudication result.
 *
 * Rendered from the structured fields on the `adjudication` event rather than by parsing the
 * plain-text evidence pack, so the layout cannot drift out of step with the pack's wording. The
 * full pack stays available verbatim behind a disclosure.
 *
 * One thing is deliberately NOT behind that disclosure: the note that this algorithm is
 * probabilistic and not verifier-equivalent. It is the single most important caveat attached to
 * any ruling this system makes -- a reader who takes a classification at face value without it has
 * been misled -- so it is promoted to a notice on the page itself and appears whether the dispute
 * was ruled or escalated.
 */

import { escapeHtml } from './html.js';
import { formatINR, paise } from '../money.js';
import type { LedgerEvent } from '../ledger/events.js';

function money(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return String(value ?? '-');
  return formatINR(paise(value));
}

function str(d: Record<string, unknown>, k: string): string | undefined {
  const v = d[k];
  return typeof v === 'string' ? v : undefined;
}

export function adjudicationBlock(events: readonly LedgerEvent[]): string {
  const event = events.findLast((e) => e.type === 'adjudication');
  if (!event) return '';

  const d = event.data;
  const status = str(d, 'status') ?? 'unknown';
  const model = str(d, 'judgeModel') ?? 'unknown model';
  const pack = str(d, 'pack') ?? '';

  const ruling =
    status === 'ruled'
      ? `<div class="pack-section">
           <h3>Ruling</h3>
           <p class="row-line" style="font-size:18px;font-weight:700;margin-top:6px">
             ${escapeHtml(str(d, 'classification') ?? '?')}</p>
           <p class="row-line faint">confidence ${
             typeof d['confidence'] === 'number' ? d['confidence'].toFixed(2) : '?'
           } &middot; clause relied on is in the full pack below</p>
         </div>
         <div class="pack-section">
           <h3>Remedy</h3>
           <p class="row-line" style="font-size:18px;font-weight:700;margin-top:6px">
             ${escapeHtml(money(d['award']))}</p>
           <p class="row-line faint">An upper bound. The rail applies its own cap, derived from what
             was actually captured, what the mandate authorised, and what has already been returned
             -- never a figure supplied by a caller.</p>
         </div>`
      : `<div class="pack-section">
           <h3>Escalated to a human</h3>
           <p class="row-line">No automatic remedy was applied.</p>
           <p class="row-line faint">${escapeHtml(str(d, 'reason') ?? '')}</p>
         </div>`;

  return `<h2>Adjudication</h2>
    <div class="pack">
      ${ruling}
      <div class="pack-section">
        <div class="notice">
          <strong>Adjudicated by ${escapeHtml(model)}.</strong>
          <p>This algorithm is probabilistic and is <strong>not verifier-equivalent</strong>: an
             independent verifier re-running it may reach a different answer. It is not a
             deterministic check and does not claim to be. Measured performance is in
             <code>evals/</code>.</p>
        </div>
      </div>
    </div>
    <details class="evidence-raw"><summary>full evidence pack, verbatim</summary>
      <pre>${escapeHtml(pack)}</pre></details>`;
}
