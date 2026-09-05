# Mapping to NPCI's Unified Agent Protocol

**Status: not written. This is a placeholder with a date on it.**

As of 2026-09-05, NPCI's Unified Agent Protocol has not been published. Reporting says it is due to
be unveiled at the 2026 edition of the Global Fintech Fest in Mumbai, that it builds on existing
UPI mechanisms — UPI Circle for delegation, and Reserve Pay — to let a user delegate payment
authority to an agent within a preset limit, and that it requires Reserve Bank of India approval
before launch.

Nothing further is claimed here, because nothing further is known. This file exists so that its
emptiness is visible rather than the topic being quietly avoided.

## What this file will contain once the spec is public

1. A field-by-field mapping from UAP's delegation and agent-registration structures to the
   constraint model in [`ap2-mapping.md`](./ap2-mapping.md), in the same form: which constraints
   UAP already expresses, and which it does not.
2. An honest answer to the question this project's positioning depends on: **does UAP's preset
   limit carry anything resembling natural-language intent?** If it does, the
   `recourse.semantic_intent` extension is redundant on Indian rails and the project should say so
   loudly. If it does not — which is the expectation, since a preset limit is a number — then the
   gap this project addresses exists on UPI as well as on card rails.
3. Whether UAP's agent registration and verification changes who is liable, which is the part
   that determines whether an adjudication layer has a customer.

## A note on the claim this affects

The README says **"first working implementation on a live payment rail"**, not "on Indian rails".
That wording is deliberate. Nothing in this architecture is India-specific beyond INR amounts and a
Razorpay test key, and a stronger claim would not survive the first person to ask what exactly is
Indian about it.

The stronger claim becomes available only when this file has real content in it — and only if the
mapping turns out to support it.
