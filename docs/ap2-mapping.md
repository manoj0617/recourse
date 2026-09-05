# Mapping to AP2 v0.2

Every claim on this page was checked against [ap2-protocol.org](https://ap2-protocol.org/) and the
[`google-agentic-commerce/AP2`](https://github.com/google-agentic-commerce/AP2) repository on
2026-09-05. Version v0.2.0 was published 2026-04-28; v0.1.0 was published 2025-09-16.

**If you have read the spec, read this page first.** It states exactly which parts of this project
are AP2's work and which are not.

## Mandates

AP2 v0.2 defines **two** mandate types. There is no Intent Mandate and no Cart Mandate — that is
v0.1 vocabulary, and a system still using those names is consuming a superseded version of the
protocol it claims to implement.

| AP2 v0.2 | `vct` | Implemented here |
|---|---|---|
| Checkout Mandate, closed | `mandate.checkout.1` | `closedCheckoutMandateSchema` — `checkout_jwt`, `checkout_hash`, `iat`, `exp` |
| Checkout Mandate, open | `mandate.checkout.open.1` | `openCheckoutMandateSchema` — carries `checkout.*` constraints |
| Payment Mandate, closed | `mandate.payment.1` | `closedPaymentMandateSchema` — `transaction_id`, `payee`, `pisp`, `payment_amount`, `payment_instrument`, `execution_date`, `risk_data` |
| Payment Mandate, open | *inferred* | `openPaymentMandateSchema`, written as `mandate.payment.open.1` |

**One inference, flagged rather than hidden.** The spec states that the open payment variant "may
optionally include any of these properties", but the exact `vct` string for it was not confirmed
against the specification text. `mandate.payment.open.1` is written by symmetry with the checkout
mandate. Everything else in this table was read directly from the spec.

See [`src/ap2/mandate.ts`](../src/ap2/mandate.ts).

## Signing

AP2 secures mandates with **SD-JWTs**, using `vct` for schema versioning and binding a Checkout
Mandate to a merchant-signed Checkout JWT via `checkout_hash`.

**Implemented:** compact JWS, EdDSA (a registered JWS algorithm), the `vct` / `iat` / `exp` /
`checkout_hash` claim set, and hash binding computed over the exact compact serialisation.

**Not implemented: selective disclosure.** There are no salted digests, no `_sd` array, no
disclosure segments, no `sd_hash`. Every claim in a Recourse mandate is visible to every holder of
the token. This is the shape of SD-JWT, not its privacy property. A real deployment needs the real
thing. See [`src/crypto/jws.ts`](../src/crypto/jws.ts).

Keys are Ed25519 keypairs in a file on disk. No HSM, no rotation, no attestation.

## Constraints

This is where the project's actual contribution lives, so the division is stated precisely.

### AP2's constraints, implemented here

These are **not** our invention. The evaluation algorithms are implementations of AP2's.

| Constraint | Evaluation | File |
|---|---|---|
| `checkout.allowed_merchants` | set membership on merchant id | [`allowed-merchants.ts`](../src/ap2/constraints/allowed-merchants.ts) |
| `checkout.line_items` | maximum bipartite matching of required sets against cart units | [`line-items.ts`](../src/ap2/constraints/line-items.ts) |
| `payment.budget` | requested + Σ(previously closed payment mandates) ≤ `max` | [`budget.ts`](../src/ap2/constraints/budget.ts) |
| `payment.agent_recurrence` | `frequency` period and `max_occurrences` | [`agent-recurrence.ts`](../src/ap2/constraints/agent-recurrence.ts) |
| `payment.allowed_payees` | set membership on payee id | [`allowed-payees.ts`](../src/ap2/constraints/allowed-payees.ts) |

Two implementation notes worth checking against the spec:

- **Budget accumulation.** The rule, verbatim: *"the requested amount plus the total sum of amounts
  from previously closed Payment Mandates MUST be less than or equal to `max`."* An implementation
  that checks each charge in isolation turns an 8,000 total budget into 8,000 *per transaction*.
- **Line items use a real matching, not `includes`.** Given two required sets that both accept
  SKU-A and a cart with one unit of SKU-A, a per-item membership check reports both sets satisfied.
  A matching reports one, which is the truth. Quantity is capacity.

### Constraints defined here, through AP2's extension point

AP2 documents an extension point: a new constraint requires *"A uniquely defined `type`. A Schema,
including which fields are selectively disclosable. The evaluation algorithm."* Each of the three
below supplies all three. They are registered in the same registry as the built-ins, and the Gate
cannot tell them apart.

| Constraint | Why AP2 defines no constraint type for it | Verifier-equivalent? |
|---|---|---|
| `recourse.semantic_intent` | AP2 can carry a goal as a natural-language description, but "a quiet hotel near the venue" is a judgement about whether a thing satisfies that goal, not a predicate over enumerable values, and no built-in evaluates one | **No** — see below |
| `recourse.category_scope` | AP2 constrains SKUs, not categories. "Books and stationery, nothing else" is not expressible as a SKU list over a catalogue the user has not seen | Yes |
| `recourse.cart_replay` | budget accumulation catches repeated spend once the total breaches `max`; it cannot catch the same 500 cart charged four times inside an 8,000 budget | Yes |

Declared selectively-disclosable fields are recorded on each evaluator. Since selective disclosure
is not implemented, those declarations document intent for a real deployment and nothing more.

### The honest problem with `recourse.semantic_intent`

AP2's extension point assumes an independent verifier can re-run a constraint's evaluation
algorithm and reach the same conclusion. The five built-ins are deterministic and satisfy that.
**This one does not.** Its algorithm is an LLM.

What is done about it, implemented rather than asserted:

1. **Reproducibility instead of determinism.** Model id and prompt version are written into the
   `gate_verdict` ledger event, so a ruling can be re-run against the configuration that produced
   it even though it cannot be re-derived from first principles.
2. **Measurement instead of assertion.** Per-class precision and recall over a labelled corpus,
   reported with counts, never as a single accuracy number. See [`corpus/rubric.md`](../corpus/rubric.md).
3. **Escalation instead of guessing.** Below the confidence threshold, and on any output that fails
   the response schema twice, the constraint returns `indeterminate` and the Gate holds for a
   human. There is no path from an unusable model response to an allowed payment.

## Unknown constraint types

AP2 requires a verifier to *"verify that the closed [Mandate] conforms to all of the Constraints by
evaluating each Constraint."* A constraint whose type this build does not recognise is therefore
**not skipped**. It returns `indeterminate` and the Gate holds. Skipping it would silently discard
an authorisation the user actually expressed. See [`registry.ts`](../src/ap2/constraints/registry.ts).

## Dispute time

AP2 already covers the evidence half. Its implementation considerations require storing SD-JWTs
with their disclosures so that `sd_hash`, `checkout_hash` and Receipt `reference` can be
recomputed — which establishes what was authorised and what each party saw.

**The gap this project addresses is narrower than "AP2 does not do disputes", and stating it
loosely is a mistake.** AP2 establishes *what was authorised and seen*, and says plainly that the
specifics of dispute resolution are out of its scope. What is not specified anywhere in it is the
step after the evidence: replaying that record to rule on whether the delivered thing *satisfied a
goal expressed in natural language*, and deriving a remedy from the ruling. That step is
[`src/adjudicator/`](../src/adjudicator/).

The same is true one layer down. Card networks and PSPs building for agent payments do cover
authorisation, bounded execution, audit trails and dispute evidence -- see the related-work note in
the README. This project does not claim that ground. It prototypes the adjudication step on top of
it.

## What is not implemented

- Selective disclosure (above)
- DID resolution; keys are a local file
- The A2A and MCP transports AP2 extends
- Receipts and `reference` recomputation
- Real payment capture — orders are created against Razorpay test keys for real, but capture is
  simulated and every event and console line that reports one says `simulated: true`
