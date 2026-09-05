# Threat model

What this system defends against, and — at greater length, because it matters more — what it does
not. Everything in the second list is unimplemented on purpose, under a one-night budget, and is
named here rather than left for a reader to discover.

## What it defends against

### An agent spending outside what was authorised

Every money-moving function in [`src/rail/razorpay.ts`](../src/rail/razorpay.ts) requires an
`AllowToken`. The token type carries a module-private symbol that no other file can name, so:

- a call site that has not been through the Gate **does not compile**;
- a call site that casts its way past the compiler (`{} as AllowToken`) **fails at runtime**,
  before a request is constructed.

The amount charged is read off the token, not passed alongside it, so a verdict for 7,800 cannot be
spent as 78,000 by a caller that transposed its arguments.

### An agent that polices itself and then does not

The agent has four tools and no guardrails. It can propose any cart, at any price, from any
merchant, as many times as it likes. Enforcement lives entirely in the Gate. This is deliberate:
constraint checks inside the agent are one prompt injection away from being skipped, and a Gate
that is never given anything to refuse has not been shown to refuse anything.

**Razorpay publishes an MCP server, and it is deliberately not wired into the agent.** Giving the
shopping agent direct rail access defeats the entire arrangement. arXiv 2608.23858 makes the same
argument from the other direction: pre-authorisation A2A and MCP tool calls sit outside mandate
protection, so *"valid mandate signatures alone do not ensure that an agent-mediated transaction
reflects the user's intent when its pre-authorisation context is manipulated."*

### A model that cannot answer being treated as a model that said yes

Every failure mode of the conformance judge resolves to `indeterminate`, which the Gate turns into
a hold:

- no judge configured
- transport failure or rate limit
- output that is not JSON, twice
- output that is JSON but fails the response schema, twice
- confidence at or below the threshold
- a constraint type this build does not recognise
- a constraint that does not match its own schema
- an evaluator that throws

There is no branch anywhere that converts an evaluation failure into `satisfied`. Fail-open is the
default mistake in this category.

### A settled record edited after the fact

Each ledger event carries the SHA-256 hash of the previous one. Editing an amount, a verdict or a
timestamp in place breaks `verifyChain()` at the altered row, and the failure names the row. The
adjudicator refuses to rule at all on a chain that does not verify — it will not consult the model
about evidence known to be altered.

Serialisation is canonical (recursively sorted keys), so a round-trip through anything that
reorders keys is not mistaken for tampering.

### A refund larger than it should be

The refund cap is **derived**, never accepted from a caller:
`min(captured − already_refunded, budget.max, adjudicator_award)`. A caller-supplied cap is a cap
the caller can widen.

### Replay of a payment webhook

Signature verification is HMAC-SHA256 over the raw body with a timing-safe comparison, and refuses
to run at all if no secret is configured rather than quietly returning false.

---

## What it does NOT defend against

### A wholesale rewrite of the ledger

An attacker with write access to the whole log can recompute every hash and produce a chain that
verifies. There is a test asserting exactly this
([`ledger.test.ts`](../src/ledger/ledger.test.ts), *"does NOT catch a wholesale rewrite"*).

### Truncation of the tail

Dropping events off the end leaves a valid prefix. Also asserted by a test rather than described.

**Both need the same fix and it is not implemented:** an anchor held outside the log. Periodically
signing the head hash is *not sufficient on its own* — a signing key stored beside the ledger is
held by anyone who can rewrite the ledger. The head hash has to leave the machine: written into a
git commit message, posted to an append-only external service, or countersigned by a party that is
not the one keeping the log. Recorded as the next piece of work.

### Anyone who holds the signing key

Keys are Ed25519 keypairs in a JSON file, mode 0600. No HSM, no derivation, no rotation, no
attestation, no revocation. Whoever reads that file can mint mandates indistinguishable from the
user's.

### Observers of a mandate

Selective disclosure is not implemented. Every claim in every mandate is visible to every holder of
the token — including the budget ceiling and the user's stated goal. AP2 uses SD-JWT precisely so
this is not true.

### A wrong ruling from the judge

`recourse.semantic_intent` and the adjudicator are LLM-driven and are not verifier-equivalent: two
verifiers may disagree. The mitigations are reproducibility (model and prompt version pinned into
the ledger), measurement (per-class precision and recall over a labelled corpus) and escalation
below a confidence threshold. None of these is a correctness guarantee, and the README does not
claim one.

The Gate being wrong is also not the end of the story by design — the `dispute` scenario shows the
Gate allowing a purchase that the adjudicator later rules against on the same evidence.

### A merchant that lies in its item description

The semantic judge reasons over merchant-supplied text. A description that omits the nightclub
produces a conforming ruling. Nothing here verifies claims against reality; the adjudicator can
only re-read the same record. This is the largest gap between this system and one that would be
useful in production, and no part of the design closes it.

### Prompt injection through catalogue content

Item descriptions reach both the agent and the judge as untrusted text. There is no sanitisation
and no instruction-hierarchy defence. A crafted description is an open avenue.

### Everything outside the process

No authentication, no authorisation, no multi-tenancy, no rate limiting, no transport security, no
secret management. There is one signing key, one ledger file, and no notion of users.

---

## Deliberately out of scope

MongoDB, auth, multi-tenancy, a real marketplace, DID resolution, and a multi-model accuracy table.
Cut under a fixed time budget, listed so their absence reads as a decision rather than an oversight.
