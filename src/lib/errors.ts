// Formato uniforme de errores — docs/arquitectura.md §10.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "EMAIL_NOT_VERIFIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUSINESS_CLOSED"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  EMAIL_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_CLOSED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500
};

export interface ErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const notFound = (message = "El recurso no existe.") => new ApiError("NOT_FOUND", message);
