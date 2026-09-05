/**
 * Run the corpus through the Gate and report what it got right and wrong.
 *
 * Three things this harness does deliberately differently from the production path:
 *
 *   1. `shortCircuit: false`. Production skips a model call that cannot change the action. An
 *      evaluation that did the same would produce no judge outcomes for cases the deterministic
 *      rules already caught, and the confusion matrix would silently be measuring the rule layer.
 *   2. It refuses to score an unlabelled case. A case with `label: null` is counted and named in
 *      the output, never guessed at and never quietly dropped.
 *   3. It never prints a single accuracy number. Blocking a legitimate purchase and allowing an
 *      illegitimate one are different losses and are reported separately.
 *
 * Resumability comes from the transport cache rather than from this file: run once with
 * JUDGE_MODE=record to pay for the model calls, then any number of times with JUDGE_MODE=replay
 * for free and offline. A run interrupted mid-corpus loses only the case in flight, because the
 * transport writes each response to disk as it arrives.
 *
 *   npx tsx evals/run.ts
 */

// The harness reads its provider config from the environment the same way the server does.
// Without this the API key in .env is invisible here, every judged case escalates, and the run
// reports the fail-closed path rather than any measurement.
import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { checkoutSchema } from '../src/ap2/checkout.js';
import { cartFingerprint } from '../src/ap2/checkout.js';
import type { ConstraintContext } from '../src/ap2/constraints/types.js';
import type { Authorisation } from '../src/ap2/mandate.js';
import { evaluate } from '../src/gate/gate.js';
import { createJudge } from '../src/judge/openai-compatible.js';
import { createTransport, type TransportMode } from '../src/judge/transport.js';
import { paise, type Paise } from '../src/money.js';
import { VIOLATION_CLASSES, violationClassSchema, type ViolationClass } from '../src/taxonomy.js';

const caseSchema = z.object({
  id: z.string(),
  class: violationClassSchema,
  label: violationClassSchema.nullable(),
  label_source: z.enum(['construction', 'human', 'assistant-proposed']),
  rationale: z.string().optional(),
  prompt: z.string(),
  goal: z.string(),
  now: z.number().int(),
  checkoutConstraints: z.array(z.object({ type: z.string() }).passthrough()),
  paymentConstraints: z.array(z.object({ type: z.string() }).passthrough()),
  mandate: z.object({ iat: z.number().int(), exp: z.number().int() }),
  checkout: z.unknown(),
  history: z.array(
    z.object({ amount: z.number().int(), at: z.number().int(), cartFingerprint: z.string() }),
  ),
  notes: z.string().optional(),
});

type Case = z.infer<typeof caseSchema>;

