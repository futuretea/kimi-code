import { describe, expect, it } from 'vitest';

import {
  FACADE_ERROR_CODES,
  FacadeError,
  httpStatusForCode,
  isFacadeError,
  toErrorBody,
  toFacadeError,
  type FacadeErrorCode,
} from '../src/errors';

const EXPECTED_HTTP_STATUS: Record<FacadeErrorCode, number> = {
  invalid_request: 400,
  session_not_found: 404,
  session_state_conflict: 409,
  prompt_rejected: 409,
  request_not_pending: 409,
  session_resume_failed: 500,
  runtime_unavailable: 500,
  internal_error: 500,
};

const FORBIDDEN_TOKENS = /kimi|acp|kap-server|sidecar/i;

describe('facade error model', () => {
  it('defines exactly the eight neutral error codes of the contract', () => {
    expect([...FACADE_ERROR_CODES].toSorted()).toEqual(
      [
        'internal_error',
        'invalid_request',
        'prompt_rejected',
        'request_not_pending',
        'session_not_found',
        'session_resume_failed',
        'session_state_conflict',
        'runtime_unavailable',
      ].toSorted(),
    );
  });

  it.each(Object.entries(EXPECTED_HTTP_STATUS))(
    'maps %s to HTTP %i',
    (code, status) => {
      expect(httpStatusForCode(code as FacadeErrorCode)).toBe(status);
      expect(new FacadeError(code as FacadeErrorCode).httpStatus).toBe(status);
    },
  );

  it('produces the contract error body shape {"error":{"code","message"}}', () => {
    const body = toErrorBody(new FacadeError('session_not_found'));
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).toSorted()).toEqual(['code', 'message']);
    expect(body.error.code).toBe('session_not_found');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('uses neutral default messages with no internal implementation tokens', () => {
    for (const code of FACADE_ERROR_CODES) {
      const err = new FacadeError(code);
      expect(err.message).not.toMatch(FORBIDDEN_TOKENS);
      expect(err.code).not.toMatch(FORBIDDEN_TOKENS);
    }
  });

  it('never leaks raw runtime error messages through toFacadeError', () => {
    const raw = new Error(
      'kimi acp kap-server sidecar exploded at /home/agent/.kimi/sessions/x/state.json',
    );
    const err = toFacadeError(raw);
    expect(err.code).toBe('internal_error');
    expect(err.message).not.toContain(raw.message);
    expect(err.message).not.toMatch(FORBIDDEN_TOKENS);
    expect(toErrorBody(raw).error.message).toBe(err.message);
  });

  it('maps raw runtime errors to a caller-chosen neutral code with a sanitized message', () => {
    const raw = new Error('resume failed: kimi journal corrupt at /secret/path');
    const err = toFacadeError(raw, 'session_resume_failed');
    expect(err.code).toBe('session_resume_failed');
    expect(err.httpStatus).toBe(500);
    expect(err.message).not.toContain('journal corrupt');
    expect(err.message).not.toMatch(FORBIDDEN_TOKENS);
  });

  it('passes FacadeError instances through unchanged', () => {
    const original = new FacadeError('prompt_rejected', 'The session is busy.');
    expect(toFacadeError(original)).toBe(original);
    expect(toFacadeError(original, 'internal_error')).toBe(original);
  });

  it('recognizes facade errors via isFacadeError', () => {
    expect(isFacadeError(new FacadeError('invalid_request'))).toBe(true);
    expect(isFacadeError(new Error('boom'))).toBe(false);
    expect(isFacadeError('invalid_request')).toBe(false);
    expect(isFacadeError(undefined)).toBe(false);
  });
});
