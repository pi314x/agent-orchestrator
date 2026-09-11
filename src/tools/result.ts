import type { CallToolResult } from '@modelcontextprotocol/server';
import { toErrorPayload } from '../errors.js';

/** Structured payload plus the short text summary every tool owes the model. */
export function toolOk(structured: Record<string, unknown>, summary: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
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
