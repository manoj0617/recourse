/**
 * The pipeline step indicator: prompt -> mandate -> agent searching -> cart -> gate -> rail.
 *
 * Progress during a live run used to be legible only by counting rows in the events table. This
 * reads the same ledger events -- no new event type, no schema change -- and turns "how far did
 * this get" into something a paused video frame answers at a glance.
 *
 * The rail step is a special case: a `hold` or `deny` verdict means the pipeline stopped on
 * purpose, not that it broke. That is shown as "skipped", not left looking identical to a step the
 * run simply has not reached yet.
 */
import { escapeHtml } from './html.js';
import type { LedgerEvent, EventType } from '../ledger/events.js';

type StepId = 'prompt' | 'mandate' | 'search' | 'cart' | 'gate' | 'rail';

const STEPS: readonly { readonly id: StepId; readonly label: string }[] = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'mandate', label: 'Mandate' },
  { id: 'search', label: 'Agent searching' },
  { id: 'cart', label: 'Cart' },
  { id: 'gate', label: 'Gate' },
  { id: 'rail', label: 'Rail' },
];

function reachedSteps(events: readonly LedgerEvent[]): ReadonlySet<StepId> {
  const has = (t: EventType) => events.some((e) => e.type === t);
  const reached = new Set<StepId>();
  if (has('user_prompt')) reached.add('prompt');
  if (has('mandate_issued')) reached.add('mandate');
  if (has('options_considered')) reached.add('search');
  if (has('cart_proposed')) reached.add('cart');
  if (has('gate_verdict') || has('escalated')) reached.add('gate');
  if (has('rail_order_created') || has('rail_payment_captured')) reached.add('rail');
  return reached;
}

export function renderSteps(
  events: readonly LedgerEvent[],
  opts: { readonly running: boolean; readonly verdictAction?: string },
): string {
  const reached = reachedSteps(events);
  const railSkipped =
    !reached.has('rail') && opts.verdictAction !== undefined && opts.verdictAction !== 'allow';

  let activeAssigned = false;
  const cells = STEPS.map((step, i) => {
    let cls = 'pending';
    if (reached.has(step.id)) cls = 'done';
    else if (step.id === 'rail' && railSkipped) cls = 'skipped';
    else if (opts.running && !activeAssigned) {
      cls = 'active';
      activeAssigned = true;
    }
    return `<div class="step ${cls}"><span class="n">${i + 1}</span>${escapeHtml(step.label)}</div>`;
  }).join('');

  // Spelled out rather than suffixed. Appending "ed" produces "holded" and "denyed", which is
  // exactly the kind of thing a paused video frame puts on screen for thirty seconds.
  const PAST: Readonly<Record<string, string>> = {
    allow: 'allowed',
    deny: 'denied',
    hold: 'held',
  };

  const action = opts.verdictAction ?? '';
  const note = railSkipped
    ? `<p class="step-note">The Gate ${escapeHtml(PAST[action] ?? action)} this purchase -- the rail was never called.</p>`
    : '';

  return `<div class="steps">${cells}</div>${note}`;
}
