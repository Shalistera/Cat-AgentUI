import type { ChatRequest } from '../types.js';

/** Output cap floor for a request that thinks, where the provider counts the
 * thinking inside that cap (Gemini maxOutputTokens, OpenAI
 * max_completion_tokens / max_output_tokens). The same 32K the Anthropic
 * adapter gives adaptive thinking. */
export const THINKING_OUTPUT_FLOOR = 32_768;

/**
 * The output cap to send. `maxTokens` is sized for the visible answer; at 8K a
 * high thinking tier can spend all of it before the answer starts. A request
 * that thinks is raised to THINKING_OUTPUT_FLOOR, or to `minimum` when a
 * thinking budget needs more, but never above `hardMaxTokens`. Callers that
 * omit `hardMaxTokens` asked for an exact cap and keep it.
 */
export function thinkingOutputCap(
  req: Pick<ChatRequest, 'maxTokens' | 'hardMaxTokens'>,
  thinks: boolean,
  minimum = 0,
): number | undefined {
  const { maxTokens, hardMaxTokens } = req;
  if (!maxTokens || !thinks || hardMaxTokens === undefined) return maxTokens;
  return Math.max(maxTokens, Math.min(Math.max(THINKING_OUTPUT_FLOOR, minimum), hardMaxTokens));
}
