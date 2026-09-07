export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export function publicError(error: unknown): Record<string, unknown> {
  if (error instanceof ConnectorError) {
    const details: Record<string, unknown> = {};
    for (const key of ["accountId", "httpStatus", "outcomeUnknown", "lockPath", "missingScopes", "requiredScopes", "reason", "operationId", "retryAfter"]) {
      const value = error.details?.[key];
      if (typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.length <= 2048)) {
        details[key] = value;
      } else if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string" && item.length <= 256)) {
        details[key] = value;
      }
    }
    return { code: error.code, message: error.message, retryable: error.retryable, ...details };
  }
  return { code: "internal_error", message: "The operation failed. Check local setup or report this error without including credentials.", retryable: false };
}
