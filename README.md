# Recourse

An adjudication layer for agent-initiated payments. It sits between an autonomous purchasing agent
and a payment rail, refuses money actions that fall outside what the user authorised, records why
in a tamper-evident chain, and when a payment is disputed later it replays that chain and rules
on it.

It **consumes** [Google's Agent Payments Protocol (AP2)](https://ap2-protocol.org/); it does not
reinvent it. AP2 v0.2 defines the mandates, the SD-JWT envelope, and five constraint types, and
this project implements their evaluation. It also defines an extension point for new constraints,
and this project uses it to add three that AP2 defines no constraint type for.

The one-line problem:

> A signed mandate proves the user said "book me a quiet hotel under 8,000 near the venue."
> Every authorised constraint can pass, and the 7,800 room six kilometres away above a nightclub
> can still not be the thing that was asked for.

That judgement is the product. It is an AI problem, not a cryptography one.

## What is and is not new here

Read [`docs/ap2-mapping.md`](docs/ap2-mapping.md) first if you know the spec. The short version:

**AP2's, implemented here.** `checkout.allowed_merchants`, `checkout.line_items`, `payment.budget`,
`payment.agent_recurrence`, `payment.allowed_payees`. The budget rule accumulates across previously
closed payment mandates, as the spec requires; line items are matched with a real bipartite
matching rather than a per-item membership test.

**Defined here, through AP2's documented extension point** — which requires *"A uniquely defined
`type`. A Schema, including which fields are selectively disclosable. The evaluation algorithm."*

- `recourse.semantic_intent` — the natural-language goal. AP2 can carry a goal as a description,
  and its constraints express "under 8,000", "from these merchants", "one of these SKUs". What it
  does not define is a constraint type that evaluates "quiet". Recording a goal and enforcing one
  are different things.
- `recourse.category_scope` — AP2 constrains SKUs, not categories.
- `recourse.cart_replay` — budget accumulation catches repeated spend once the total breaches the
  ceiling. It cannot catch the same 500 cart charged four times inside an 8,000 budget.

**The gap, stated narrowly.** AP2 already specifies dispute-time evidence: store the SD-JWTs with
their disclosures so `sd_hash`, `checkout_hash` and Receipt `reference` can be recomputed. That
establishes *what was authorised and what each party saw*. It does not rule on whether the
delivered thing *satisfied a goal expressed in natural language*. That ruling is
[`src/adjudicator/`](src/adjudicator/).

Prior art is cited rather than skirted. AP2 v0.2.0 was published 2026-04-28. The security analysis
this design leans on is *Beyond the Mandate: A Systematic Security Analysis of the Agent Payments
Protocol (AP2)*, Aviv, Gandh, Bitton & Shabtai, arXiv 2608.23858 (2026-08-24), which finds that
pre-authorisation A2A and MCP interactions *"remain outside that protection"* and that *"valid
mandate signatures alone do not ensure that an agent-mediated transaction reflects the user's
intent when its pre-authorisation context is manipulated."* That is the argument for a
pre-transaction gate, made by someone else.

### Related work, and what this project does not claim

Agent payment infrastructure is not short of authorisation machinery, and it would be wrong to
imply otherwise. Public materials from Mastercard (Agent Pay / Verifiable Intent), Visa
(Intelligent Commerce), Stripe (agentic commerce, transaction-scoped shared payment tokens) and
Razorpay (Agentic Payments, UPI Reserve Pay) all describe some combination of spending limits,
merchant and time restrictions, approval workflows, authenticated user intent, and audit trails
kept for dispute resolution. Mastercard's Verifiable Intent material speaks directly about recourse
when an agent does something the user did not ask for.

So none of the following is claimed as new here: intent provenance, spend control, bounded
delegated authority, tamper-evident audit trails, or the idea that agent payments need recourse.

What this project prototypes is the step after the evidence, and only that:

> a transaction that passed every formal authorisation check is later challenged against the
> natural-language goal behind it; the recorded chain is replayed; a ruling is produced with a
> classification and a confidence; and a remedy is derived from the ruling and the rail's own caps.

AP2 states that the specifics of dispute resolution are outside its scope. In the card-network and
PSP material surveyed, this adjudication step is not publicly described as a mechanism. That is a
statement about what is publicly documented, not a claim that nobody has built it internally.

The honest one-line version: **authorisation decides whether the agent was allowed to act; this
decides what happens when an allowed action was still wrong.**

## Architecture

```
prompt --> mandates --> AGENT --> cart --> GATE --> rail
                          |                  |
                          +-- no keys,       +-- deterministic constraints first
                              no client,     +-- semantic constraint last
                              no network     +-- allow / hold / deny
                                                 |
                            LEDGER <-------------+     hash-chained, append-only
                               |
                            dispute --> ADJUDICATOR --> ruling + bounded refund
```

Three properties are enforced rather than requested:

1. **Nothing reaches the rail without a Gate verdict.** Every money-moving function requires an
   `AllowToken` whose type carries a module-private symbol. A call that skipped the Gate does not
   compile; a call that casts past the compiler fails at runtime before a request is built.
2. **The judge fails closed.** No judge, a rate limit, unparseable output twice, a schema
   violation, low confidence, or an unrecognised constraint type all produce `indeterminate`, which
   holds for a human. No branch turns an evaluation failure into a pass.
3. **The refund cap is derived, never passed in.** `min(captured - refunded, budget.max, award)`.

The agent has no guardrails, deliberately. Constraint checks inside the agent are one prompt
injection from being skipped, and a Gate that is never handed anything to refuse has not been shown
to refuse anything. Razorpay publishes an MCP server; it is **not** wired into the agent, because
giving the shopping agent direct rail access defeats the whole arrangement.

The ledger is a SHA-256 hash chain. No blockchain — no network, no consensus, no token.

## Running it

```bash
npm install
npm test          # 147 tests, no network access at any point
npm run typecheck
```

Five demo scenarios:

```bash
npx tsx src/scenarios/cli.ts happy      # buys within the mandate
npx tsx src/scenarios/cli.ts drift      # over the ceiling; arithmetic refuses, no model consulted
npx tsx src/scenarios/cli.ts semantic   # right price, right category, wrong thing
npx tsx src/scenarios/cli.ts dispute    # Gate allows it; adjudicator later rules against it
npx tsx src/scenarios/cli.ts tamper     # a settled row is edited; the chain names it
```

The agent is a live model, configured from `.env` (any OpenAI-compatible endpoint — Groq, Cerebras
and Mistral all work by changing three values). `JUDGE_MODE=record` pays for the calls once and
writes them to a cache; `JUDGE_MODE=replay` then runs offline against real recorded responses,
which is the fallback if a provider rate-limits mid-recording. Adding `--scripted` replays a fixed
tool sequence with **no model involved**; every run says so, because it is a wiring check and not
a demonstration.

## Measurements

```bash
npx tsx corpus/generate.ts > corpus/cases.jsonl
npm run eval
```

Forty cases across the taxonomy, with the labelling rubric in [`corpus/rubric.md`](corpus/rubric.md)
written before any case existed.

**The current numbers, stated so they cannot be misread.**

Thirty cases are labelled by construction — a cart totalling 9,500 against an 8,000 ceiling is
`price_drift` by arithmetic — and the Gate matches all thirty. **That is not an accuracy claim.**
It verifies the deterministic rules are wired correctly and says nothing about the hard part.

The other ten are the ones that measure the semantic constraint, and two caveats travel with them.
First, **their ground truth was written by a language model, not a person** — recorded in the data
as `label_source: "assistant-proposed"`, with the `rationale` each was labelled on, so any of them
can be audited in two lines or changed in one. Model-written ground truth used to score a model is
a fair thing to be suspicious of, so it is in the data rather than in a footnote.

Second, the result on them is **10 of 10 matched**, and that number deserves less weight than it
looks like it deserves. Ten cases is a small sample: a perfect score here is consistent with a wide
range of true performance, and it is not evidence of a ceiling. The ground truth was proposed by a
language model and the judge is from the same family, so the two can agree by sharing a blind spot
rather than by being right. Read it as *the semantic constraint is wired correctly and behaves
sensibly on ten cases*, not as an accuracy claim.

Running it needs an API key. Without one the judge escalates, every judged case resolves to
`unsubstantiated`, and the harness prints a banner saying the semantic constraint was not
evaluated -- because a bare `0/10` on that page would be read as a judge that got everything wrong,
when it is the fail-closed path refusing to guess:

```bash
JUDGE_API_KEY=... JUDGE_MODE=record npx tsx evals/run.ts   # pay once
JUDGE_MODE=replay npx tsx evals/run.ts                     # free, offline, thereafter
```

Per-class precision and recall are reported with raw counts, and the two error classes are reported
separately and never summed. Blocking a legitimate purchase and allowing an illegitimate one are
different losses.

## Known limitations

At length in [`docs/threat-model.md`](docs/threat-model.md):

- **Selective disclosure is not implemented.** Compact JWS with EdDSA and AP2's claim set, but no
  salted digests and no `_sd` array. This is the shape of SD-JWT, not its privacy property.
- **The hash chain does not survive a wholesale rewrite, or truncation of the tail.** Both are
  asserted by tests rather than described. The fix is an anchor held outside the log, and a signing
  key stored next to the ledger does not qualify.
- **Keys are a file on disk.** No HSM, no rotation, no attestation.
- **`recourse.semantic_intent` is not verifier-equivalent.** AP2's extension point assumes an
  independent verifier can re-run an algorithm and agree. An LLM cannot promise that. Mitigated by
  pinning model and prompt version into the ledger, measuring rather than asserting, and escalating
  below a confidence threshold — none of which is a correctness guarantee.
- **A merchant that lies in an item description defeats the semantic judge**, and the adjudicator
  can only re-read the same record. This is the largest gap between this and something useful in
  production.
- **The corpus is synthetic, forty cases, and only ten of them test the hard part** — whose labels
  were written by a language model rather than a person. No second annotator, so no inter-rater
  agreement figure. Every judged case carries the rationale it was labelled on so it can be
  audited or overruled.
- **Payment capture is simulated.** Orders are created against Razorpay test keys for real;
  completing a payment needs a human in a browser, so capture events carry `simulated: true` and
  every console line reporting one says so.
- **NPCI's Unified Agent Protocol had not been published** when this was written. See
  [`docs/uap-mapping.md`](docs/uap-mapping.md) — that file is empty on purpose. The claim here is
  "first working implementation on a live payment rail", not "on Indian rails", because nothing in
  this architecture is India-specific beyond INR amounts and a test key.

## Layout

| Path | What lives there |
|---|---|
| [`src/ap2/`](src/ap2/) | Mandates, and the constraint registry that is the extension point made concrete |
| [`src/gate/`](src/gate/) | Verdicts and the `AllowToken` |
| [`src/ledger/`](src/ledger/) | Append-only hash chain |
| [`src/judge/`](src/judge/) | OpenAI-compatible judge; live/record/replay transport |
| [`src/adjudicator/`](src/adjudicator/) | Chain replay, ruling, remediation, evidence pack |
| [`src/rail/`](src/rail/) | Razorpay; the only file that moves money |
| [`src/agent/`](src/agent/) | The purchasing agent, without guardrails |
| [`src/session.ts`](src/session.ts) | The wiring |
| [`corpus/`](corpus/), [`evals/`](evals/) | Labelled cases, rubric, scoring harness |
