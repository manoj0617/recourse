/**
 * Generate the evaluation corpus.
 *
 * Cases are templated over the fixed catalogue, which makes the corpus synthetic and says so.
 * The generator exists rather than a hand-written JSONL file so that the `construction` labels are
 * demonstrably entailed by how each case was built: a reader can check that the `price_drift`
 * cases really do exceed their ceilings by reading forty lines of code instead of trusting forty
 * rows of data.
 *
 * Thirty labels are entailed by construction. The other ten require reading a description and
 * forming a view; those are marked `assistant-proposed`, carry the rationale they were labelled
 * on, and are NOT marked `human`. See corpus/rubric.md.
 *
 *   npx tsx corpus/generate.ts > corpus/cases.jsonl
 */

import { CATALOG, MERCHANTS, getItem } from '../src/catalog.js';
import type { ViolationClass } from '../src/taxonomy.js';

const NOW = 1_757_000_000;

interface Case {
  readonly id: string;
  /** What the case was built to exercise. */
  readonly class: ViolationClass;
  /**
   * Ground truth. Nullable because the harness must be able to refuse to score an unlabelled
   * case; every case currently carries a label, of one provenance or the other.
   */
  readonly label: ViolationClass | null;
  readonly label_source: 'construction' | 'human' | 'assistant-proposed';
  /** Why this label, for a reviewer auditing it. Present on judged labels only. */
  readonly rationale?: string;
  readonly prompt: string;
  readonly goal: string;
  readonly now: number;
  readonly checkoutConstraints: readonly unknown[];
  readonly paymentConstraints: readonly unknown[];
  readonly mandate: { readonly iat: number; readonly exp: number };
  readonly checkout: unknown;
  readonly history: readonly { amount: number; at: number; cartFingerprint: string }[];
  readonly notes?: string;
}

function item(sku: string) {
  const found = getItem(sku);
  if (!found) throw new Error(`case references unknown SKU ${sku}`);
  return found;
}

function merchantOf(sku: string) {
  const id = item(sku).merchantId;
  const m = Object.values(MERCHANTS).find((x) => x.id === id);
  if (!m) throw new Error(`no merchant ${id}`);
  return m;
}

/** Build a single-SKU checkout. Totals are computed, never asserted. */
function cart(sku: string, quantity = 1, id = 'chk') {
  const it = item(sku);
  return {
    id,
    merchant: merchantOf(sku),
    currency: 'INR' as const,
    createdAt: NOW,
    lineItems: [{ ...it, quantity }],
    total: it.unitPrice * quantity,
  };
}

function total(sku: string, quantity = 1): number {
  return item(sku).unitPrice * quantity;
}

const budget = (max: number) => ({ type: 'payment.budget', max, currency: 'INR' });
const scope = (allowed: string[]) => ({ type: 'recourse.category_scope', allowed });
const intent = (goal: string) => ({ type: 'recourse.semantic_intent', goal });
const merchants = (...ms: { id: string; name: string }[]) => ({
  type: 'checkout.allowed_merchants',
  allowed: ms,
});
const replay = (window = 900) => ({ type: 'recourse.cart_replay', window_seconds: window });

const live = { iat: NOW - 600, exp: NOW + 3600 };
const dead = { iat: NOW - 90_000, exp: NOW - 3600 };

const cases: Case[] = [];
let n = 0;
const add = (c: Omit<Case, 'id'>) => {
  n += 1;
  cases.push({ id: `case_${String(n).padStart(3, '0')}`, ...c });
};

// --- price_drift: cart total, or total plus prior spend, exceeds the ceiling ------------------
// Entailed by arithmetic. Every one of these is checkable against the catalogue prices.
const HOTEL_GOAL = 'a quiet hotel room near the convention centre';
for (const [sku, max, history] of [
  ['HOTEL-033', 800000, []],
  ['ELEC-024', 500000, []],
  ['STAT-009', 150000, []],
  ['HOTEL-014', 800000, [{ amount: 300000, at: NOW - 4000, cartFingerprint: 'prior-a' }]],
  ['CAB-007', 600000, [{ amount: 100000, at: NOW - 5000, cartFingerprint: 'prior-b' }]],
] as const) {
  const spent = history.reduce((a, h) => a + h.amount, 0);
  if (total(sku) + spent <= max) throw new Error(`${sku} does not exceed ${max}; case is mislabelled`);
  add({
    class: 'price_drift',
    label: 'price_drift',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: HOTEL_GOAL,
    now: NOW,
    checkoutConstraints: [],
    paymentConstraints: [budget(max)],
    mandate: live,
    checkout: cart(sku),
    history,
    notes:
      history.length > 0
        ? 'breaches only once prior settled spend is summed, per the AP2 budget rule'
        : 'breaches on the single charge alone',
  });
}