function loadCases(path: string): Case[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line, i) => {
      const parsed = caseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`corpus line ${i + 1} is malformed: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

function buildContext(c: Case, judge: ConstraintContext['judge']): ConstraintContext {
  const checkout = checkoutSchema.parse(c.checkout);
  // `@self` in a case means "the fingerprint of this very cart". Resolved here so a duplicate
  // case cannot drift out of sync with the checkout it is supposed to duplicate.
  const fingerprint = cartFingerprint(checkout);
  return {
    checkout,
    payment: { amount: checkout.total, payee: checkout.merchant, currency: 'INR' },
    now: c.now,
    history: {
      closedPayments: c.history.map((h) => ({
        amount: paise(h.amount) as Paise,
        at: h.at,
        cartFingerprint: h.cartFingerprint === '@self' ? fingerprint : h.cartFingerprint,
      })),
    },
    judge,
  };
}

function buildAuth(c: Case): Authorisation {
  return {
    checkout: {
      vct: 'mandate.checkout.open.1',
      constraints: c.checkoutConstraints,
      ...c.mandate,
    },
    payment: {
      vct: 'mandate.payment.open.1',
      constraints: c.paymentConstraints,
      ...c.mandate,
    },
  };
}

interface Scored {
  readonly id: string;
  readonly actual: ViolationClass;
  readonly predicted: ViolationClass;
  readonly action: string;
  readonly labelSource: Case['label_source'];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function rate(numerator: number, denominator: number): string {
  return denominator === 0 ? '   --' : `${((numerator / denominator) * 100).toFixed(0).padStart(4)}%`;
}

function report(scored: readonly Scored[], skipped: readonly Case[], liveCalls: number): void {
  console.log('');
  console.log(`Scored ${scored.length} cases. ${liveCalls} model call(s) reached a provider.`);

  if (skipped.length > 0) {
    console.log('');
    console.log(`UNLABELLED, NOT SCORED (${skipped.length}):`);
    for (const c of skipped) {
      console.log(`  ${c.id}  built for ${c.class}${c.notes ? `  -- ${c.notes}` : ''}`);
    }
    console.log('  Fill in `label` in corpus/cases.jsonl to include these. See corpus/rubric.md.');
  }

  console.log('');
  console.log('PER CLASS');
  console.log(`  ${pad('class', 24)}${pad('n', 4)} prec  rec   TP  FP  FN`);
  for (const cls of VIOLATION_CLASSES) {
    const tp = scored.filter((s) => s.actual === cls && s.predicted === cls).length;
    const fp = scored.filter((s) => s.actual !== cls && s.predicted === cls).length;
    const fn = scored.filter((s) => s.actual === cls && s.predicted !== cls).length;
    const n = tp + fn;
    if (n === 0 && fp === 0) continue;
    console.log(
      `  ${pad(cls, 24)}${pad(String(n), 4)}${rate(tp, tp + fp)} ${rate(tp, tp + fn)}  ` +
        `${String(tp).padStart(3)}${String(fp).padStart(4)}${String(fn).padStart(4)}`,
    );
  }

  // Counts alongside rates, because a rate over five cases moves in twenty-point steps and a
  // bare percentage hides that.
  console.log('');
  console.log('CONFUSION MATRIX  (rows: actual, columns: predicted)');
  const present = VIOLATION_CLASSES.filter((c) =>
    scored.some((s) => s.actual === c || s.predicted === c),
  );
  console.log(`  ${pad('', 24)}${present.map((c) => pad(c.slice(0, 6), 7)).join('')}`);
  for (const actual of present) {
    const row = present.map((predicted) =>
      pad(String(scored.filter((s) => s.actual === actual && s.predicted === predicted).length), 7),
    );
    console.log(`  ${pad(actual, 24)}${row.join('')}`);
  }

  console.log('');
  console.log('COST OF ERRORS  (these are not the same loss and are not summed)');
  const wronglyBlocked = scored.filter((s) => s.actual === 'conforming' && s.action !== 'allow');
  const wronglyAllowed = scored.filter((s) => s.actual !== 'conforming' && s.action === 'allow');
  console.log(
    `  legitimate purchase blocked or held : ${wronglyBlocked.length}` +
      (wronglyBlocked.length > 0 ? `  (${wronglyBlocked.map((s) => s.id).join(', ')})` : ''),
  );
  console.log(
    `  illegitimate purchase allowed       : ${wronglyAllowed.length}` +
      (wronglyAllowed.length > 0 ? `  (${wronglyAllowed.map((s) => s.id).join(', ')})` : ''),
  );

  // A judged row that lands on `unsubstantiated` means the semantic constraint could not be
  // evaluated at all -- no key, no cache entry, a rate limit. Reporting that as "the judge scored
  // 0/10" would be a straightforward misreading of the system's own fail-closed behaviour, so the
  // harness names it rather than leaving a zero on the page to be misread.
  const judged = scored.filter((s) => s.labelSource !== 'construction');
  const unevaluated = judged.filter((s) => s.predicted === 'unsubstantiated');
  if (unevaluated.length > 0) {
    console.log('');
    console.log('!! THE SEMANTIC CONSTRAINT WAS NOT EVALUATED ON ' + `${unevaluated.length}/${judged.length} JUDGED CASES`);
    console.log('   They resolved to `unsubstantiated`, which is what this system does when a');
    console.log('   ruling cannot be obtained: it holds for a human rather than guessing. That is');
    console.log('   the fail-closed path working, NOT a judge accuracy of ' + `${judged.length - unevaluated.length}/${judged.length}.`);
    console.log('');
    console.log('   To get a real number, record the model calls once:');
    console.log('     JUDGE_API_KEY=... JUDGE_MODE=record npx tsx evals/run.ts');
    console.log('   then replay them for free and offline:');
    console.log('     JUDGE_MODE=replay npx tsx evals/run.ts');
  }

  console.log('');
  console.log('BY LABEL SOURCE  (a corpus that is mostly arithmetic flatters the hard part)');
  const correct = (rows: readonly Scored[]) => rows.filter((s) => s.actual === s.predicted).length;
  const bucket = (src: Scored['labelSource'], caption: string) => {
    const rows = scored.filter((s) => s.labelSource === src);
    if (rows.length === 0) return;
    console.log(`  ${pad(caption, 22)}: ${correct(rows)}/${rows.length} matched`);
  };
  bucket('construction', 'construction-entailed');
  bucket('assistant-proposed', 'assistant-proposed');
  bucket('human', 'human-judged');
  console.log('');
  console.log('  construction-entailed labels follow from arithmetic and set membership. Matching');
  console.log('  them verifies the deterministic rules are wired correctly and is NOT a capability');
  console.log('  result. Only the judged rows measure the semantic constraint, and their ground');
  console.log('  truth is model-proposed rather than human -- see corpus/rubric.md.');
  console.log('');
}

async function main(): Promise<void> {
  const mode = (process.env['JUDGE_MODE'] ?? 'replay') as TransportMode;
  const transport = createTransport({
    mode,
    baseURL: process.env['JUDGE_BASE_URL'] ?? 'https://api.groq.com/openai/v1',
    apiKey: process.env['JUDGE_API_KEY'] ?? '',
    cachePath: process.env['JUDGE_CACHE_PATH'] ?? 'data/judge-cache.json',
  });
  const judge = createJudge({
    transport,
    model: process.env['JUDGE_MODEL'] ?? 'llama-3.3-70b-versatile',
    confidenceThreshold: Number(process.env['JUDGE_CONFIDENCE_THRESHOLD'] ?? '0.6'),
  });

  const cases = loadCases('corpus/cases.jsonl');
  const scored: Scored[] = [];
  const skipped: Case[] = [];

  for (const c of cases) {
    if (c.label === null) {
      skipped.push(c);
      continue;
    }
    const verdict = await evaluate(buildAuth(c), buildContext(c, judge), c.id, {
      shortCircuit: false,
    });
    scored.push({
      id: c.id,
      actual: c.label,
      predicted: verdict.classification,
      action: verdict.action,
      labelSource: c.label_source,
    });
    const mark = verdict.classification === c.label ? '.' : 'X';
    process.stdout.write(mark);
  }

  report(scored, skipped, transport.liveCalls);
}

main().catch((error: unknown) => {
  console.error(`\neval run failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
