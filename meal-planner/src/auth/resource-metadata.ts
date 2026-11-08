import { Hono } from "hono";
import { cors } from "hono/cors";

// RFC 9728 protected-resource metadata: this app is the resource server, Home Assistant the authorization server. MCP
// clients (claude.ai connectors via client-id metadata documents, Claude Code via loopback redirects) find HA from here
// and get their tokens from HA directly. Public by design, hence the open CORS.
export function resourceMetadata(appUrl: string, haUrl: string) {
  const document = {
    resource: `${appUrl}/mcp`,
    authorization_servers: [haUrl],
    bearer_methods_supported: ["header"],
    resource_name: "Essensplanung",
  };
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
  // Both forms: path-aware (RFC 9728 for the /mcp resource) and the plain one some clients probe first.
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(document));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(document));
  return app;
}

/** URL advertised in the WWW-Authenticate challenge. */
export const metadataUrl = (appUrl: string) => `${appUrl}/.well-known/oauth-protected-resource/mcp`;
