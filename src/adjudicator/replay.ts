/**
 * Reconstruct what happened in one transaction from the ledger alone.
 *
 * The rule this module exists to enforce: an adjudication may use nothing except the chain. If a
 * fact is not in the events, it is not established, and the ruling has to reflect that rather than
 * reaching into live application state for it. That is what makes a ruling reproducible months
 * later, and it is also what makes the chain worth keeping -- a log nobody is forced to rely on
 * drifts out of sync with reality without anyone noticing.
 */

import { formatINR, paise, type Paise } from '../money.js';
import type { LedgerEvent } from '../ledger/events.js';
import { verifyChain, type ChainVerification } from '../ledger/ledger.js';

/** A cart line as it was recorded. Prices are integer paise, as everywhere else. */
export interface ReplayedItem {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface ReplayedTransaction {
  readonly transactionId: string;
  /** Whether the evidence can be trusted at all. Checked before anything is read from it. */
  readonly chain: ChainVerification;
  readonly prompt?: string;
  /** The `recourse.semantic_intent` goal, if one was authorised. */
  readonly goal?: string;
  readonly constraints: readonly { type: string }[];
  /** SKUs the agent looked at before choosing. Makes "it had no better option" checkable. */
  readonly optionsConsidered: readonly string[];
  readonly cart?: {
    readonly id: string;
    readonly merchant: string;
    readonly items: readonly ReplayedItem[];
    readonly total: Paise;
  };
  readonly verdict?: {
    readonly action: string;
    readonly classification: string;
    readonly reasons: readonly string[];
    readonly judgeModel?: string;
    readonly promptVersion?: string;
  };
  readonly orderId?: string;
  readonly paymentId?: string;
  readonly capturedAmount?: Paise;
  readonly refunded: Paise;
  readonly events: readonly LedgerEvent[];
}

function str(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' ? v : undefined;
}

function num(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Reconstruct one transaction from the WHOLE log.
 *
 * The whole log is required rather than a convenient slice, and the signature enforces it. Chain
 * integrity is a property of the entire chain and cannot be checked on a subset: the events of one
 * transaction have non-contiguous `seq` values and their `prevHash` links point at events
 * belonging to other transactions. Verifying a slice reports a break in an intact log -- and since
 * the adjudicator refuses to rule on a broken chain, that would have it decline every dispute in
 * any ledger holding more than one transaction.
 */
export function replay(
  allEvents: readonly LedgerEvent[],
  transactionId?: string,
): ReplayedTransaction {
  // Verified across the full log, then filtered. Never the other way round.
  const chain = verifyChain(allEvents);
  const events =
    transactionId === undefined
      ? allEvents
      : allEvents.filter((e) => e.transactionId === transactionId);
  const resolvedId = transactionId ?? events[0]?.transactionId ?? 'unknown';

  const out: {
    prompt?: string;
    goal?: string;
    constraints: { type: string }[];
    optionsConsidered: string[];
    cart?: ReplayedTransaction['cart'];
    verdict?: ReplayedTransaction['verdict'];
    orderId?: string;
    paymentId?: string;
    capturedAmount?: Paise;
    refunded: number;
  } = { constraints: [], optionsConsidered: [], refunded: 0 };

  for (const event of events) {
    const d = event.data;
    switch (event.type) {
      case 'user_prompt': {
        const prompt = str(d, 'prompt');
        if (prompt !== undefined) out.prompt = prompt;
        break;
      }

      case 'mandate_issued': {
        const constraints = d['constraints'];
        if (Array.isArray(constraints)) {
          for (const c of constraints as { type?: string }[]) {
            if (typeof c?.type === 'string') out.constraints.push({ type: c.type });
            const goal = (c as { goal?: string }).goal;
            if (c?.type === 'recourse.semantic_intent' && typeof goal === 'string') out.goal = goal;
          }
        }
        break;
      }

      case 'options_considered': {
        const skus = d['skus'];
        if (Array.isArray(skus)) out.optionsConsidered.push(...(skus as string[]));
        break;
      }

      case 'cart_proposed': {
        const items: ReplayedItem[] = Array.isArray(d['items']) ? (d['items'] as ReplayedItem[]) : [];
        out.cart = {
          id: str(d, 'id') ?? 'unknown',
          merchant: str(d, 'merchant') ?? 'unknown',
          items,
          total: paise(num(d, 'total') ?? 0),
        };
        break;
      }

      case 'gate_verdict': {
        const reasons = Array.isArray(d['reasons']) ? (d['reasons'] as string[]) : [];
        out.verdict = {
          action: str(d, 'action') ?? 'unknown',
          classification: str(d, 'classification') ?? 'unknown',
          reasons,
          ...(str(d, 'judgeModel') ? { judgeModel: str(d, 'judgeModel') as string } : {}),
          ...(str(d, 'promptVersion') ? { promptVersion: str(d, 'promptVersion') as string } : {}),
        };
        break;
      }

      case 'rail_order_created': {
        const orderId = str(d, 'orderId');
        if (orderId !== undefined) out.orderId = orderId;
        break;
      }

      case 'rail_payment_captured': {
        const paymentId = str(d, 'paymentId');
        if (paymentId !== undefined) out.paymentId = paymentId;
        out.capturedAmount = paise(num(d, 'amount') ?? 0);
        break;
      }

      case 'refund_issued':
        out.refunded += num(d, 'amount') ?? 0;
        break;

      default:
        break;
    }
  }

  return {
    transactionId: resolvedId,
    chain,
    ...(out.prompt === undefined ? {} : { prompt: out.prompt }),
    ...(out.goal === undefined ? {} : { goal: out.goal }),
    constraints: out.constraints,
    optionsConsidered: out.optionsConsidered,
    ...(out.cart === undefined ? {} : { cart: out.cart }),
    ...(out.verdict === undefined ? {} : { verdict: out.verdict }),
    ...(out.orderId === undefined ? {} : { orderId: out.orderId }),
    ...(out.paymentId === undefined ? {} : { paymentId: out.paymentId }),
    ...(out.capturedAmount === undefined ? {} : { capturedAmount: out.capturedAmount }),
    refunded: paise(out.refunded),
    events,
  };
}

/**
 * Render the reconstruction for the adjudicating model.
 *
 * Every fact the model is allowed to reason over appears here in full, so that during a later
 * review the exact input to the ruling can be rebuilt from the ledger instead of guessed at.
 * Absent facts are stated as absent rather than omitted -- "no options recorded" and "options were
 * recorded but empty" are different, and only one of them should count against the agent.
 */
export function renderChain(r: ReplayedTransaction): string {
  const lines: string[] = [`Transaction: ${r.transactionId}`];

  lines.push(
    r.chain.valid
      ? `Evidence chain: intact, ${r.chain.length} events.`
      : `Evidence chain: BROKEN at event ${r.chain.brokenAt}. ${r.chain.reason}`,
  );

  lines.push(`User instruction: ${r.prompt ?? '(not recorded)'}`);
  lines.push(`Authorised goal: ${r.goal ?? '(no semantic intent constraint was authorised)'}`);
  lines.push(
    `Constraints authorised: ${
      r.constraints.length > 0 ? r.constraints.map((c) => c.type).join(', ') : '(none recorded)'
    }`,
  );
  lines.push(
    `Options the agent considered: ${
      r.optionsConsidered.length > 0 ? r.optionsConsidered.join(', ') : '(none recorded)'
    }`,
  );

  if (r.cart) {
    lines.push(`Cart ${r.cart.id} at ${r.cart.merchant}:`);
    for (const item of r.cart.items) {
      lines.push(`  - ${item.quantity}x ${item.sku} ${item.name} @ ${formatINR(paise(item.unitPrice))}`);
    }
    lines.push(`  Total: ${formatINR(r.cart.total)}`);
  } else {
    lines.push('Cart: (not recorded)');
  }

  if (r.verdict) {
    lines.push(
      `Gate decision: ${r.verdict.action} (${r.verdict.classification})` +
        (r.verdict.judgeModel ? ` [judge ${r.verdict.judgeModel} ${r.verdict.promptVersion ?? ''}]` : ''),
    );
    for (const reason of r.verdict.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push('Gate decision: (not recorded)');
  }

  lines.push(`Rail: order ${r.orderId ?? '(none)'}, payment ${r.paymentId ?? '(none)'}`);
  lines.push(
    `Captured: ${r.capturedAmount === undefined ? '(nothing captured)' : formatINR(r.capturedAmount)}` +
      `, already refunded: ${formatINR(r.refunded)}`,
  );

  return lines.join('\n');
}
