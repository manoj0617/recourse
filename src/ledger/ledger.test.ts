import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, Ledger, canonicalise, hashEvent, verifyChain } from './ledger.js';
import type { LedgerEvent } from './events.js';

function seed(): Ledger {
  const ledger = new Ledger();
  ledger.append({
    type: 'user_prompt',
    transactionId: 'txn_1',
    at: 1_757_000_000_000,
    data: { prompt: 'book me a quiet hotel under 8000 near the venue' },
  });
  ledger.append({
    type: 'cart_proposed',
    transactionId: 'txn_1',
    at: 1_757_000_001_000,
    data: { sku: 'HOTEL-014', total: 780000 },
  });
  ledger.append({
    type: 'gate_verdict',
    transactionId: 'txn_1',
    at: 1_757_000_002_000,
    data: { action: 'allow' },
  });
  return ledger;
}

describe('canonicalise', () => {
  it('is insensitive to key order, so a round-trip is not mistaken for tampering', () => {
    expect(canonicalise({ a: 1, b: 2 })).toBe(canonicalise({ b: 2, a: 1 }));
    expect(canonicalise({ a: { x: 1, y: 2 } })).toBe(canonicalise({ a: { y: 2, x: 1 } }));
  });

  it('preserves array order, because order is meaningful there', () => {
    expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]));
  });

  it('drops undefined rather than emitting invalid JSON for it', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe(canonicalise({ a: 1 }));
  });
});

describe('append', () => {
  it('chains each event to the one before it, starting from genesis', () => {
    const events = seed().all();
    expect(events).toHaveLength(3);
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(events[2]?.prevHash).toBe(events[1]?.hash);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('hands out copies, so history cannot be edited through the ledger that owns it', () => {
    const ledger = seed();
    const copy = ledger.all() as LedgerEvent[];
    copy.pop();
    expect(ledger.length).toBe(3);
  });
});

describe('verifyChain', () => {
  it('accepts an untouched chain', () => {
    const result = seed().verify();
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.length).toBe(3);
  });

  it('accepts the empty chain', () => {
    const result = verifyChain([]);
    expect(result).toMatchObject({ valid: true, length: 0, head: GENESIS_HASH });
  });

  // This is the demo: mutate one row in a settled log and watch the chain refuse it.
  it('catches an amount edited in place after the fact', () => {
    const events = seed().all().map((e) => ({ ...e }));
    const target = events[1] as LedgerEvent;
    events[1] = { ...target, data: { ...target.data, total: 78000 } };

    const result = verifyChain(events);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toMatch(/altered after it was written/);
    }
  });

  it('catches a verdict rewritten from hold to allow', () => {
    const events = seed().all().map((e) => ({ ...e }));
    const target = events[2] as LedgerEvent;
    events[2] = { ...target, data: { action: 'allow', wasActually: 'hold' } };
    expect(verifyChain(events).valid).toBe(false);
  });

  it('catches a removed event, which breaks the prevHash link', () => {
    const events = seed().all().filter((e) => e.seq !== 1);
    const result = verifyChain(events);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/gap or a reorder/);
  });

  it('catches an appended event forged with a stale prevHash', () => {
    const events = [...seed().all()];
    const forged = {
      seq: 3,
      at: 1_757_000_003_000,
      type: 'refund_issued' as const,
      transactionId: 'txn_1',
      data: { amount: 780000 },
      prevHash: GENESIS_HASH,
    };
    events.push({ ...forged, hash: hashEvent(forged) });

    const result = verifyChain(events);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt).toBe(3);
      expect(result.reason).toMatch(/records prevHash/);
    }
  });

  // Second honest limitation: dropping events off the END leaves a valid prefix. Detecting a
  // truncated tail requires knowing what the head hash should be, which means holding it
  // somewhere outside the log. Not implemented; see docs/threat-model.md.
  it('does NOT catch truncation of the tail, which needs an external head anchor', () => {
    const full = seed().all();
    expect(verifyChain(full.slice(0, 2)).valid).toBe(true);
  });

  // The honest limitation, asserted rather than described: rewriting the whole chain defeats it.
  it('does NOT catch a wholesale rewrite, which is why an external anchor is needed', () => {
    const original = seed().all();
    const rewritten: LedgerEvent[] = [];
    let prevHash = GENESIS_HASH;
    for (const [i, e] of original.entries()) {
      const body = {
        seq: i,
        at: e.at,
        type: e.type,
        transactionId: e.transactionId,
        data: i === 1 ? { sku: 'HOTEL-014', total: 78000 } : e.data,
        prevHash,
      };
      const hash = hashEvent(body);
      rewritten.push({ ...body, hash });
      prevHash = hash;
    }
    expect(verifyChain(rewritten).valid).toBe(true);
  });
});

describe('forTransaction', () => {
  it('selects only the events belonging to one purchase attempt', () => {
    const ledger = seed();
    ledger.append({ type: 'user_prompt', transactionId: 'txn_2', at: 1, data: {} });
    expect(ledger.forTransaction('txn_1')).toHaveLength(3);
    expect(ledger.forTransaction('txn_2')).toHaveLength(1);
  });
});
