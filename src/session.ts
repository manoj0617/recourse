/**
 * The wiring. Everything else in this project is a component with a narrow job; this is where a
 * purchase actually happens, in order, with each step written to the ledger as it occurs.
 *
 * The order is the argument:
 *
 *   user prompt -> mandates issued -> agent runs -> cart proposed -> GATE -> rail
 *
 * The rail appears once, after the Gate, and takes an `AllowToken` the Gate is the only source of.
 * The agent is handed a `submit` callback and nothing else; it has no client, no keys and no
 * network. If this file were deleted, no other module could reach Razorpay.
 *
 * One thing is simulated and is labelled as simulated everywhere it appears: payment CAPTURE.
 * Creating an order against Razorpay test keys is a real API call and is done for real. Completing
 * the payment requires a human in a browser finishing a checkout, which a scripted demo cannot do,
 * so `simulateCapture` writes the capture event without money having moved. The event records
 * `simulated: true` and the console prints it. Claiming a captured payment that did not happen
 * would be the one dishonesty that invalidates every downstream ruling.
 */

import { runAgent, type AgentRun } from './agent/agent.js';
import { newSession } from './agent/tools.js';
import { cartFingerprint, type Checkout } from './ap2/checkout.js';
import type { ConstraintContext, MandateHistory } from './ap2/constraints/types.js';
import {
  constraintsOf,
  issueOpenCheckoutMandate,
  issueOpenPaymentMandate,
  type Authorisation,
} from './ap2/mandate.js';
import type { KeyPair } from './crypto/keys.js';
import { evaluate } from './gate/gate.js';
import { mintAllowToken, type AllowToken, type Verdict } from './gate/verdict.js';
import type { ConformanceJudge } from './judge/types.js';
import type { Transport } from './judge/transport.js';
import { Ledger } from './ledger/ledger.js';
import { paise, type Paise } from './money.js';
import { createOrder, type RailClient, type RailOrder } from './rail/razorpay.js';

export interface PurchaseRequest {
  readonly transactionId: string;
  /** The user's instruction, in their words. */
  readonly prompt: string;
  readonly checkoutConstraints: readonly { type: string }[];
  readonly paymentConstraints: readonly { type: string }[];
  readonly mandate: { readonly iat: number; readonly exp: number };
  /** Epoch seconds. Injected so a run is reproducible. */
  readonly now: number;
  /** Spend already settled under this mandate. Feeds budget, recurrence and replay. */
  readonly history?: MandateHistory;
}

export interface SessionDeps {
  readonly ledger: Ledger;
  readonly judge: ConformanceJudge;
  readonly transport: Transport;
  readonly model: string;
  readonly keys: KeyPair;
  /** Absent means no rail calls are attempted at all, and the run stops after the verdict. */
  readonly rail?: RailClient | undefined;
  /** See the note at the top of this file. Defaults to false. */
  readonly simulateCapture?: boolean;
}

export interface PurchaseOutcome {
  readonly transactionId: string;
  readonly run: AgentRun;
  readonly verdict?: Verdict | undefined;
  readonly order?: RailOrder | undefined;
  readonly captured?: Paise | undefined;
  readonly token?: AllowToken | undefined;
}

/** The goal from a `recourse.semantic_intent` constraint, if one was authorised. */
function goalOf(auth: Authorisation): string | undefined {
  for (const c of constraintsOf(auth)) {
    if (c.type === 'recourse.semantic_intent') {
      const goal = (c as { goal?: unknown }).goal;
      if (typeof goal === 'string') return goal;
    }
  }
  return undefined;
}

