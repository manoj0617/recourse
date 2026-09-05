/**
 * A deterministic transport that plays a fixed agent script.
 *
 * This is NOT a demo mode and is labelled as such wherever it runs. No model is involved, so a
 * scenario driven by it demonstrates that the wiring is correct and demonstrates nothing about
 * whether an agent would actually behave that way. It exists so the end-to-end path can be
 * exercised in CI and on a machine with no API key.
 *
 * The demo runs live. The fallback for a rate-limited provider mid-recording is the replay cache
 * (JUDGE_MODE=replay), which plays back real model responses -- not this.
 */

import type { AssistantMessage, Transport } from '../judge/transport.js';

export interface ScriptStep {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export function scriptedTransport(
  steps: readonly ScriptStep[],
  closing = 'Done.',
): Transport {
  let index = 0;
  return {
    mode: 'replay',
    liveCalls: 0,
    async chat(): Promise<AssistantMessage> {
      const step = steps[index];
      index += 1;
      if (!step) return { role: 'assistant', content: closing };
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${index}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.args) },
          },
        ],
      };
    },
    async complete(): Promise<string> {
      // The judge never runs under a scripted transport: scenarios that need a semantic ruling
      // supply a scripted judge instead. Reaching here means a scenario was mis-wired.
      throw new Error(
        'scripted transport received a judge call; scripted scenarios must supply a scripted judge',
      );
    },
  };
}
