/**
 * AP2 v0.2 built-in: `checkout.line_items`.
 * "Defines the sets of line items that are to be present."
 *
 * The spec evaluates this by matching item ids against the revealed `acceptable_items` arrays
 * using maximal flow logic, so that is what is implemented here rather than a per-item `includes`
 * check. The distinction matters: given two required sets that both accept SKU-A, and a cart with
 * one unit of SKU-A, a naive check reports both sets satisfied. A matching reports one, which is
 * the truth -- one unit cannot fill two slots.
 *
 * Line-item quantity is capacity. A cart line of quantity 3 is three units and can fill three
 * slots, which is why units are expanded before matching.
 */

import { z } from 'zod';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';
import type { Checkout } from '../checkout.js';

export const lineItemsSchema = z
  .object({
    type: z.literal('checkout.line_items'),
    /** Each entry is one slot that must be filled by a unit whose SKU it accepts. */
    line_items: z
      .array(z.object({ acceptable_items: z.array(z.string().min(1)).min(1) }).strict())
      .min(1),
  })
  .strict();

export type LineItemsConstraint = z.infer<typeof lineItemsSchema>;

/** One purchasable unit. A cart line of quantity n expands to n of these. */
interface Unit {
  readonly sku: string;
  readonly lineIndex: number;
}

function expandUnits(checkout: Checkout): Unit[] {
  const units: Unit[] = [];
  checkout.lineItems.forEach((li, lineIndex) => {
    for (let i = 0; i < li.quantity; i += 1) units.push({ sku: li.sku, lineIndex });
  });
  return units;
}

/**
 * Maximum bipartite matching between slots and units (Kuhn's augmenting-path algorithm).
 * Returns, for each slot, the index of the unit assigned to it, or -1 if unmatched.
 *
 * Kuhn's rather than a full max-flow implementation because unit capacities are already expanded,
 * which reduces the flow problem to plain bipartite matching. Carts are small; this is O(V*E) and
 * nowhere near a bottleneck.
 */
function maximumMatching(slots: readonly (readonly string[])[], units: readonly Unit[]): number[] {
  const unitToSlot = new Array<number>(units.length).fill(-1);

  const tryAssign = (slot: number, seen: boolean[]): boolean => {
    for (let u = 0; u < units.length; u += 1) {
      if (seen[u]) continue;
      const acceptable = slots[slot] as readonly string[];
      if (!acceptable.includes((units[u] as Unit).sku)) continue;
      seen[u] = true;
      const holder = unitToSlot[u] as number;
      if (holder === -1 || tryAssign(holder, seen)) {
        unitToSlot[u] = slot;
        return true;
      }
    }
    return false;
  };

  for (let s = 0; s < slots.length; s += 1) {
    tryAssign(s, new Array<boolean>(units.length).fill(false));
  }

  const slotToUnit = new Array<number>(slots.length).fill(-1);
  unitToSlot.forEach((slot, unit) => {
    if (slot !== -1) slotToUnit[slot] = unit;
  });
  return slotToUnit;
}

export const lineItems: ConstraintEvaluator<LineItemsConstraint> = {
  type: 'checkout.line_items',
  schema: lineItemsSchema,
  selectivelyDisclosable: ['line_items'],
  deterministic: true,
  origin: 'ap2-v0.2',
  evaluate(constraint, ctx) {
    const units = expandUnits(ctx.checkout);
    const slots = constraint.line_items.map((s) => s.acceptable_items);
    const assignment = maximumMatching(slots, units);

    const unfilled = assignment
      .map((unit, slot) => (unit === -1 ? slot : -1))
      .filter((slot) => slot !== -1);

    if (unfilled.length > 0) {
      const detail = unfilled
        .map((s) => `slot ${s} accepting [${(slots[s] as readonly string[]).join(', ')}]`)
        .join('; ');
      return violated(
        'category_violation',
        `cart does not contain a unit for every required line-item set: ${detail}`,
      );
    }

    // Every required slot is filled. Whether a cart may ALSO contain units outside every
    // acceptable set is not settled by the spec text; refusing them is the reading taken here,
    // because the alternative authorises an agent to append arbitrary items to a conforming cart.
    const matchedUnits = new Set(assignment.filter((u) => u !== -1));
    const extras = units
      .map((u, i) => ({ u, i }))
      .filter(({ i, u }) => !matchedUnits.has(i) && !slots.some((s) => s.includes(u.sku)));

    if (extras.length > 0) {
      const skus = [...new Set(extras.map(({ u }) => u.sku))].join(', ');
      return violated(
        'category_violation',
        `cart contains unit(s) outside every acceptable line-item set: ${skus}`,
      );
    }

    return satisfied(`all ${slots.length} required line-item set(s) matched by distinct units`);
  },
};
