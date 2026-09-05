/**
 * How model calls actually leave the process, and how they are made not to.
 *
 * Three modes:
 *   live    every call hits the provider
 *   record  cache miss hits the provider and is written to the cache; a hit is served from it
 *   replay  the cache only; a miss is an error
 *
 * The cache is what makes the demo survivable and the evals affordable. A recorded run can be
 * replayed with the network unplugged, which means the live agent can be demonstrated for real and
 * still have a deterministic fallback if a provider is rate-limiting at the wrong moment. It also
 * means the eval corpus is paid for once rather than once per run, and that every test in this
 * repository runs offline.
 *
 * Keying on sha256(model + body) rather than a request id is deliberate: the same question asked
 * of the same model returns the recorded answer, and changing the prompt invalidates the entry
 * automatically instead of silently serving a stale one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';

export class TransportError extends Error {}

export type TransportMode = 'live' | 'record' | 'replay';

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  /** Present on assistant turns that call tools. */
  readonly tool_calls?: readonly ToolCall[];
  /** Present on tool result turns; ties the result to the call it answers. */
  readonly tool_call_id?: string;
}

/** An OpenAI-compatible function tool definition. */
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly tools?: readonly ToolDefinition[];
  /** Judge calls ask for a JSON object; agent calls must not, since they may return tool calls. */
  readonly jsonMode?: boolean;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly tool_calls?: readonly ToolCall[];
}

export interface Transport {
  readonly mode: TransportMode;
  /** Full assistant turn, including any tool calls. */
  chat(request: ChatRequest): Promise<AssistantMessage>;
  /** Content only. What the judge uses, since a judge never calls tools. */
  complete(request: ChatRequest): Promise<string>;
  /** Number of calls that reached the provider. Reported by the eval runner. */
  readonly liveCalls: number;
}

export function cacheKey(request: ChatRequest): string {
  const material = JSON.stringify({
    model: request.model,
    temperature: request.temperature,
    messages: request.messages,
    tools: request.tools ?? null,
    jsonMode: request.jsonMode ?? false,
  });
  return Buffer.from(sha256(Buffer.from(material, 'utf8'))).toString('hex');
}

interface CacheFile {
  [key: string]: {
    readonly model: string;
    readonly message: AssistantMessage;
    readonly at: string;
  };
}

function loadCache(path: string): CacheFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
  } catch (cause) {
    throw new TransportError(`judge cache at ${path} is unreadable: ${(cause as Error).message}`);
  }
}

export interface TransportOptions {
  readonly mode: TransportMode;
  /** OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1 */
  readonly baseURL: string;
  readonly apiKey: string;
  readonly cachePath: string;
  /** Retries on 429 and 5xx. Backoff is exponential from 1s. */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Backoff for a rate-limited provider. Free tiers are the normal case for this project, and an
 * eval pass that dies halfway through on a 429 has to be re-paid for from the start -- which is
 * also why the record mode writes each response to disk as it arrives rather than at the end.
 */
async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(30_000, 1000 * 2 ** attempt);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTransport(options: TransportOptions): Transport {
  const { mode, baseURL, apiKey, cachePath } = options;
  const maxRetries = options.maxRetries ?? 4;
  const doFetch = options.fetchImpl ?? fetch;
  const cache = mode === 'live' ? {} : loadCache(cachePath);
  let liveCalls = 0;

  const persist = (key: string, model: string, message: AssistantMessage): void => {
    cache[key] = { model, message, at: new Date().toISOString() };
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  };

  const callProvider = async (request: ChatRequest): Promise<AssistantMessage> => {
    if (!apiKey) {
      throw new TransportError(
        'no API key is configured, so no model call can be made; set JUDGE_API_KEY, or run in ' +
          'replay mode against a recorded cache',
      );
    }

    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await doFetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          ...(request.tools ? { tools: request.tools } : {}),
          // Asked for, not relied upon. Providers differ in whether they honour it, so the
          // response is validated with Zod regardless -- see openai-compatible.ts. Never set
          // alongside tools: a turn that must return a tool call cannot also be a JSON object.
          ...(request.jsonMode && !request.tools
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
      });

      if (response.ok) {
        liveCalls += 1;
        const body = (await response.json()) as {
          choices?: { message?: AssistantMessage }[];
        };
        const message = body.choices?.[0]?.message;
        if (!message) throw new TransportError('provider returned no assistant message');
        // Content may legitimately be null on a turn that only calls tools.
        return {
          role: 'assistant',
          content: message.content ?? null,
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        };
      }

      lastError = `${response.status} ${await response.text().catch(() => '')}`.slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) break;
      await backoff(attempt);
    }
    throw new TransportError(`provider call failed: ${lastError}`);
  };

  return {
    mode,
    get liveCalls() {
      return liveCalls;
    },
    async chat(request) {
      const key = cacheKey(request);

      if (mode === 'replay') {
        const hit = cache[key];
        if (!hit) {
          throw new TransportError(
            `replay mode: no recorded response for this request (key ${key.slice(0, 12)}...). ` +
              `Record it first with JUDGE_MODE=record.`,
          );
        }
        return hit.message;
      }

      if (mode === 'record') {
        const hit = cache[key];
        if (hit) return hit.message;
        const message = await callProvider(request);
        persist(key, request.model, message);
        return message;
      }

      return callProvider(request);
    },

    async complete(request) {
      const message = await this.chat({ ...request, jsonMode: true });
      if (typeof message.content !== 'string') {
        throw new TransportError('provider returned no message content');
      }
      return message.content;
    },
  };
}
