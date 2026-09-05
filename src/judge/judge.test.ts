import { describe, expect, it } from 'vitest';
import { createJudge, extractJson } from './openai-compatible.js';
import { cacheKey, createTransport, TransportError, type Transport } from './transport.js';

/** A transport that returns scripted replies. No network, ever. */
function scripted(replies: readonly string[]): Transport & { seen: number } {
  const t = {
    mode: 'replay' as const,
    liveCalls: 0,
    seen: 0,
    async chat() {
      const reply = replies[t.seen] ?? replies.at(-1) ?? '';
      t.seen += 1;
      return { role: 'assistant' as const, content: reply };
    },
    async complete(): Promise<string> {
      return (await t.chat()).content;
    },
  };
  return t;
}

const GOOD = JSON.stringify({
  verdict: 'conforming',
  clause: 'quiet hotel near the venue',
  confidence: 0.82,
  rationale: 'the room is 400m from the venue and described as quiet',
});

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('survives markdown fences, which models emit constantly', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('survives prose before and after the object', () => {
    expect(extractJson('Sure! Here is my answer:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('takes the outermost braces so a nested object does not truncate the parse', () => {
    expect(extractJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I cannot answer that.')).toThrow();
  });
});

describe('conformance contract', () => {
  it('returns a validated ruling', async () => {
    const judge = createJudge({ transport: scripted([GOOD]), model: 'm' });
    const outcome = await judge.conformance({ goal: 'quiet hotel', cart: 'a room' });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.value.verdict).toBe('conforming');
      expect(outcome.value.confidence).toBeCloseTo(0.82);
    }
  });

  it('recovers a fenced reply without spending the retry budget on it', async () => {
    const transport = scripted(['```json\n' + GOOD + '\n```']);
    const judge = createJudge({ transport, model: 'm' });
    const outcome = await judge.conformance({ goal: 'g', cart: 'c' });
    expect(outcome.status).toBe('ok');
    expect(transport.seen).toBe(1);
  });

  it('retries once on unparseable output, then accepts the corrected reply', async () => {
    const transport = scripted(['I think it is fine, honestly.', GOOD]);
    const judge = createJudge({ transport, model: 'm' });
    const outcome = await judge.conformance({ goal: 'g', cart: 'c' });
    expect(outcome.status).toBe('ok');
    expect(transport.seen).toBe(2);
  });

  // The single most important behaviour in the codebase: an unusable answer is never a pass.
  it('escalates after a second unparseable reply', async () => {
    const transport = scripted(['not json', 'still not json']);
    const judge = createJudge({ transport, model: 'm' });
    const outcome = await judge.conformance({ goal: 'g', cart: 'c' });
    expect(outcome.status).toBe('escalate');
    expect(transport.seen).toBe(2);
  });

  it('escalates well-formed JSON that does not match the schema', async () => {
    const wrong = JSON.stringify({ verdict: 'looks_fine', confidence: 2 });
    const outcome = await createJudge({ transport: scripted([wrong]), model: 'm' }).conformance({
      goal: 'g',
      cart: 'c',
    });
    expect(outcome.status).toBe('escalate');
  });

  it('escalates an unknown verdict value rather than coercing it', async () => {
    const wrong = JSON.stringify({
      verdict: 'probably_ok',
      clause: 'x',
      confidence: 0.9,
      rationale: 'y',
    });
    const outcome = await createJudge({ transport: scripted([wrong]), model: 'm' }).conformance({
      goal: 'g',
      cart: 'c',
    });
    expect(outcome.status).toBe('escalate');
  });

  it('rejects extra keys, because a silently ignored field is a silently changed contract', async () => {
    const extra = JSON.stringify({
      verdict: 'conforming',
      clause: 'x',
      confidence: 0.9,
      rationale: 'y',
      also_refund: true,
    });
    const outcome = await createJudge({ transport: scripted([extra]), model: 'm' }).conformance({
      goal: 'g',
      cart: 'c',
    });
    expect(outcome.status).toBe('escalate');
  });

  it('escalates when the transport itself fails', async () => {
    const broken: Transport = {
      mode: 'live',
      liveCalls: 0,
      async chat(): Promise<never> {
        throw new Error('429 rate limited');
      },
      async complete(): Promise<never> {
        throw new Error('429 rate limited');
      },
    };
    const outcome = await createJudge({ transport: broken, model: 'm' }).conformance({
      goal: 'g',
      cart: 'c',
    });
    expect(outcome.status).toBe('escalate');
    if (outcome.status === 'escalate') expect(outcome.reason).toMatch(/429/);
  });
});

describe('adjudication contract', () => {
  it('accepts a ruling drawn from the taxonomy', async () => {
    const reply = JSON.stringify({
      classification: 'semantic_mismatch',
      clause: 'quiet',
      confidence: 0.77,
      rationale: 'the room is above a nightclub',
    });
    const outcome = await createJudge({ transport: scripted([reply]), model: 'm' }).adjudicate({
      goal: 'g',
      complaint: 'c',
      chain: 'x',
    });
    expect(outcome.status).toBe('ok');
  });

  it('escalates a classification outside the taxonomy', async () => {
    const reply = JSON.stringify({
      classification: 'merchant_was_rude',
      clause: 'x',
      confidence: 0.9,
      rationale: 'y',
    });
    const outcome = await createJudge({ transport: scripted([reply]), model: 'm' }).adjudicate({
      goal: 'g',
      complaint: 'c',
      chain: 'x',
    });
    expect(outcome.status).toBe('escalate');
  });
});

describe('transport caching', () => {
  const request = {
    model: 'm',
    temperature: 0,
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  it('keys on model, temperature and messages, so a changed prompt misses', () => {
    const other = { ...request, messages: [{ role: 'user' as const, content: 'goodbye' }] };
    expect(cacheKey(request)).toBe(cacheKey({ ...request }));
    expect(cacheKey(request)).not.toBe(cacheKey(other));
    expect(cacheKey(request)).not.toBe(cacheKey({ ...request, model: 'n' }));
  });

  it('refuses a replay miss instead of reaching for the network', async () => {
    const transport = createTransport({
      mode: 'replay',
      baseURL: 'https://example.invalid/v1',
      apiKey: '',
      cachePath: 'data/does-not-exist.json',
      fetchImpl: () => {
        throw new Error('the network must not be touched in replay mode');
      },
    });
    await expect(transport.complete(request)).rejects.toThrow(TransportError);
  });
});
