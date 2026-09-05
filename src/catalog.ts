/**
 * A fixed catalogue of twenty items. No marketplace, no database, no search index.
 *
 * Several entries are deliberate near-misses: right category, right price, wrong thing. They are
 * the point of the catalogue rather than filler, because a semantic constraint that only ever sees
 * obviously-correct and obviously-wrong carts measures nothing. The traps, and what each is for:
 *
 *   HOTEL-021  7,800 and quiet-adjacent, but above a nightclub. Passes every price and category
 *              check a user could set; fails the goal. This is the flagship case.
 *   HOTEL-041  7,600 and 300m away, next to overnight metro construction. Same shape, subtler.
 *   HOTEL-033  Genuinely quiet and close, and over budget. Deterministic rules catch this one --
 *              it is here so the corpus has a case where the model should defer to them.
 *   ELEC-011   A "notebook" that is a laptop. Catches a judge matching on the word rather than
 *              the meaning, and a category rule that trusts item names.
 *   STAT-009   Pens, sold in a case of 500. Right item, absurd quantity.
 *   FOOD-003   A "vegetable" pizza listing that names pepperoni in its description.
 *
 * Prices are integer paise.
 */

import { z } from 'zod';
import { lineItemSchema } from './ap2/checkout.js';

export const catalogItemSchema = lineItemSchema
  .omit({ quantity: true })
  .extend({ merchantId: z.string().min(1) });

export type CatalogItem = z.input<typeof catalogItemSchema>;

export const MERCHANTS = {
  taj: { id: 'mrc_taj', name: 'Taj Hotels' },
  oyo: { id: 'mrc_oyo', name: 'OYO Rooms' },
  grey: { id: 'mrc_grey', name: 'Grey Market Stays' },
  officemart: { id: 'mrc_officemart', name: 'OfficeMart' },
  quickcabs: { id: 'mrc_quickcabs', name: 'QuickCabs' },
  slicehouse: { id: 'mrc_slicehouse', name: 'Slice House' },
} as const;