export async function runPurchase(
  request: PurchaseRequest,
  deps: SessionDeps,
): Promise<PurchaseOutcome> {
  const { ledger, judge, transport, model, keys } = deps;
  const t = { transactionId: request.transactionId };
  const atMs = request.now * 1000;

  ledger.append({ ...t, type: 'user_prompt', at: atMs, data: { prompt: request.prompt } });

  const auth: Authorisation = {
    checkout: {
      vct: 'mandate.checkout.open.1',
      constraints: [...request.checkoutConstraints],
      ...request.mandate,
    },
    payment: {
      vct: 'mandate.payment.open.1',
      constraints: [...request.paymentConstraints],
      ...request.mandate,
    },
  };

  // Sign the mandates for real. The compact JWS goes into the ledger so a later replay can verify
  // the authorisation was not edited after the fact, independently of the hash chain.
  const [checkoutJws, paymentJws] = await Promise.all([
    issueOpenCheckoutMandate(request.checkoutConstraints, keys, request.mandate),
    issueOpenPaymentMandate(request.paymentConstraints, keys, request.mandate),
  ]);

  ledger.append({
    ...t,
    type: 'mandate_issued',
    at: atMs + 1,
    data: {
      constraints: constraintsOf(auth),
      checkoutMandate: checkoutJws,
      paymentMandate: paymentJws,
      kid: keys.kid,
    },
  });

  const history: MandateHistory = request.history ?? { closedPayments: [] };
  let verdict: Verdict | undefined;

  // Owned here, not by the agent, because `submit` reads it mid-run -- before `runAgent` has
  // returned. Letting the agent allocate it would put this read in the temporal dead zone.
  const session = newSession();

  const submit = async (checkout: Checkout): Promise<Verdict> => {
    ledger.append({
      ...t,
      type: 'options_considered',
      at: atMs + 2,
      data: { skus: [...new Set(session.inspected)] },
    });
    ledger.append({
      ...t,
      type: 'cart_proposed',
      at: atMs + 3,
      data: {
        id: checkout.id,
        merchant: checkout.merchant.name,
        total: checkout.total,
        fingerprint: cartFingerprint(checkout),
        items: checkout.lineItems.map((li) => ({
          sku: li.sku,
          name: li.name,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
        })),
      },
    });

    const ctx: ConstraintContext = {
      checkout,
      payment: { amount: checkout.total, payee: checkout.merchant, currency: 'INR' },
      now: request.now,
      history,
      judge,
    };

    verdict = await evaluate(auth, ctx, request.transactionId);

    ledger.append({
      ...t,
      type: 'gate_verdict',
      at: atMs + 4,
      data: {
        action: verdict.action,
        classification: verdict.classification,
        reasons: verdict.reasons,
        judgeModel: verdict.judge?.model,
        promptVersion: verdict.judge?.promptVersion,
        constraints: verdict.constraints.map((c) => ({
          type: c.type,
          origin: c.origin,
          status: c.outcome.status,
          reason: c.outcome.reason,
        })),
      },
    });

    if (verdict.action !== 'allow') {
      ledger.append({
        ...t,
        type: 'escalated',
        at: atMs + 5,
        data: { action: verdict.action, classification: verdict.classification, reasons: verdict.reasons },
      });
    }

    return verdict;
  };

  const run = await runAgent({
    transport,
    model,
    prompt: request.prompt,
    submit,
    now: request.now,
    session,
  });

  if (!verdict || verdict.action !== 'allow' || !run.session.proposed) {
    return { transactionId: request.transactionId, run, verdict };
  }

  const checkout = run.session.proposed;
  const verdictEvent = ledger.all().findLast((e) => e.type === 'gate_verdict');
  const token = mintAllowToken(verdict, checkout.total, checkout.merchant, verdictEvent?.hash ?? '');

  if (!deps.rail) {
    return { transactionId: request.transactionId, run, verdict, token };
  }

  const order = await createOrder(deps.rail, token, request.transactionId);
  ledger.append({
    ...t,
    type: 'rail_order_created',
    at: atMs + 6,
    data: { orderId: order.id, amount: order.amount, status: order.status },
  });

  if (!deps.simulateCapture) {
    return { transactionId: request.transactionId, run, verdict, order, token };
  }

  // Simulated. Completing a real Razorpay payment needs a browser; this writes the event a
  // capture webhook would have written, and marks it so nothing downstream can mistake it.
  const captured = paise(order.amount);
  ledger.append({
    ...t,
    type: 'rail_payment_captured',
    at: atMs + 7,
    data: {
      paymentId: `pay_simulated_${request.transactionId}`,
      orderId: order.id,
      amount: captured,
      simulated: true,
    },
  });

  return { transactionId: request.transactionId, run, verdict, order, captured, token };
}

/** Convenience for callers assembling a `history` from a settled purchase. */
export function settledFrom(checkout: Checkout, at: number) {
  return { amount: checkout.total, at, cartFingerprint: cartFingerprint(checkout) };
}

export { Ledger, goalOf };
