/**
 * The events table.
 *
 * Each row gets a written summary of what the event actually says, with the raw JSON tucked behind
 * a `<details>`. The raw record is still one click away and nothing is omitted -- but a
 * `mandate_issued` row is mostly a several-hundred-character JWS, and letting that set the visual
 * weight of the table buried the two events a viewer actually wants (`cart_proposed` and
 * `gate_verdict`) in noise.
 *
 * The summaries are read off the same event data the raw view shows. No new event type, no schema
 * change: if a fact is not in the ledger it is not on this page.
 */

import { escapeHtml } from './html.js';
import { decisionPill, simBadge } from './format.js';
import { formatINR, paise } from '../money.js';
import type { LedgerEvent } from '../ledger/events.js';

/** Amounts arrive from the ledger as plain numbers. Never throw while rendering a page. */
function money(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return String(value ?? '-');
  return formatINR(paise(value));
}

function str(d: Record<string, unknown>, k: string): string | undefined {
  const v = d[k];
  return typeof v === 'string' ? v : undefined;
}

function line(html: string): string {
  return `<p class="row-line">${html}</p>`;
}

function chips(values: readonly string[]): string {
  return `<div class="chips">${values.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join('')}</div>`;
}

/** A human sentence for one event. Falls back to nothing rather than inventing detail. */
function summarise(event: LedgerEvent): string {
  const d = event.data;

  switch (event.type) {
    case 'user_prompt':
      return line(escapeHtml(str(d, 'prompt') ?? '(no prompt recorded)'));

    case 'mandate_issued': {
      const constraints = Array.isArray(d['constraints'])
        ? (d['constraints'] as { type?: string }[])
        : [];
      const types = constraints.map((c) => c.type ?? '?');
      return (
        line(`${constraints.length} constraint(s) authorised, signed with key ${escapeHtml(str(d, 'kid') ?? '?')}`) +
        chips(types)
      );
    }

    case 'options_considered': {
      const skus = Array.isArray(d['skus']) ? (d['skus'] as string[]) : [];
      return line(`the agent looked at ${skus.length} item(s) before choosing`) + chips(skus);
    }

    case 'cart_proposed': {
      const items = Array.isArray(d['items'])
        ? (d['items'] as { sku: string; quantity: number }[])
        : [];
      return (
        line(
          `<strong>${escapeHtml(items.map((i) => `${i.quantity}x ${i.sku}`).join(', '))}</strong>` +
            ` at ${escapeHtml(str(d, 'merchant') ?? '?')}`,
        ) + line(`total <strong>${money(d['total'])}</strong>`)
      );
    }

    case 'gate_verdict': {
      const action = str(d, 'action') ?? 'unknown';
      const constraints = Array.isArray(d['constraints']) ? d['constraints'].length : 0;
      return line(
        `${decisionPill(action)} ${escapeHtml(str(d, 'classification') ?? '')} ` +
          `<span class="faint">after evaluating ${constraints} constraint(s)</span>`,
      );
    }

    case 'rail_order_created':
      return line(`order ${escapeHtml(str(d, 'orderId') ?? '?')} for ${money(d['amount'])}`);

    case 'rail_payment_captured':
      return (
        line(`payment ${escapeHtml(str(d, 'paymentId') ?? '?')} for ${money(d['amount'])}`) +
        (d['simulated'] === true ? line(simBadge()) : '')
      );

    case 'escalated': {
      const reasons = Array.isArray(d['reasons']) ? (d['reasons'] as string[]) : [];
      return (
        line(`escalated to a human: ${escapeHtml(str(d, 'classification') ?? '')}`) +
        reasons.map((r) => line(`<span class="faint">${escapeHtml(r)}</span>`)).join('')
      );
    }

    case 'dispute_opened':
      return line(escapeHtml(str(d, 'complaint') ?? '(no complaint recorded)'));

    case 'adjudication': {
      const status = str(d, 'status') ?? '?';
      if (status !== 'ruled') {
        return line(`escalated: ${escapeHtml(str(d, 'reason') ?? '')}`);
      }
      const confidence = typeof d['confidence'] === 'number' ? d['confidence'].toFixed(2) : '?';
      return line(
        `ruled <strong>${escapeHtml(str(d, 'classification') ?? '?')}</strong> at confidence ` +
          `${escapeHtml(confidence)}, remedy ${money(d['award'])}`,
      );
    }

    case 'refund_issued':
      return line(`refunded ${money(d['amount'])}`);

    default:
      return '';
  }
}

export function eventsTable(events: readonly LedgerEvent[]): string {
  const rows = events
    .map((e) => {
      const summary = summarise(e);
      return `<tr>
        <td class="hash">${e.seq}</td>
        <td class="ev-type">${escapeHtml(e.type)}</td>
        <td class="ev-summary">${summary}
          <details class="raw"><summary>raw</summary>
            <pre>${escapeHtml(JSON.stringify(e.data, null, 1))}</pre></details></td>
        <td class="hash">${escapeHtml(e.hash.slice(0, 10))}</td>
      </tr>`;
    })
    .join('');

  return `<h2>Events</h2>
    <table>
      <colgroup><col style="width:4%"><col style="width:19%"><col><col style="width:12%"></colgroup>
      <tr><th>#</th><th>type</th><th>what it records</th><th>hash</th></tr>${rows}
    </table>`;
}
