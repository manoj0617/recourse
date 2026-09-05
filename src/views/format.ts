/**
 * Small, reusable rendering primitives shared across pages: status colour mapping, pills, the
 * verdict block, and the chain-integrity line. Kept separate from the page-level renderers so the
 * same "what does ALLOW look like" decision is made once.
 */
import { escapeHtml } from './html.js';
import type { replay } from '../adjudicator/replay.js';

export function statusClass(action: string): 'ok' | 'bad' | 'hold' {
  return action === 'allow' ? 'ok' : action === 'deny' ? 'bad' : 'hold';
}

function pillClass(action: string): string {
  return action === 'allow'
    ? 'pill-allow'
    : action === 'deny'
      ? 'pill-deny'
      : action === 'running'
        ? 'pill-running'
        : 'pill-hold';
}

/** The decision pill used on the index table and (larger) as the verdict badge. */
export function decisionPill(action: string): string {
  return `<span class="pill ${pillClass(action)}">${escapeHtml(action.toUpperCase())}</span>`;
}

/**
 * `whole-log chain intact (N events) - this transaction: M` -- the two counts stay on one line and
 * stay distinguishable. Collapsing them previously made an intact chain look broken; see the note
 * in adjudicator/replay.ts, which this text is deliberately kept consistent with.
 */
export function chainLine(r: ReturnType<typeof replay>): string {
  return r.chain.valid
    ? `whole-log chain intact (${r.chain.length} events) - this transaction: ${r.events.length}`
    : `WHOLE-LOG CHAIN BROKEN at event ${r.chain.brokenAt} - this transaction: ${r.events.length}`;
}

/**
 * The verdict as the page's focal point: a large badge plus classification and judge identity.
 * This is deliberately the most visually weighted element on the transaction page -- it is the
 * one fact a paused video frame should read in under a second.
 */
export function verdictBlock(r: ReturnType<typeof replay>): string {
  if (!r.verdict) return '';
  const cls = statusClass(r.verdict.action);
  return (
    `<div class="verdict">` +
    `<span class="verdict-badge ${cls}">${escapeHtml(r.verdict.action.toUpperCase())}</span>` +
    `<div class="verdict-meta"><strong>${escapeHtml(r.verdict.classification)}</strong>` +
    (r.verdict.judgeModel ? `<br>judge ${escapeHtml(r.verdict.judgeModel)}` : '') +
    `</div></div>`
  );
}

/** `origin` column pill: AP2's own constraints vs. the ones this project adds. */
export function originPill(origin: string): string {
  const ext = origin === 'recourse-extension';
  return `<span class="pill pill-origin${ext ? ' ext' : ''}">${escapeHtml(origin)}</span>`;
}

/**
 * The `SIMULATED -- no money moved` label. Appears wherever a capture is shown, in full, every
 * time -- never abbreviated and never behind a disclosure control.
 */
export function simBadge(): string {
  return `<span class="sim-badge">SIMULATED -- no money moved</span>`;
}

/**
 * A transaction id as text, with a legal break point after every underscore.
 *
 * Ids look like `web_unguarded_5090819` -- one long run of characters with no spaces, so the
 * browser's only fallback once a column runs out of room is to break mid-word at an arbitrary
 * character. `<wbr>` gives it underscore boundaries to prefer instead; it renders as nothing when
 * the id already fits, so this is free on every id short enough not to need it.
 */
export function breakableId(id: string): string {
  return escapeHtml(id).split('_').join('_<wbr>');
}
