import { OAuthError, OAuthErrorCode, requireBearerAuth, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { HaUnavailableError, type HaTokenVerifier } from "./auth/ha-token.ts";
import { metadataUrl, resourceMetadata } from "./auth/resource-metadata.ts";
import { logger } from "./log.ts";

const log = logger("mcp-listener");
// Only failures and slow requests are logged, like on the Ingress listener.
const SLOW_REQUEST_MS = 2000;

export type McpListenerOptions = {
  /** Public URL of this listener (behind the user's TLS reverse proxy), no trailing slash. */
  appUrl: string;
  /** Public URL of Home Assistant, the OAuth authorization server. */
  haUrl: string;
  verifier: HaTokenVerifier;
  /** Handles /mcp for a request with a verified token. */
  mcp: (request: Request, authInfo: AuthInfo) => Promise<Response>;
};

// Bearer check through the SDK: 401 with a WWW-Authenticate challenge that points MCP clients to the protected-resource
// metadata, from where they find Home Assistant (RFC 9728). Home Assistant down = 5xx, never anonymous.
function bearerGate(verifier: HaTokenVerifier, appUrl: string) {
  const oauthVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      let verified;
      try {
        verified = await verifier(token);
      } catch (e) {
        if (e instanceof HaUnavailableError) throw new OAuthError(OAuthErrorCode.ServerError, "authorization server unavailable");
        throw e;
      }
      if (!verified) throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid token");
      return { token, clientId: "home-assistant", scopes: [], expiresAt: verified.expiresAt, extra: { user: verified.user } };
    },
  };
  return requireBearerAuth({ verifier: oauthVerifier, resourceMetadataUrl: metadataUrl(appUrl) });
}

// Third listener (MCP_PORT, 8101), the only one meant to be reached from outside, through the user's reverse proxy. It
// serves exactly the MCP endpoint and its OAuth metadata. Identity comes from a Home Assistant access token only:
// X-Remote-User-* are never read here, the Ingress API (/api) and the frontend are not mounted. Everything else is 404.
export function createMcpListener(opts: McpListenerOptions) {
  const app = new Hono();
  const gate = bearerGate(opts.verifier, opts.appUrl);

  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = Math.round(performance.now() - t0);
    const status = c.res.status;
    // 401 is the normal first step of every OAuth sign-in, not worth a warning.
    if ((status >= 400 && status !== 401) || ms >= SLOW_REQUEST_MS) {
      (status >= 500 ? log.error : log.warn)("request", { method: c.req.method, path: c.req.path, status, ms });
    }
  });

  app.route("/", resourceMetadata(opts.appUrl, opts.haUrl));

  app.all("/mcp", async (c) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    try {
      return await opts.mcp(c.req.raw, auth);
    } catch (err) {
      log.error("mcp_failed", { err, stack: err instanceof Error ? err.stack : undefined });
      return c.json({ error: "internal error" }, 500);
    }
  });
  return app;
}
