/**
 * Post-transaction adjudication: replay the chain, rule on the dispute, bound the remedy.
 *
 * AP2 v0.2 already covers the evidence half of this. It specifies that SD-JWTs be stored with
 * their disclosures so that `sd_hash`, `checkout_hash` and Receipt `reference` can be recomputed
 * at dispute time -- which establishes what was authorised and what each party saw. What it does
 * not do, and does not claim to do, is decide whether the thing delivered satisfied a goal the
 * user expressed in natural language. That decision is this module.
 *
 * Two refusals are built in, and both matter more than the ruling itself:
 *
 *   - A broken chain is never adjudicated. If the evidence does not verify, the correct output is
 *     "this cannot be ruled on", not a ruling made from evidence known to be altered. This is the
 *     one place where the hash chain earns its keep.
 *   - A ruling the model is not confident in escalates. `unsubstantiated` exists so that "the
 *     complaint does not hold" is an available answer; low confidence is a different thing, and
 *     collapsing the two would quietly resolve every uncertain dispute against the user.
 */

import { formatINR, paise, subClamped, type Paise } from '../money.js';
import type { LedgerEvent } from '../ledger/events.js';
import type { ConformanceJudge } from '../judge/types.js';
import type { ViolationClass } from '../taxonomy.js';
import { renderChain, replay, type ReplayedTransaction } from './replay.js';

export interface DisputeInput {
  /**
   * The WHOLE ledger, not just this transaction's events. Chain integrity cannot be checked on a
   * slice; see the note on `replay`. Passing a filtered array here would make the adjudicator
   * decline every dispute in a ledger holding more than one transaction.
   */
  readonly events: readonly LedgerEvent[];
  /** Which transaction in that log is being disputed. */
  readonly transactionId?: string;
  /** What the user says is wrong, in their words. */
  readonly complaint: string;
  /** `payment.budget.max` from the mandate that authorised the purchase. */
  readonly budgetMax: Paise;
}

export interface Remediation {
  /** What the user is owed, before the rail applies its own derived cap. */
  readonly award: Paise;
  readonly basis: string;
}

export type Ruling =
  | {
      readonly status: 'ruled';
      readonly classification: ViolationClass;
      readonly clause: string;
      readonly confidence: number;
      readonly rationale: string;
      readonly remediation: Remediation;
      readonly replayed: ReplayedTransaction;
      readonly judge: { readonly model: string; readonly promptVersion: string };
    }
  | {
      readonly status: 'escalated';
      readonly reason: string;
      readonly replayed: ReplayedTransaction;
      readonly judge: { readonly model: string; readonly promptVersion: string };
    };

/**
 * What each class entitles the user to.
 *
 * A policy table, not logic, so that a reviewer can read it in one place and disagree with it.
 * The judgement calls worth arguing about:
 *
 *   semantic_mismatch  -> full. The user received something, so a partial remedy is arguable. Full
 *                         is chosen because the purchase was not authorised in substance: they did
 *                         not agree to buy this thing, and splitting the difference makes the
 *                         system's answer depend on how much the merchant happened to deliver.
 *   price_drift        -> the excess only. The purchase itself was authorised; the amount was not.
 *   duplicate          -> full. The second charge should not exist at all.
 *   unsubstantiated    -> nothing. This is the class that lets a dispute fail.
 */
export function remediationFor(
  classification: ViolationClass,
  facts: { readonly captured: Paise; readonly budgetMax: Paise },
): Remediation {
  const { captured, budgetMax } = facts;

  switch (classification) {
    case 'conforming':
      return { award: paise(0), basis: 'the purchase satisfied the authorisation' };

    case 'unsubstantiated':
      return { award: paise(0), basis: 'the evidence does not support the complaint' };

    case 'price_drift': {
      const excess = subClamped(captured, budgetMax);
      return {
        award: excess,
        basis:
          `the purchase was authorised but the amount was not: ${formatINR(captured)} captured ` +
          `against a ${formatINR(budgetMax)} ceiling, so ${formatINR(excess)} is returned`,
      };
    }

    case 'duplicate':
      return { award: captured, basis: 'this charge duplicates one already settled' };

    case 'expired_mandate':
      return { award: captured, basis: 'authorisation had lapsed before the money moved' };

    case 'merchant_substitution':
      return { award: captured, basis: 'payment went to a party the mandate did not permit' };

    case 'category_violation':
      return { award: captured, basis: 'the item was outside the authorised scope' };

    case 'semantic_mismatch':
      return {
        award: captured,
        basis: 'the item did not satisfy the goal the user authorised',
      };
  }
}

