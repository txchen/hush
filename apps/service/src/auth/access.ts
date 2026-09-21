import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity } from "../vault/model";
import { ApiError } from "../errors";

// Cache only public signing keys, never caller identity or request state.
let cachedKeys: { issuer: string; resolve: ReturnType<typeof createRemoteJWKSet> } | undefined;

export async function authenticate(request: Request, env: Env): Promise<Identity> {
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    env.ACCESS_TEAM_DOMAIN.startsWith("configure-me") ||
    env.ACCESS_AUDIENCE === "configure-me" ||
    env.OWNER_EMAIL.endsWith(".invalid")
  ) {
    throw new ApiError(503, "access_not_configured");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16_384) throw new ApiError(401, "authentication_required");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (cachedKeys?.issuer !== issuer)
    cachedKeys = {
      issuer,
      resolve: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
      }),
    };
  let payload;
  try {
    ({ payload } = await jwtVerify(token, cachedKeys.resolve, {
      issuer,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "iss", "aud"],
    }));
  } catch {
    throw new ApiError(401, "invalid_access_token");
  }
  if (typeof payload.common_name === "string") {
    if (payload.sub !== "" || payload.email !== undefined)
      throw new ApiError(403, "invalid_device_identity");
    return { role: "device", clientId: payload.common_name };
  }
  if (
    typeof payload.email === "string" &&
    payload.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase() &&
    typeof payload.sub === "string" &&
    payload.sub.length > 0
  ) {
    return { role: "owner", subject: payload.sub };
  }
  throw new ApiError(403, "owner_required");
}
