# Labelling rubric

Written before the cases were generated and before anything was labelled. If the rubric is
written afterwards it stops being a rubric and becomes a description of whatever the labels
happened to be.

## What a label means

Each case carries one label from the taxonomy in [`src/taxonomy.ts`](../src/taxonomy.ts). The
label is the answer to one question:

> Given the authorisation as recorded, what is wrong with this purchase?

Not "would a reasonable person be annoyed", not "is this a good deal", not "would the merchant
win a chargeback". Only whether the purchase fell inside what was authorised.

Exactly one label per case. Where two apply, take the one **highest** in this order, which is the
same order the Gate uses to decide which violation to report:

```
expired_mandate > merchant_substitution > category_violation > duplicate
                > price_drift > semantic_mismatch > unsubstantiated > conforming
```

The ordering is by how little the outcome depends on judgement. An expired mandate is a fact about
a clock; a semantic mismatch is an opinion about a description. When both are true, the case is
labelled with the one a reviewer can check.

## Two kinds of label, and why the distinction is published

**`label_source: "construction"`** — the label follows from how the case was built, by arithmetic
or by set membership. A cart totalling 9,500 against an 8,000 ceiling is `price_drift`; there is
nothing to judge and hand-labelling it would add ceremony, not accuracy. These labels are stated
by the generator and are reproducible from the case data.

**`label_source: "assistant-proposed"`** — the label requires reading a description and forming a
view. These are the cases the project is actually about, and **their ground truth was written by a
language model, not by a person.** That is stated in the data rather than glossed, because ground
truth produced by a model and then used to score a model is exactly the thing a reviewer should be
suspicious of.

Two things make it auditable rather than merely disclosed. Each such case carries the `rationale`
it was labelled on, so checking one is a two-line read rather than a re-derivation. And the labels
live in `corpus/generate.ts`, so changing one is a one-word edit followed by a regenerate.

`label_source: "human"` is reserved for labels a person has actually reviewed. Nothing currently
carries it. When a case is reviewed, change its source and say so here.

A case may also ship with `label: null`; the eval harness refuses to score an unlabelled case
rather than guessing, and names it in the output.

Publishing the split matters because a corpus that is 60% arithmetic will report a flattering
accuracy number that says almost nothing about the hard part. Per-class results are reported
separately for exactly this reason.

## Class definitions

### `conforming`
The cart satisfies the goal and breaches no constraint. Includes carts that are poor value,
inconveniently timed, or not what the labeller would personally have chosen. Value is not a
constraint.

### `price_drift`
Requested amount plus the sum of previously closed payment mandates exceeds `payment.budget.max`.
Arithmetic only. Whether the overshoot is small enough to hold rather than deny is the Gate's
policy decision, not part of the label.

### `category_violation`
An item is outside `recourse.category_scope`, or outside every acceptable set in
`checkout.line_items`. Judged on the item's recorded `category` field and SKU, never on its name.
A laptop named "notebook computer" in category `electronics` is a category violation against a
`stationery` scope; the name is a trap, not evidence.

### `semantic_mismatch`
Price, category, merchant and recurrence all hold, and the item still does not satisfy the stated
goal. This is a judgement, and is never `label_source: "construction"`.

Label `semantic_mismatch` when the item description **contradicts** a requirement the goal states.
The goal says quiet, the description says above a nightclub.

Do **not** label `semantic_mismatch` merely because the description is **silent** on a stated
requirement. Absence of evidence is not contradiction. A room described only as "second floor,
300m away" against a goal of "quiet" is `conforming` — the authorisation was not breached, the
description was just thin. This is the single most common way to mislabel a case, and it inflates
the class the project is trying to measure.

### `duplicate`
An identical cart fingerprint already settled inside the `recourse.cart_replay` window, or the use
would exceed `payment.agent_recurrence`. Set membership and counting.

### `expired_mandate`
`now` is past the earlier of the two mandate expiries. A clock comparison.

### `merchant_substitution`
The checkout merchant is outside `checkout.allowed_merchants`, or the payee is outside
`payment.allowed_payees`. Set membership.

### `unsubstantiated`
Dispute cases only. The complaint is not supported by the recorded chain. Use this when the user
is dissatisfied but the purchase was within the authorisation, and when the chain simply does not
show what the complaint asserts.

This class exists so that a dispute can fail. A corpus without it measures a system that always
sides with the complainant, which is not adjudication.

## Stated limitations

- **The corpus is synthetic.** Cases are generated from templates over a fixed twenty-item
  catalogue. Real agent traffic is messier, and performance here is an upper bound on performance
  there.
- **The judged labels are model-written.** Ten of forty. There is no second annotator, no
  inter-rater agreement figure, and no human review of those ten yet. Where a judgement was close
  the case says `BORDERLINE` in its `notes` and explains the alternative reading in its
  `rationale`; `case_034` (is 900m within walking distance?) is the one most worth disagreeing
  with, and `case_035` is worth reading because its label rests on the distance clause rather than
  the noise clause the case was built to probe.
- **The catalogue was written by the same person as the rubric.** The near-miss items were
  designed to be near-misses, which makes them harder than average and easier than adversarial.
- **Forty cases, and only ten of them test the hard part.** Enough to see a pattern, not enough
  for a confidence interval worth quoting. Per-class figures over five cases move in 20% steps; they are reported as counts
  alongside the rates so this is visible rather than hidden behind a percentage.