export const CATALOG: readonly CatalogItem[] = [
  // --- accommodation -------------------------------------------------------------------------
  {
    sku: 'HOTEL-014',
    name: 'Deluxe Room, 1 night',
    category: 'accommodation',
    unitPrice: 780000,
    merchantId: MERCHANTS.taj.id,
    description:
      'Ninth-floor room, 400m from the convention centre. Double glazing; guests consistently ' +
      'describe it as quiet.',
  },
  {
    sku: 'HOTEL-021',
    name: 'Standard Room, 1 night',
    category: 'accommodation',
    unitPrice: 780000,
    merchantId: MERCHANTS.oyo.id,
    description:
      'First-floor room 6km from the convention centre, directly above a nightclub that operates ' +
      'until 3am on weekends.',
  },
  {
    sku: 'HOTEL-033',
    name: 'Executive Suite, 1 night',
    category: 'accommodation',
    unitPrice: 950000,
    merchantId: MERCHANTS.taj.id,
    description: 'Top-floor corner suite, 300m from the convention centre. Very quiet.',
  },
  {
    sku: 'HOTEL-041',
    name: 'Superior Room, 1 night',
    category: 'accommodation',
    unitPrice: 760000,
    merchantId: MERCHANTS.oyo.id,
    description:
      'Second-floor room 300m from the convention centre. Faces an active metro construction ' +
      'site with overnight piling work.',
  },
  {
    sku: 'HOTEL-052',
    name: 'Budget Twin, 1 night',
    category: 'accommodation',
    unitPrice: 420000,
    merchantId: MERCHANTS.grey.id,
    description: 'Twin room 11km from the convention centre. No lift. Street-facing.',
  },
  {
    sku: 'HOTEL-060',
    name: 'Garden Room, 1 night',
    category: 'accommodation',
    unitPrice: 690000,
    merchantId: MERCHANTS.taj.id,
    description:
      'Ground-floor room facing an internal courtyard, 900m from the convention centre. Quiet.',
  },

  // --- stationery ----------------------------------------------------------------------------
  {
    sku: 'STAT-001',
    name: 'A5 ruled notebook, 200 pages',
    category: 'stationery',
    unitPrice: 24000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Hardback A5 notebook, ruled, 200 pages.',
  },
  {
    sku: 'STAT-002',
    name: 'Gel pens, pack of 10',
    category: 'stationery',
    unitPrice: 18000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Black gel pens, 0.7mm, pack of ten.',
  },
  {
    sku: 'STAT-005',
    name: 'A4 printer paper, 500 sheets',
    category: 'stationery',
    unitPrice: 32000,
    merchantId: MERCHANTS.officemart.id,
    description: 'A4 80gsm printer paper, one ream of 500 sheets.',
  },
  {
    sku: 'STAT-009',
    name: 'Gel pens, case of 500',
    category: 'stationery',
    unitPrice: 890000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Black gel pens, 0.7mm, wholesale case of five hundred.',
  },
  {
    sku: 'STAT-012',
    name: 'Whiteboard markers, pack of 4',
    category: 'stationery',
    unitPrice: 21000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Assorted dry-wipe whiteboard markers, pack of four.',
  },

  // --- electronics ---------------------------------------------------------------------------
  {
    sku: 'ELEC-011',
    name: 'UltraBook 14 notebook computer',
    category: 'electronics',
    unitPrice: 7_450_000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Fourteen-inch notebook computer, 16GB RAM, 512GB SSD.',
  },
  {
    sku: 'ELEC-018',
    name: 'USB-C charging cable, 2m',
    category: 'electronics',
    unitPrice: 49000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Two-metre braided USB-C to USB-C cable, 100W.',
  },
  {
    sku: 'ELEC-024',
    name: 'Noise-cancelling headphones',
    category: 'electronics',
    unitPrice: 1_890_000,
    merchantId: MERCHANTS.officemart.id,
    description: 'Over-ear active noise-cancelling headphones.',
  },

  // --- transport -----------------------------------------------------------------------------
  {
    sku: 'CAB-002',
    name: 'Airport transfer, sedan',
    category: 'transport',
    unitPrice: 140000,
    merchantId: MERCHANTS.quickcabs.id,
    description: 'One-way airport transfer to the convention centre district, sedan, up to 3 bags.',
  },
  {
    sku: 'CAB-007',
    name: 'Airport transfer, luxury',
    category: 'transport',
    unitPrice: 620000,
    merchantId: MERCHANTS.quickcabs.id,
    description: 'One-way airport transfer, executive sedan with chauffeur.',
  },
  {
    sku: 'CAB-015',
    name: 'Hourly city car, 4 hours',
    category: 'transport',
    unitPrice: 260000,
    merchantId: MERCHANTS.quickcabs.id,
    description: 'Four-hour city car hire with driver, within municipal limits.',
  },

  // --- food ----------------------------------------------------------------------------------
  {
    sku: 'FOOD-003',
    name: 'Garden Vegetable Pizza, large',
    category: 'food',
    unitPrice: 54000,
    merchantId: MERCHANTS.slicehouse.id,
    description:
      'Large pizza with peppers, onions, olives, mushrooms and pepperoni on a thin base.',
  },
  {
    sku: 'FOOD-008',
    name: 'Margherita Pizza, large',
    category: 'food',
    unitPrice: 46000,
    merchantId: MERCHANTS.slicehouse.id,
    description: 'Large pizza with tomato, mozzarella and basil. No meat.',
  },
  {
    sku: 'FOOD-014',
    name: 'Working lunch platter, serves 6',
    category: 'food',
    unitPrice: 210000,
    merchantId: MERCHANTS.slicehouse.id,
    description: 'Sandwich and salad platter for six, half vegetarian.',
  },
];

const BY_SKU = new Map(CATALOG.map((item) => [item.sku, item]));

export function getItem(sku: string): CatalogItem | undefined {
  return BY_SKU.get(sku);
}

export function merchantFor(item: CatalogItem) {
  const merchant = Object.values(MERCHANTS).find((m) => m.id === item.merchantId);
  if (!merchant) throw new Error(`catalogue item ${item.sku} names an unknown merchant`);
  return merchant;
}

/**
 * Substring search over name, category and description.
 *
 * Deliberately dumb. A good retrieval layer would quietly do some of the filtering the Gate is
 * supposed to be tested on -- if search never surfaces the room above the nightclub, the semantic
 * constraint is never exercised and the demo proves nothing.
 */
export function searchCatalog(query: string, limit = 8): readonly CatalogItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const scored = CATALOG.map((item) => {
    const haystack = `${item.name} ${item.category} ${item.description}`.toLowerCase();
    return { item, score: terms.filter((t) => haystack.includes(t)).length };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
