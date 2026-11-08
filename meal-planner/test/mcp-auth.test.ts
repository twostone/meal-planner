import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHaTokenVerifier, HaUnavailableError, jwtExpiry, type HaTokenVerifierOptions } from "../src/auth/ha-token.ts";
import { fetchHaExternalUrl } from "../src/auth/ha-url.ts";
import { mcpSettings, parsePublicUrl } from "../src/options.ts";

// A JWT-shaped token: HA checks the signature, the app only reads exp.
function jwt(expSecondsFromNow = 1800, now = Date.now()): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ exp: Math.floor(now / 1000) + expSecondsFromNow, jti: Math.random() })}.sig`;
}

type HaUserInfo = { id: string; name: string; is_admin?: boolean; credentials?: unknown[] };

// Stands in for Home Assistant's WebSocket API (auth handshake and auth/current_user) without a network.
function fakeHa(users: Record<string, HaUserInfo>, opts: { silent?: boolean } = {}) {
  const stats = { connections: 0 };
  const createSocket: HaTokenVerifierOptions["createSocket"] = () => {
    stats.connections++;
    const socket = {
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      user: undefined as HaUserInfo | undefined,
      send(data: string) {
        const msg = JSON.parse(data);
        const reply = (m: unknown) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(m) }));
        if (msg.type === "auth") {
          socket.user = users[msg.access_token];
          reply({ type: socket.user ? "auth_ok" : "auth_invalid" });
        } else if (msg.type === "auth/current_user" && socket.user) {
          reply({ id: msg.id, type: "result", success: true, result: { is_admin: false, credentials: [{ auth_provider_type: "homeassistant" }], ...socket.user } });
        }
      },
      close() {},
    };
    if (!opts.silent) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: "auth_required" }) }));
    return socket;
  };
  return { createSocket, stats };
}

test("jwtExpiry reads exp and rejects non-JWTs", () => {
  assert.equal(jwtExpiry("nope"), null);
  assert.equal(jwtExpiry("a.b.c"), null);
  assert.equal(jwtExpiry(jwt(60, 1_000_000)), 1000 + 60);
});

test("token check: real user accepted, unknown token and system user refused, expired never asked", async () => {
  const good = jwt();
  const system = jwt();
  const ha = fakeHa({ [good]: { id: "u1", name: "Anna" }, [system]: { id: "sys", name: "Supervisor", credentials: [] } });
  const verify = createHaTokenVerifier({ createSocket: ha.createSocket });
  assert.deepEqual((await verify(good))?.user, { id: "u1", name: "Anna" });
  assert.equal(await verify(jwt()), null);
  assert.equal(await verify(system), null);
  const before = ha.stats.connections;
  assert.equal(await verify(jwt(-10)), null);
  assert.equal(await verify("not-a-jwt"), null);
  assert.equal(ha.stats.connections, before);
});

test("token check: cached by hash, concurrent lookups share one connection", async () => {
  const good = jwt();
  const ha = fakeHa({ [good]: { id: "u1", name: "Anna" } });
  const verify = createHaTokenVerifier({ createSocket: ha.createSocket });
  await Promise.all([verify(good), verify(good), verify(good)]);
  await verify(good);
  assert.equal(ha.stats.connections, 1);
});

test("token check: Home Assistant not answering is an error, never anonymous access", async () => {
  const verify = createHaTokenVerifier({ createSocket: fakeHa({}, { silent: true }).createSocket, timeoutMs: 20 });
  await assert.rejects(verify(jwt()), HaUnavailableError);
});

test("options: MCP URLs are optional, invalid ones are named and ignored", () => {
  assert.deepEqual(mcpSettings({}), { appUrl: null, haUrl: null, invalid: [] });
  assert.deepEqual(mcpSettings({ mcp_app_url: "https://essen.example.test/", mcp_ha_url: "" }), { appUrl: "https://essen.example.test", haUrl: null, invalid: [] });
  assert.deepEqual(mcpSettings({ mcp_app_url: "ftp://x", mcp_ha_url: "https://u:p@ha.example.test" }), { appUrl: null, haUrl: null, invalid: ["mcp_app_url", "mcp_ha_url"] });
  assert.equal(parsePublicUrl("https://ha.example.test?x=1"), null);
});

test("Home Assistant's external URL from /api/config; none or failure -> null", async () => {
  let body: unknown = { external_url: "https://ha.example.test/" };
  let status = 200;
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    assert.equal(await fetchHaExternalUrl("tok", base), "https://ha.example.test");
    assert.equal(auth, "Bearer tok");
    body = { external_url: null };
    assert.equal(await fetchHaExternalUrl("tok", base), null);
    status = 500;
    assert.equal(await fetchHaExternalUrl("tok", base), null);
    assert.equal(await fetchHaExternalUrl(null, base), null);
  } finally {
    server.close();
  }
});
