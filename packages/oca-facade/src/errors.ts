/**
 * Neutral facade error model.
 *
 * The eight codes below are the only error vocabulary the facade exposes.
 * Raw runtime errors are never propagated: their messages may contain
 * internal implementation details, so `toFacadeError` maps them to a
 * neutral code with a facade-generated message. The original runtime text
 * only belongs in internal logs.
 */
export const FACADE_ERROR_CODES = [
  'invalid_request',
  'session_not_found',
  'session_state_conflict',
  'prompt_rejected',
  'request_not_pending',
  'session_resume_failed',
  'runtime_unavailable',
  'internal_error',
] as const;

export type FacadeErrorCode = (typeof FACADE_ERROR_CODES)[number];

const HTTP_STATUS_BY_CODE: Record<FacadeErrorCode, number> = {
  invalid_request: 400,
  session_not_found: 404,
  session_state_conflict: 409,
  prompt_rejected: 409,
  request_not_pending: 409,
  session_resume_failed: 500,
  runtime_unavailable: 500,
  internal_error: 500,
};

const NEUTRAL_MESSAGE_BY_CODE: Record<FacadeErrorCode, string> = {
  invalid_request: 'The request is invalid.',
  session_not_found: 'The session was not found.',
  session_state_conflict: 'The session state does not allow this operation.',
  prompt_rejected: 'The session cannot accept a prompt right now.',
  request_not_pending: 'No pending request matches the provided identifier.',
  session_resume_failed: 'The session could not be resumed.',
  runtime_unavailable: 'The runtime is unavailable.',
  internal_error: 'An internal error occurred.',
};

export interface FacadeErrorBody {
  error: {
    code: FacadeErrorCode;
    message: string;
  };
}

export class FacadeError extends Error {
  readonly code: FacadeErrorCode;
  readonly httpStatus: number;

  /**
   * @param message Optional facade-generated neutral copy. Never pass raw
   * runtime error text here.
   */
  constructor(code: FacadeErrorCode, message?: string) {
    super(message ?? NEUTRAL_MESSAGE_BY_CODE[code]);
    this.name = 'FacadeError';
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}

export function isFacadeError(err: unknown): err is FacadeError {
  return err instanceof FacadeError;
}

export function httpStatusForCode(code: FacadeErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

/**
 * Sanitization point: converts any thrown value into a FacadeError.
 * FacadeError instances pass through untouched; anything else (raw runtime
 * errors included) is replaced by a neutral code with its default neutral
 * message — the original message is dropped, never copied.
 */
export function toFacadeError(err: unknown, code: FacadeErrorCode = 'internal_error'): FacadeError {
  if (err instanceof FacadeError) return err;
  return new FacadeError(code);
}

export function toErrorBody(err: unknown, code: FacadeErrorCode = 'internal_error'): FacadeErrorBody {
  const facadeError = toFacadeError(err, code);
  return { error: { code: facadeError.code, message: facadeError.message } };
}
