import type { CallToolResult } from '@modelcontextprotocol/server';
import { toErrorPayload } from '../errors.js';

/**
 * Structured payload rendered in full as the text channel too. List tools
 * used to answer a bare count ("3 job(s).") while the rows rode along only
 * in `structuredContent`, which text-only readers never see — so the text now
 * carries the complete payload, pretty-printed, instead of a summary.
 */
export function toolOk(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured
  };
}

export function toolError(error: unknown): CallToolResult {
  const payload = toErrorPayload(error);
  return {
    content: [{ type: 'text', text: `${payload.code}: ${payload.message}` }],
    structuredContent: { ...payload },
    isError: true
  };
}
