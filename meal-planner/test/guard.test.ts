import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

const INGRESS = "172.30.32.2";
const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
const guarded = () => createApp(createRepo(openDb(":memory:")), { allowedIp: INGRESS });

test("guard: ingress address is served (also as IPv4-mapped IPv6)", async () => {
  const app = guarded();
  assert.equal((await app.request("/api/plans", {}, from(INGRESS))).status, 200);
  assert.equal((await app.request("/api/plans", {}, from("::ffff:" + INGRESS))).status, 200);
});

test("guard: other addresses are refused, forged user headers do not help", async () => {
  const app = guarded();
  for (const ip of ["172.30.32.3", "192.168.1.10", "127.0.0.1", "::1"]) {
    const res = await app.request("/api/me", { headers: { "X-Remote-User-Id": "admin" } }, from(ip));
    assert.equal(res.status, 403, ip);
  }
});

test("guard: without connection info it fails closed", async () => {
  assert.equal((await guarded().request("/api/plans")).status, 403);
});

test("guard: disabled when no address is configured (dev/tests)", async () => {
  const app = createApp(createRepo(openDb(":memory:")));
  assert.equal((await app.request("/api/plans")).status, 200);
});