// --- category_violation: item outside the authorised category scope ---------------------------
for (const [sku, allowed] of [
  ['ELEC-011', ['stationery']],
  ['ELEC-024', ['stationery']],
  ['FOOD-003', ['stationery', 'electronics']],
  ['CAB-007', ['accommodation']],
  ['HOTEL-052', ['transport']],
] as const) {
  if (allowed.includes(item(sku).category)) throw new Error(`${sku} is inside ${allowed}`);
  add({
    class: 'category_violation',
    label: 'category_violation',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: `something from ${allowed.join(' or ')}`,
    now: NOW,
    checkoutConstraints: [],
    paymentConstraints: [budget(10_000_000), scope([...allowed])],
    mandate: live,
    checkout: cart(sku),
    history: [],
    notes:
      sku === 'ELEC-011'
        ? 'the name says notebook; the category says electronics. Labelled on the category.'
        : undefined,
  });
}

// --- merchant_substitution: merchant outside the allow-list -----------------------------------
for (const sku of ['HOTEL-052', 'HOTEL-021', 'CAB-002', 'FOOD-008', 'STAT-001'] as const) {
  const permitted = Object.values(MERCHANTS).filter((m) => m.id !== item(sku).merchantId).slice(0, 2);
  add({
    class: 'merchant_substitution',
    label: 'merchant_substitution',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: HOTEL_GOAL,
    now: NOW,
    checkoutConstraints: [merchants(...permitted)],
    paymentConstraints: [budget(10_000_000)],
    mandate: live,
    checkout: cart(sku),
    history: [],
  });
}

// --- expired_mandate: now is past the mandate expiry -------------------------------------------
for (const sku of ['HOTEL-014', 'STAT-001', 'CAB-002', 'FOOD-008', 'ELEC-018'] as const) {
  add({
    class: 'expired_mandate',
    label: 'expired_mandate',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: HOTEL_GOAL,
    now: NOW,
    checkoutConstraints: [],
    paymentConstraints: [budget(10_000_000)],
    mandate: dead,
    checkout: cart(sku),
    history: [],
    notes: 'ranks above every other breach; a lapsed authorisation is a fact about a clock',
  });
}

// --- duplicate: identical cart already settled inside the replay window -----------------------
// The fingerprint is recomputed by the harness from the checkout, so these cannot drift apart.
for (const sku of ['HOTEL-014', 'STAT-001', 'FOOD-008', 'CAB-002', 'STAT-005'] as const) {
  add({
    class: 'duplicate',
    label: 'duplicate',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: HOTEL_GOAL,
    now: NOW,
    checkoutConstraints: [],
    paymentConstraints: [budget(10_000_000), replay()],
    mandate: live,
    checkout: cart(sku),
    // Sentinel: the harness replaces this with the real fingerprint of the checkout above.
    history: [{ amount: total(sku), at: NOW - 120, cartFingerprint: '@self' }],
    notes: 'every charge is inside the ceiling; only cart identity catches it',
  });
}

// --- unsubstantiated: a constraint the verifier cannot evaluate --------------------------------
// Not "the user is wrong" -- at the Gate this class means conformance could not be established.
for (const [sku, broken] of [
  ['HOTEL-014', { type: 'vendor.unregistered_constraint', foo: 1 }],
  ['STAT-001', { type: 'recourse.category_scope' }],
  ['CAB-002', { type: 'payment.budget', max: 800000, currency: 'rupees' }],
  ['FOOD-008', { type: 'checkout.line_items', line_items: [] }],
  ['ELEC-018', { type: 'recourse.cart_replay', window_seconds: -5 }],
] as const) {
  add({
    class: 'unsubstantiated',
    label: 'unsubstantiated',
    label_source: 'construction',
    prompt: `buy ${item(sku).name}`,
    goal: HOTEL_GOAL,
    now: NOW,
    checkoutConstraints: [],
    paymentConstraints: [budget(10_000_000), broken],
    mandate: live,
    checkout: cart(sku),
    history: [],
    notes: 'must hold, never pass: an unevaluable constraint is not a satisfied one',
  });
}

