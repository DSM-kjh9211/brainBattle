/** Stable, machine-readable error codes returned over REST and WebSocket. */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',

  INVALID_JOIN_CODE: 'INVALID_JOIN_CODE',
  JOIN_BLOCKED: 'JOIN_BLOCKED',
  SESSION_FULL: 'SESSION_FULL',
  SESSION_CLOSED: 'SESSION_CLOSED',
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  NOT_IN_CLASSROOM: 'NOT_IN_CLASSROOM',
  KICKED: 'KICKED',
  INVALID_RESUME_TOKEN: 'INVALID_RESUME_TOKEN',
  NOT_JOINED: 'NOT_JOINED',

  INVALID_TRANSITION: 'INVALID_TRANSITION',
  SESSION_LOCKED: 'SESSION_LOCKED',
  SUBMISSION_CLOSED: 'SUBMISSION_CLOSED',
  EDIT_NOT_ALLOWED: 'EDIT_NOT_ALLOWED',
  QUESTION_NOT_ACTIVE: 'QUESTION_NOT_ACTIVE',
  INVALID_ANSWER: 'INVALID_ANSWER',
  STALE_REVISION: 'STALE_REVISION',
  SESSION_OWNED_ELSEWHERE: 'SESSION_OWNED_ELSEWHERE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'BAD_REQUEST':
      case 'INVALID_ANSWER':
        return 400;
      case 'UNAUTHENTICATED':
      case 'LOGIN_REQUIRED':
        return 401;
      case 'FORBIDDEN':
      case 'NOT_IN_CLASSROOM':
      case 'KICKED':
        return 403;
      case 'NOT_FOUND':
      case 'INVALID_JOIN_CODE':
        return 404;
      case 'RATE_LIMITED':
      case 'JOIN_BLOCKED':
        return 429;
      case 'INTERNAL':
        return 500;
      default:
        return 409;
    }
  }
}
