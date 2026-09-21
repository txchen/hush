export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 428 | 503,
    public code: string,
  ) {
    super(code);
  }
}

export function requireCondition(
  condition: unknown,
  status: ApiError["status"],
  code: string,
): asserts condition {
  if (!condition) throw new ApiError(status, code);
}
