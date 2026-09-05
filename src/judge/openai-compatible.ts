/**
 * The one judge implementation, speaking the OpenAI chat-completions dialect.
 *
 * Configured by `baseURL`, `apiKey` and `model`, so Groq, Cerebras, Mistral and anything else
 * that speaks the same shape are reachable without a code change. There is no provider SDK here
 * on purpose -- the dialect is a POST with a JSON body, and a dependency that wraps that buys
 * nothing while pinning us to one vendor's release cycle.
 *
 * The important behaviour in this file is what happens when the model misbehaves. Models emit
 * markdown fences around JSON, prose before it, trailing commentary after it, and occasionally
 * something unparseable. The recovery ladder is: strip fences, extract the outermost JSON object,
 * validate with Zod; on failure retry once with a corrective message; on a second failure
 * ESCALATE. There is no third branch and no default value. A judge that cannot answer produces a
 * hold, never a pass.
 */

import type { z } from 'zod';
import {
  adjudicationResponseSchema,
  conformanceResponseSchema,
  type AdjudicationInput,
  type AdjudicationResponse,
  type ConformanceInput,
  type ConformanceJudge,
  type ConformanceResponse,
  type JudgeOutcome,
} from './types.js';
import {
  ADJUDICATION_SYSTEM,
  CONFORMANCE_SYSTEM,
  PROMPT_VERSION,
  adjudicationUser,
  conformanceUser,
} from './prompts.js';
import type { ChatMessage, Transport } from './transport.js';

export interface JudgeOptions {
  readonly transport: Transport;
  readonly model: string;
  /** Rulings at or below this confidence escalate. */
  readonly confidenceThreshold?: number;
  /**
   * Zero by default. This is a classification task with a right answer, not a writing task, and
   * sampling variance here is variance in whether a payment is allowed.
   */
  readonly temperature?: number;
}

/**
 * Pull a JSON object out of whatever the model actually said.
 *
 * Handles the common failures directly rather than hoping `response_format` was honoured: fenced
 * blocks, a leading sentence of prose, trailing commentary. Takes the outermost braces so that a
 * nested object does not truncate the parse.
 */
export function extractJson(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object found in the response');
  }
  return JSON.parse(withoutFences.slice(start, end + 1));
}

const CORRECTION =
  'Your previous reply could not be parsed. Reply with the JSON object only: no prose, ' +
  'no markdown fences, no explanation before or after it.';

export function createJudge(options: JudgeOptions): ConformanceJudge {
  const { transport, model } = options;
  const temperature = options.temperature ?? 0;
  const confidenceThreshold = options.confidenceThreshold ?? 0.6;

  /**
   * One question, at most two attempts, then escalation.
   *
   * The retry sends the model's own bad output back with a correction, which recovers the
   * overwhelmingly common failure -- a well-formed answer wrapped in something that is not JSON --
   * without pretending that a second failure is recoverable.
   */
  async function ask<T>(
    system: string,
    user: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<JudgeOutcome<T>> {
    let raw = '';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        raw = await transport.complete({ model, messages, temperature });
      } catch (cause) {
        // A transport failure is not a verdict. It escalates like any other unusable answer.
        return { status: 'escalate', reason: `model call failed: ${(cause as Error).message}` };
      }

      try {
        const parsed = schema.safeParse(extractJson(raw));
        if (parsed.success) return { status: 'ok', value: parsed.data, raw };

        if (attempt === 0) {
          messages.push({ role: 'user', content: `${CORRECTION}\n\nYour reply was:\n${raw}` });
          continue;
        }
        return {
          status: 'escalate',
          raw,
          reason: `response did not match the required schema after a retry: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        };
      } catch (cause) {
        if (attempt === 0) {
          messages.push({ role: 'user', content: `${CORRECTION}\n\nYour reply was:\n${raw}` });
          continue;
        }
        return {
          status: 'escalate',
          raw,
          reason: `response was not usable JSON after a retry: ${(cause as Error).message}`,
        };
      }
    }

    // Unreachable: both branches above return on the second attempt. Present so that a future
    // edit to the loop bounds cannot silently fall through to something permissive.
    return { status: 'escalate', raw, reason: 'judge exhausted its attempts without a ruling' };
  }

  return {
    model,
    promptVersion: PROMPT_VERSION,
    confidenceThreshold,

    conformance(input: ConformanceInput): Promise<JudgeOutcome<ConformanceResponse>> {
      return ask(CONFORMANCE_SYSTEM, conformanceUser(input.goal, input.cart), conformanceResponseSchema);
    },

    adjudicate(input: AdjudicationInput): Promise<JudgeOutcome<AdjudicationResponse>> {
      return ask(
        ADJUDICATION_SYSTEM,
        adjudicationUser(input.goal, input.complaint, input.chain),
        adjudicationResponseSchema,
      );
    },
  };
}
