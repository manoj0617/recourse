/**
 * Recourse extension: `recourse.category_scope`.
 *
 * Defined through the extension point AP2 v0.2 documents, which requires a uniquely defined
 * `type`, a schema stating which fields are selectively disclosable, and an evaluation algorithm.
 * All three are here.
 *
 * Why it exists: AP2 has no category vocabulary. `checkout.line_items` constrains a cart to an
 * enumerated set of SKUs, which is exact but requires the user to know every acceptable item in
 * advance. "Books and stationery, nothing else" is not expressible as a SKU list over a catalogue
 * the user has not seen. This constraint is structural and deterministic, so unlike
 * `recourse.semantic_intent` it remains verifier-equivalent.
 */

import { z } from 'zod';
import { satisfied, violated, type ConstraintEvaluator } from './types.js';

export const categoryScopeSchema = z
  .object({
    type: z.literal('recourse.category_scope'),
    /** When present, every line item's category must appear here. */
    allowed: z.array(z.string().min(1)).min(1).optional(),
    /** When present, no line item's category may appear here. Evaluated after `allowed`. */
    denied: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (c) => c.allowed !== undefined || c.denied !== undefined,
    'a category scope with neither allowed nor denied constrains nothing and is rejected as a ' +
      'likely authoring mistake',
  );

export type CategoryScopeConstraint = z.infer<typeof categoryScopeSchema>;

export const categoryScope: ConstraintEvaluator<CategoryScopeConstraint> = {
  type: 'recourse.category_scope',
  schema: categoryScopeSchema,
  selectivelyDisclosable: ['allowed', 'denied'],
  deterministic: true,
  origin: 'recourse-extension',
  evaluate(constraint, ctx) {
    const items = ctx.checkout.lineItems;

    if (constraint.allowed) {
      const allowed = constraint.allowed;
      const outside = items.filter((li) => !allowed.includes(li.category));
      if (outside.length > 0) {
        const detail = outside.map((li) => `${li.sku} (${li.category})`).join(', ');
        return violated(
          'category_violation',
          `item(s) outside the allowed categories [${allowed.join(', ')}]: ${detail}`,
        );
      }
    }

    if (constraint.denied) {
      const denied = constraint.denied;
      const hits = items.filter((li) => denied.includes(li.category));
      if (hits.length > 0) {
        const detail = hits.map((li) => `${li.sku} (${li.category})`).join(', ');
        return violated(
          'category_violation',
          `item(s) in a denied category [${denied.join(', ')}]: ${detail}`,
        );
      }
    }

    return satisfied(`all ${items.length} line item(s) are within the authorised category scope`);
  },
};