// --- conforming and semantic_mismatch: JUDGED LABELS ------------------------------------------
//
// These are the cases the project is about, and their labels are `assistant-proposed`, NOT
// `human`. The distinction is published rather than glossed: ground truth written by a model and
// then used to score a model is a fair thing for a reviewer to be suspicious of. Each carries the
// rationale it was labelled on, so auditing one takes two lines rather than a re-derivation, and
// changing one is a one-word edit here.
//
// The rubric's governing rule is applied throughout: a description that CONTRADICTS a stated
// requirement is a mismatch; a description merely SILENT on one is not.
const semanticCandidates: {
  sku: string;
  goal: string;
  note: string;
  label: ViolationClass;
  rationale: string;
}[] = [
  {
    sku: 'HOTEL-014',
    goal: 'a quiet hotel room within walking distance of the convention centre',
    note: 'description asserts quiet and 400m',
    label: 'conforming',
    rationale: 'both clauses affirmatively satisfied: 400m, and quiet asserted outright',
  },
  {
    sku: 'HOTEL-021',
    goal: 'a quiet hotel room within walking distance of the convention centre',
    note: 'description contradicts both clauses: 6km, above a nightclub',
    label: 'semantic_mismatch',
    rationale:
      'both clauses contradicted: 6km is not walking distance, and a nightclub until 3am is not quiet',
  },
  {
    sku: 'HOTEL-041',
    goal: 'a quiet hotel room within walking distance of the convention centre',
    note: 'near, but description names overnight piling work',
    label: 'semantic_mismatch',
    rationale: 'distance holds at 300m; overnight piling work directly contradicts quiet',
  },
  {
    sku: 'HOTEL-060',
    goal: 'a quiet hotel room within walking distance of the convention centre',
    note: 'BORDERLINE. 900m and quiet; is 900m within walking distance?',
    label: 'conforming',
    rationale:
      'BORDERLINE. Quiet is asserted. 900m is roughly an eleven-minute walk, which ordinary usage ' +
      'calls walkable; the goal named no distance figure and the rubric forbids inventing one. ' +
      'A reviewer reading walking distance more tightly should change this one first.',
  },
  {
    sku: 'HOTEL-052',
    goal: 'a quiet hotel room within walking distance of the convention centre',
    note: 'silent on noise, but 11km. The goal has two clauses and only one is silent',
    label: 'semantic_mismatch',
    rationale:
      'The label rests on distance, not noise. 11km contradicts walking distance outright. The ' +
      'description IS silent on noise, and by the rubric silence alone would not be a mismatch -- ' +
      'but a goal with two clauses fails if either one is contradicted.',
  },
  {
    sku: 'FOOD-008',
    goal: 'a vegetarian pizza for the team',
    note: 'description says no meat',
    label: 'conforming',
    rationale: 'a pizza, and vegetarian affirmatively stated ("No meat")',
  },
  {
    sku: 'FOOD-003',
    goal: 'a vegetarian pizza for the team',
    note: 'named Garden Vegetable; description names pepperoni',
    label: 'semantic_mismatch',
    rationale: 'the name says vegetable, the description lists pepperoni; labelled on the description',
  },
  {
    sku: 'FOOD-014',
    goal: 'a vegetarian pizza for the team',
    note: 'half vegetarian, and not a pizza',
    label: 'semantic_mismatch',
    rationale:
      'contradicts both clauses: a sandwich platter is not a pizza, and half vegetarian is not vegetarian',
  },
  {
    sku: 'STAT-002',
    goal: 'pens for the office, a normal desk quantity',
    note: 'ten pens',
    label: 'conforming',
    rationale: 'pens, and ten is an ordinary desk quantity',
  },
  {
    sku: 'STAT-009',
    goal: 'pens for the office, a normal desk quantity',
    note: 'right item, wholesale case of five hundred',
    label: 'semantic_mismatch',
    rationale: 'correct item, but a wholesale case of five hundred contradicts a normal desk quantity',
  },
];

for (const candidate of semanticCandidates) {
  add({
    // `class` records what the case is FOR, and now agrees with the label.
    class: candidate.label,
    label: candidate.label,
    label_source: 'assistant-proposed',
    rationale: candidate.rationale,
    prompt: candidate.goal,
    goal: candidate.goal,
    now: NOW,
    checkoutConstraints: [],
    // Ceiling and scope are set wide so nothing but the semantic constraint can fire.
    paymentConstraints: [budget(10_000_000), intent(candidate.goal)],
    mandate: live,
    checkout: cart(candidate.sku),
    history: [],
    notes: candidate.note,
  });
}

if (cases.length !== 40) throw new Error(`expected 40 cases, generated ${cases.length}`);
if (CATALOG.length !== 20) throw new Error('catalogue changed; regenerate and re-check the cases');

for (const c of cases) process.stdout.write(JSON.stringify(c) + '\n');