export async function adjudicate(input: DisputeInput, judge: ConformanceJudge): Promise<Ruling> {
  const replayed = replay(input.events, input.transactionId);
  const judgeInfo = { model: judge.model, promptVersion: judge.promptVersion };

  // Nothing is ruled on evidence that does not verify.
  if (!replayed.chain.valid) {
    return {
      status: 'escalated',
      replayed,
      judge: judgeInfo,
      reason:
        `the evidence chain does not verify (${replayed.chain.reason}). No ruling can be made ` +
        `from an altered record; this dispute needs a human and an investigation into how the ` +
        `ledger was modified.`,
    };
  }

  const outcome = await judge.adjudicate({
    goal: replayed.goal ?? '(no semantic intent constraint was authorised)',
    complaint: input.complaint,
    chain: renderChain(replayed),
  });

  if (outcome.status === 'escalate') {
    return {
      status: 'escalated',
      replayed,
      judge: judgeInfo,
      reason: `the adjudicating model could not produce a usable ruling: ${outcome.reason}`,
    };
  }

  const { classification, clause, confidence, rationale } = outcome.value;

  if (confidence <= judge.confidenceThreshold) {
    return {
      status: 'escalated',
      replayed,
      judge: judgeInfo,
      reason:
        `the model ruled ${classification} at confidence ${confidence.toFixed(2)}, at or below ` +
        `the ${judge.confidenceThreshold.toFixed(2)} threshold. Rationale offered: ${rationale}`,
    };
  }

  const captured = replayed.capturedAmount ?? paise(0);
  const remediation = remediationFor(classification, { captured, budgetMax: input.budgetMax });

  return {
    status: 'ruled',
    classification,
    clause,
    confidence,
    rationale,
    remediation,
    replayed,
    judge: judgeInfo,
  };
}

/**
 * The evidence pack: what the ruling was, and everything it was made from.
 *
 * Written for a human who was not present -- a merchant contesting the outcome, or a reviewer six
 * months later. It states the model and prompt version, because a ruling produced by a
 * non-deterministic algorithm is only meaningful alongside the configuration that produced it.
 */
export function evidencePack(ruling: Ruling): string {
  const r = ruling.replayed;
  const lines: string[] = [
    `Recourse adjudication -- ${r.transactionId}`,
    '='.repeat(60),
    '',
    'RULING',
  ];

  if (ruling.status === 'escalated') {
    lines.push('  Escalated to a human. No automatic remedy was applied.');
    lines.push(`  Reason: ${ruling.reason}`);
  } else {
    lines.push(`  Classification: ${ruling.classification}`);
    lines.push(`  Clause relied on: ${ruling.clause}`);
    lines.push(`  Confidence: ${ruling.confidence.toFixed(2)}`);
    lines.push(`  Rationale: ${ruling.rationale}`);
    lines.push(`  Remedy: ${formatINR(ruling.remediation.award)} -- ${ruling.remediation.basis}`);
    lines.push('');
    lines.push(
      '  This remedy is an upper bound. The rail applies its own cap derived from what was',
      '  actually captured, what the mandate authorised, and what has already been returned.',
    );
  }

  lines.push('');
  lines.push(`  Adjudicated by ${ruling.judge.model}, prompt ${ruling.judge.promptVersion}.`);
  lines.push(
    '  This algorithm is probabilistic and is not verifier-equivalent: an independent verifier',
    '  re-running it may reach a different answer. Measured performance is in evals/.',
  );
  lines.push('');
  lines.push('EVIDENCE');
  lines.push(renderChain(r).split('\n').map((l) => `  ${l}`).join('\n'));
  lines.push('');
  lines.push(`  ${r.events.length} events, chain ${r.chain.valid ? 'intact' : 'BROKEN'}.`);
  if (r.chain.valid) lines.push(`  Head hash: ${r.chain.head}`);

  return lines.join('\n');
}
