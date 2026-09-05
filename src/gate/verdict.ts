/**
 * The Gate's ruling, and the token that proves one.
 *
 * `AllowToken` is how "Razorpay is never called until the Gate says yes" becomes something the
 * compiler enforces rather than something a comment asks for. Every money-moving function in
 * rail/ requires one, so a call site that has not been through the Gate does not compile.
 *
 * Types erase at runtime, so that alone is not enough -- `{} as AllowToken` compiles fine. The
 * token therefore also carries a module-private symbol that no other file can name, and the rail
 * asserts it. A forged token fails at the boundary instead of reaching a payment API.
 */

import type { Paise } from '../money.js';
import type { Merchant } from '../ap2/checkout.js';
import type { EvaluatedConstraint } from '../ap2/constraints/registry.js';
import { DEFAULT_ACTION_BY_CLASS, type Action, type ViolationClass } from '../taxonomy.js';

/** Not exported. A token cannot be constructed outside this module because this cannot be named. */
const ALLOW_PROOF: unique symbol = Symbol('recourse.gate.allow');

export interface AllowToken {
  /** Present only on tokens minted here. */
  readonly proof: typeof ALLOW_PROOF;
  readonly transactionId: string;
  /** The exact amount authorised. The rail refuses to charge anything else. */
  readonly amount: Paise;
  readonly payee: Merchant;
  /** Ties the token to the `gate_verdict` event that produced it. */
  readonly verdictHash: string;
  readonly issuedAt: number;
}

export interface Verdict {
  readonly action: Action;
  readonly transactionId: string;
  /** Every constraint that was evaluated, in evaluation order, with its outcome. */
  readonly constraints: readonly EvaluatedConstraint[];
  /** `conforming` when nothing was violated. The most severe violation otherwise. */
  readonly classification: ViolationClass;
  /** Human-readable, one line per constraint that contributed to the action. */
  readonly reasons: readonly string[];
  /** Pinned so a probabilistic ruling can be re-run against the same configuration. */
  readonly judge?: { readonly model: string; readonly promptVersion: string } | undefined;
  /** Epoch milliseconds. */
  readonly evaluatedAt: number;
  /** True when a non-deterministic constraint contributed. See semantic-intent.ts. */
  readonly usedNonDeterministicEvaluation: boolean;
}

const SEVERITY: Readonly<Record<Action, number>> = { allow: 0, hold: 1, deny: 2 };

export function moreSevere(a: Action, b: Action): Action {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** The action an outcome implies: an evaluator's explicit override, else the class default. */
export function actionForClass(classification: ViolationClass, override?: Action): Action {
  return override ?? DEFAULT_ACTION_BY_CLASS[classification];
}

export class GateError extends Error {}

/**
 * Mint a token for an allow verdict.
 *
 * Exported because gate.ts must call it, and guarded so that exporting it costs nothing: a
 * verdict whose action is not `allow` is refused here, so the only way to obtain a token is to
 * have produced a passing verdict.
 */
export function mintAllowToken(
  verdict: Verdict,
  amount: Paise,
  payee: Merchant,
  verdictHash: string,
): AllowToken {
  if (verdict.action !== 'allow') {
    throw new GateError(
      `refusing to mint an allow token for a "${verdict.action}" verdict on ` +
        `${verdict.transactionId}`,
    );
  }
  return {
    proof: ALLOW_PROOF,
    transactionId: verdict.transactionId,
    amount,
    payee,
    verdictHash,
    issuedAt: verdict.evaluatedAt,
  };
}

/**
 * Runtime check for the rail. Catches the case the type system cannot: an object literal cast to
 * `AllowToken` with `as`, which compiles and would otherwise reach a payment API.
 */
export function assertAllowToken(token: AllowToken, context: string): void {
  if (!token || (token as { proof?: unknown }).proof !== ALLOW_PROOF) {
    throw new GateError(
      `${context} was called with something that is not a Gate-issued allow token; ` +
        `no payment will be attempted`,
    );
  }
}
