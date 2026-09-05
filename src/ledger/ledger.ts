/**
 * An append-only, SHA-256 hash-chained event log.
 *
 * No blockchain. There is no network, no consensus, no token and no distributed anything. Each
 * event carries the hash of the one before it, so altering a past event invalidates every hash
 * after it. That is a Merkle-style integrity property and it is the entire mechanism.
 *
 * What this defends against: silent edits. Changing an amount, a verdict or a timestamp in place
 * breaks `verifyChain()` at the altered row.
 *
 * What it does NOT defend against, stated here rather than left for a reader to work out: an
 * attacker with write access to the whole file can recompute every subsequent hash and produce a
 * chain that verifies. Detecting that needs an anchor outside the file -- a signed checkpoint held
 * elsewhere, or the head hash published somewhere append-only. Not implemented; see
 * docs/threat-model.md.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { eventSchema, type EventInput, type LedgerEvent } from './events.js';

export class LedgerError extends Error {}

/** The hash a chain starts from. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic serialisation with recursively sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two objects with identical content but different
 * key order serialise differently and hash differently. A chain that depends on insertion order is
 * a chain that breaks when an event is round-tripped through anything that reorders keys, which
 * would look exactly like tampering. Arrays keep their order, since order is meaningful there.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}

/** The hash of an event, over every field except the hash itself. */
export function hashEvent(event: Omit<LedgerEvent, 'hash'>): string {
  const material = canonicalise({
    seq: event.seq,
    at: event.at,
    type: event.type,
    transactionId: event.transactionId,
    data: event.data,
    prevHash: event.prevHash,
  });
  return Buffer.from(sha256(Buffer.from(material, 'utf8'))).toString('hex');
}

export type ChainVerification =
  | { readonly valid: true; readonly length: number; readonly head: string }
  | {
      readonly valid: false;
      /** Sequence number of the first event that fails. */
      readonly brokenAt: number;
      readonly reason: string;
    };

/**
 * Recompute the chain from genesis and report the first event that does not hold.
 *
 * Reports the FIRST break rather than a count: once a link is broken every later link is suspect,
 * and a count of "37 broken events" reads as far more damage than one edited row actually did.
 */
export function verifyChain(events: readonly LedgerEvent[]): ChainVerification {
  let prevHash = GENESIS_HASH;

  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      return {
        valid: false,
        brokenAt: event.seq,
        reason: `event at position ${index} claims seq ${event.seq}; the log has a gap or a reorder`,
      };
    }
    if (event.prevHash !== prevHash) {
      return {
        valid: false,
        brokenAt: event.seq,
        reason:
          `event ${event.seq} records prevHash ${event.prevHash.slice(0, 12)}... but the ` +
          `preceding event hashes to ${prevHash.slice(0, 12)}...`,
      };
    }
    const recomputed = hashEvent(event);
    if (recomputed !== event.hash) {
      return {
        valid: false,
        brokenAt: event.seq,
        reason:
          `event ${event.seq} (${event.type}) stores hash ${event.hash.slice(0, 12)}... but its ` +
          `contents hash to ${recomputed.slice(0, 12)}...; this event was altered after it was written`,
      };
    }
    prevHash = event.hash;
  }

  return { valid: true, length: events.length, head: prevHash };
}

/**
 * The log. In memory, optionally mirrored to a JSONL file.
 *
 * Append is the only mutation offered. There is no update and no delete, and `all()` returns a
 * copy, so a caller cannot reach in and edit history through the object that owns it.
 */
export class Ledger {
  #events: LedgerEvent[] = [];
  readonly #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
    if (path && existsSync(path)) this.#load(path);
  }

  /**
   * Read a JSONL log back in. A malformed line throws rather than being skipped: a log with a
   * hole in it is not a log, and silently dropping the unreadable row would also drop the
   * evidence that something went wrong with it.
   */
  #load(path: string): void {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    this.#events = lines.map((line, index) => {
      const parsed = eventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new LedgerError(
          `ledger line ${index + 1} of ${path} is not a valid event: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
  }

  get head(): string {
    return this.#events.at(-1)?.hash ?? GENESIS_HASH;
  }

  get length(): number {
    return this.#events.length;
  }

  append(input: EventInput): LedgerEvent {
    const unhashed = {
      ...input,
      seq: this.#events.length,
      prevHash: this.head,
    };
    const event: LedgerEvent = { ...unhashed, hash: hashEvent(unhashed) };
    this.#events.push(event);
    if (this.#path) {
      mkdirSync(dirname(this.#path), { recursive: true });
      appendFileSync(this.#path, JSON.stringify(event) + '\n', 'utf8');
    }
    return event;
  }

  all(): readonly LedgerEvent[] {
    return [...this.#events];
  }

  forTransaction(transactionId: string): readonly LedgerEvent[] {
    return this.#events.filter((e) => e.transactionId === transactionId);
  }

  verify(): ChainVerification {
    return verifyChain(this.#events);
  }

  /**
   * Replace the in-memory log wholesale. Exists only so tests and the tamper demo can write a
   * corrupted chain and watch `verify()` catch it; nothing in the production path calls it.
   */
  static fromEvents(events: readonly LedgerEvent[]): Ledger {
    const ledger = new Ledger();
    ledger.#events = [...events];
    return ledger;
  }
}
