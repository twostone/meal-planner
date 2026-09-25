import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { assertAllowedUrl, FetchError, isPublicIp } from "../src/net-guard.ts";
import { fetchLimited, guardedLookup } from "../src/safe-fetch.ts";

test("isPublicIp: private, loopback, link-local and special ranges are refused", () => {
  const refused = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.30.32.1", "172.31.255.255", "192.168.178.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1",
    "not-an-ip", "",
  ];
  for (const ip of refused) assert.equal(isPublicIp(ip), false, ip);
  const allowed = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"];
  for (const ip of allowed) assert.equal(isPublicIp(ip), true, ip);
});

test("assertAllowedUrl: scheme, credentials, ports and IP literals in every spelling", () => {
  const refused = [
    "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/",
    "http://user:pw@example.com/", "http://example.com:8123/", "https://example.com:22/",
    "http://127.0.0.1/", "http://[::1]/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://169.254.169.254/latest/meta-data", "http://[::ffff:127.0.0.1]/", "http://172.30.32.1/", "http://192.168.1.1/",
  ];
  for (const u of refused) assert.throws(() => assertAllowedUrl(new URL(u)), FetchError, u);
  for (const u of ["http://example.com/", "https://example.com:443/x", "http://example.com:80/", "https://93.184.216.34/"]) {
    assert.doesNotThrow(() => assertAllowedUrl(new URL(u)), u);
  }
});

test("guardedLookup: a name that resolves to loopback is refused, in both lookup call styles", async () => {
  for (const options of [{ all: true }, {}, { family: 4 }, 4]) {
    const err = await new Promise<unknown>((resolve) => guardedLookup("localhost", options, (e) => resolve(e)));
    assert.ok(err instanceof FetchError && err.reason === "blocked", JSON.stringify(options));
  }
});

test("fetchLimited (without the test switch) refuses local targets", async () => {
  const o = { maxBytes: 1000, accept: "*/*" };
  for (const u of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "file:///etc/passwd", "not a url"]) {
    await assert.rejects(fetchLimited(u, o), (e: unknown) => e instanceof FetchError && e.reason === "blocked", u);
  }
});

// --- against a real local server (the test switch allowPrivate lets 127.0.0.1 through) ---

async function withServer(handler: http.RequestListener, fn: (base: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const local = { maxBytes: 1000, accept: "*/*", allowPrivate: true };
const reasonOf = (reason: string) => (e: unknown) => e instanceof FetchError && e.reason === reason;

test("fetchLimited: plain response with charset and content type", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/HTML; charset=ISO-8859-1" });
      res.end(Buffer.from("Grüne Soße", "latin1"));
    },
    async (base) => {
      const r = await fetchLimited(base + "/x", local);
      assert.equal(r.contentType, "text/html");
      assert.equal(r.charset, "ISO-8859-1");
      assert.equal(r.body.toString("latin1"), "Grüne Soße");
    },
  );
});

test("fetchLimited: gzip and brotli bodies are decoded", async () => {
  await withServer(
    (req, res) => {
      const br = req.url === "/br";
      res.writeHead(200, { "Content-Encoding": br ? "br" : "gzip" });
      res.end(br ? zlib.brotliCompressSync("hello br") : zlib.gzipSync("hello gzip"));
    },
    async (base) => {
      assert.equal((await fetchLimited(base + "/gz", local)).body.toString(), "hello gzip");
      assert.equal((await fetchLimited(base + "/br", local)).body.toString(), "hello br");
    },
  );
});

test("fetchLimited: follows relative and absolute redirects, reports the final URL", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/a") return void res.writeHead(302, { Location: "/b" }).end();
      if (req.url === "/b") return void res.writeHead(301, { Location: `http://${req.headers.host}/c` }).end();
      res.end("done");
    },
    async (base) => {
      const r = await fetchLimited(base + "/a", local);
      assert.equal(r.url.pathname, "/c");
      assert.equal(r.body.toString(), "done");
    },
  );
});

test("fetchLimited: redirect loop, bad status, redirect to a forbidden scheme", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/loop") return void res.writeHead(302, { Location: "/loop" }).end();
      if (req.url === "/file") return void res.writeHead(302, { Location: "file:///etc/passwd" }).end();
      res.writeHead(404).end("nope");
    },
    async (base) => {
      await assert.rejects(fetchLimited(base + "/loop", local), reasonOf("redirects"));
      await assert.rejects(fetchLimited(base + "/missing", local), reasonOf("status"));
      await assert.rejects(fetchLimited(base + "/file", local), reasonOf("blocked"));
    },
  );
});

test("fetchLimited: size limits (declared, streamed, and decompressed)", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/declared") return void res.writeHead(200, { "Content-Length": "999999" }).end("x");
      if (req.url === "/stream") {
        res.writeHead(200);
        for (let i = 0; i < 50; i++) res.write("y".repeat(100));
        return void res.end();
      }
      // 5 MB of zeros compresses to a few KB: the limit must apply after decompression
      res.writeHead(200, { "Content-Encoding": "gzip" }).end(zlib.gzipSync(Buffer.alloc(5_000_000)));
    },
    async (base) => {
      for (const p of ["/declared", "/stream", "/bomb"]) {
        await assert.rejects(fetchLimited(base + p, local), reasonOf("too_large"), p);
      }
    },
  );
});

test("fetchLimited: a server that never answers times out", async () => {
  await withServer(
    () => {},
    async (base) => {
      const t0 = Date.now();
      await assert.rejects(fetchLimited(base, { ...local, timeoutMs: 250 }), reasonOf("timeout"));
      assert.ok(Date.now() - t0 < 3000);
    },
  );
});

test("fetchLimited: a response that stalls mid-body times out too", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.write("start"); // and never ends
    },
    async (base) => {
      await assert.rejects(fetchLimited(base, { ...local, timeoutMs: 250 }), reasonOf("timeout"));
    },
  );
});
