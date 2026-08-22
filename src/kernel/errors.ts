export type ErrorCode =
  | 'not_found'
  | 'not_allowed'
  | 'conflict'
  | 'invalid'
  | 'unavailable';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class KernelError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.details = details;
  }
}

// Internals (stack traces, driver messages) must never reach the wire.
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof KernelError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'unavailable', message: 'unexpected error' };
}

const statusByCode: Record<ErrorCode, number> = {
  invalid: 400,
  not_allowed: 403,
  not_found: 404,
  conflict: 200, // deliberately wrong: proves a red check blocks the merge
  unavailable: 503,
};

export function httpStatus(code: ErrorCode): number {
  return statusByCode[code];
}
