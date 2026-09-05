/**
 * The constraint table: the project's entire positioning argument rendered as an artifact.
 *
 * AP2's own constraints and the extensions defined here sit in one list, evaluated by one
 * registry, and the row that fires is usually the one AP2 has no vocabulary for. The `origin`
 * column is what makes that argument legible, so it is never removed, and the violated row keeps
 * its tint. Column widths are fixed so a long reason string wraps at word boundaries instead of
 * being squeezed by whichever column happened to render widest.
 */
import { escapeHtml } from './html.js';
import { originPill } from './format.js';
import type { LedgerEvent } from '../ledger/events.js';

export function constraintTable(all: readonly LedgerEvent[], id: string): string {
  const verdict = all
    .filter((e) => e.transactionId === id)
    .findLast((e) => e.type === 'gate_verdict');
  const list = verdict?.data['constraints'];
  if (!Array.isArray(list) || list.length === 0) return '';

  const rows = (list as { type: string; origin: string; status: string; reason: string }[])
    .map((c) => {
      const rowClass =
        c.status === 'violated'
          ? ' class="violated"'
          : c.status === 'indeterminate'
            ? ' class="held"'
            : '';
      const mark =
        c.status === 'satisfied'
          ? '<span class="pill pill-satisfied">satisfied</span>'
          : c.status === 'violated'
            ? '<span class="pill pill-violated">VIOLATED</span>'
            : '<span class="pill pill-unevaluated">UNEVALUATED</span>';
      return (
        `<tr${rowClass}><td class="st">${mark}</td><td class="mono">${escapeHtml(c.type)}</td>` +
        `<td class="origin">${originPill(c.origin)}</td><td>${escapeHtml(c.reason)}</td></tr>`
      );
    })
    .join('');

  return `<h2>Constraints evaluated</h2>
    <table>
      <colgroup><col style="width:11%"><col style="width:27%"><col style="width:16%"><col></colgroup>
      <tr><th>status</th><th>constraint</th><th>origin</th><th>reason</th></tr>${rows}
    </table>`;
}
