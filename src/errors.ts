/**
 * Error codes shared by every backend. A2A-originated failures are mapped onto
 * these so a caller sees one shape regardless of which backend ran the work.
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'TIMEOUT',
  'INTERRUPTED',
  'DEPTH_EXCEEDED',
  'BUDGET_EXCEEDED',
  'POLICY_DENIED',
  'RUNNER_FAILED',
  'INTERNAL',
  // A2A-originated
  'REMOTE_REJECTED',
  'REMOTE_UNVERIFIED',
  'REMOTE_UNREACHABLE'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.hint = hint;
  }

  toPayload(): ErrorPayload {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof OrchestratorError) return error.toPayload();
  if (error instanceof Error) return { code: 'INTERNAL', message: error.message };
  return { code: 'INTERNAL', message: String(error) };
}
