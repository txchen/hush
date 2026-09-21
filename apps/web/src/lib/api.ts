export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
  revision?: number,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Hush-Request"] = "1";
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (revision !== undefined) headers["If-Match"] = `"${revision}"`;
  const options: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  };
  if (data !== undefined && method !== "GET") options.body = JSON.stringify(data);
  const response = await fetch(`/api/v1${path}`, options);
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new ApiError(401, "authentication_required");
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.error?.code ?? "request_failed");
  return result as T;
}
export function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "secret_in_use") return "Remove this secret from its profiles first.";
    if (error.status === 409)
      return "The vault changed or this value is already in use. Refresh and try again.";
    if (error.status === 401) return "Your sign-in expired. Reload to sign in again.";
    if (error.status === 403)
      return "This action requires the owner account. Your session may have expired.";
    if (error.status === 503) return "Configure Cloudflare Access before opening this vault.";
    return error.code.replaceAll("_", " ");
  }
  return "The operation could not be completed. Check your input and connection.";
}
