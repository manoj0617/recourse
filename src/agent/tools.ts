/**
 * The agent's tools. Four, and only one of them touches money.
 *
 * There are no guardrails in this file, and that is deliberate. Every instinct says to check the
 * budget inside `proposeCart` and refuse to build a cart that breaches it. Doing so would move
 * enforcement into the agent, where it is one prompt injection or one model mistake away from
 * being skipped, and would make the Gate untestable -- you cannot demonstrate a Gate refusing
 * anything if nothing is ever capable of overreach.
 *
 * The agent is therefore free to build a cart at any price, from any merchant, in any category,
 * as many times as it likes. `submitPurchase` is the only route to the rail, and it goes through
 * the Gate. Razorpay's MCP server is deliberately NOT among these tools: handing the shopping
 * agent direct rail access would defeat the whole arrangement. arXiv 2608.23858 makes the same
 * argument about pre-authorisation MCP tool calls sitting outside mandate protection.
 */

import { z } from 'zod';
import { checkoutSchema, type Checkout } from '../ap2/checkout.js';
import { CATALOG, getItem, merchantFor, searchCatalog, type CatalogItem } from '../catalog.js';
import { formatINR, multiply, paise, sum } from '../money.js';
import type { ToolDefinition } from '../judge/transport.js';
import type { Verdict } from '../gate/verdict.js';

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'searchCatalog',
      description: 'Search the catalogue by keywords. Returns matching items with prices.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords to search for.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getItem',
      description: 'Fetch the full record for one catalogue item by SKU.',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string' } },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'proposeCart',
      description:
        'Assemble a cart from catalogue items. All items must come from the same merchant. ' +
        'Returns the cart and its total. Does not buy anything.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
              required: ['sku', 'quantity'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitPurchase',
      description:
        'Submit the proposed cart for authorisation. This is the only way to buy anything. ' +
        'Returns the authorisation decision: allow, hold or deny, with reasons.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const proposeArgsSchema = z.object({
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
});

function renderItem(item: CatalogItem): string {
  return (
    `${item.sku} | ${item.name} | ${item.category} | ${formatINR(paise(item.unitPrice))} | ` +
    `${merchantFor(item).name} | ${item.description}`
  );
}

export interface AgentSession {
  /** The cart currently on the table. Replaced by each `proposeCart` call. */
  proposed?: Checkout;
  /** Every cart the agent proposed, in order. Recorded so the ledger can show what it considered. */
  readonly proposals: Checkout[];
  /** Items the agent looked at. Without this, "it had no better option" is unfalsifiable. */
  readonly inspected: string[];
  verdict?: Verdict;
}

export function newSession(): AgentSession {
  return { proposals: [], inspected: [] };
}

export interface ToolContext {
  readonly session: AgentSession;
  readonly now: number;
  /** Runs the Gate. Injected so the agent module has no route to the rail at all. */
  readonly submit: (checkout: Checkout) => Promise<Verdict>;
}

/**
 * Build a cart. Refuses only what is incoherent -- an unknown SKU, or items from two different
 * merchants, which is not a policy judgement but a thing a Checkout cannot represent. Price,
 * category, quantity and repetition are all the Gate's business, not this function's.
 */
function buildCheckout(
  args: z.infer<typeof proposeArgsSchema>,
  now: number,
  sequence: number,
): Checkout {
  const resolved = args.items.map((requested) => {
    const item = getItem(requested.sku);
    if (!item) throw new Error(`no catalogue item with SKU ${requested.sku}`);
    return { item, quantity: requested.quantity };
  });

  const merchantIds = new Set(resolved.map(({ item }) => item.merchantId));
  if (merchantIds.size > 1) {
    throw new Error(
      `a cart cannot span merchants; got ${[...merchantIds].join(', ')}. Propose one cart per merchant.`,
    );
  }

  const first = resolved[0];
  if (!first) throw new Error('a cart must contain at least one item');

  const lineItems = resolved.map(({ item, quantity }) => ({ ...item, quantity }));
  const total = sum(lineItems.map((li) => multiply(paise(li.unitPrice), li.quantity)));

  return checkoutSchema.parse({
    id: `chk_${sequence}_${now}`,
    merchant: merchantFor(first.item),
    lineItems,
    currency: 'INR',
    total,
    createdAt: now,
  });
}

/** Execute one tool call. Errors are returned as text for the model to read, not thrown. */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<string> {
  let args: unknown;
  try {
    args = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return `Error: arguments for ${name} were not valid JSON.`;
  }

  try {
    switch (name) {
      case 'searchCatalog': {
        const query = (args as { query?: string }).query ?? '';
        const hits = searchCatalog(query);
        if (hits.length === 0) {
          return `No matches for "${query}". The catalogue has ${CATALOG.length} items.`;
        }
        hits.forEach((h) => ctx.session.inspected.push(h.sku));
        return ['SKU | Name | Category | Price | Merchant | Description', ...hits.map(renderItem)].join('\n');
      }

      case 'getItem': {
        const sku = (args as { sku?: string }).sku ?? '';
        const item = getItem(sku);
        if (!item) return `No catalogue item with SKU ${sku}.`;
        ctx.session.inspected.push(sku);
        return renderItem(item);
      }

      case 'proposeCart': {
        const parsed = proposeArgsSchema.safeParse(args);
        if (!parsed.success) return `Error: ${parsed.error.issues[0]?.message ?? 'bad arguments'}`;
        const checkout = buildCheckout(parsed.data, ctx.now, ctx.session.proposals.length);
        ctx.session.proposed = checkout;
        ctx.session.proposals.push(checkout);
        return (
          `Cart ${checkout.id} at ${checkout.merchant.name}: ` +
          checkout.lineItems.map((li) => `${li.quantity}x ${li.sku}`).join(', ') +
          `. Total ${formatINR(checkout.total)}. Not yet purchased.`
        );
      }

      case 'submitPurchase': {
        const checkout = ctx.session.proposed;
        if (!checkout) return 'Error: no cart has been proposed yet. Call proposeCart first.';
        const verdict = await ctx.submit(checkout);
        ctx.session.verdict = verdict;
        const reasons = verdict.reasons.length > 0 ? ` Reasons: ${verdict.reasons.join('; ')}` : '';
        return `Authorisation decision: ${verdict.action.toUpperCase()} (${verdict.classification}).${reasons}`;
      }

      default:
        return `Error: no tool named ${name}.`;
    }
  } catch (cause) {
    return `Error: ${(cause as Error).message}`;
  }
}
