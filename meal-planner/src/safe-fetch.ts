import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { pipeline, type Readable, type Transform } from "node:stream";
import zlib from "node:zlib";
import { assertAllowedUrl, FetchError, isPublicIp } from "./net-guard.ts";

export { FetchError };

export type Fetched = { url: URL; contentType: string; charset: string | null; body: Buffer };
export type FetchOptions = {
  maxBytes: number; // limit for the body after decompression
  accept: string;
  timeoutMs?: number; // whole request including redirects
  maxRedirects?: number;
  allowPrivate?: boolean; // tests only: lets the test server on 127.0.0.1 through
};

const USER_AGENT = "Mozilla/5.0 (compatible; EssensplanungBot/1.0)";

// Resolves the name and keeps only public addresses. This runs when the socket connects, so a DNS
// answer that changes between "check" and "connect" (rebinding) cannot smuggle in a private address.
export function guardedLookup(hostname: string, options: unknown, callback: (...args: unknown[]) => void): void {
  const opts: dns.LookupOptions =
    typeof options === "object" && options !== null ? (options as dns.LookupOptions) : { family: Number(options) || 0 };
  dns.lookup(hostname, { family: opts.family, hints: opts.hints, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => isPublicIp(a.address));
    const first = allowed[0];
    if (!first) return callback(new FetchError("blocked", "address"));
    if (opts.all) callback(null, allowed);
    else callback(null, first.address, first.family);
  });
}

function open(url: URL, o: FetchOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        agent: false, // no connection reuse
        signal,
        lookup: o.allowPrivate ? undefined : (guardedLookup as never),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: o.accept,
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

async function readBody(res: http.IncomingMessage, max: number): Promise<Buffer> {
  const encoding = String(res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  let decoder: Transform | null = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = zlib.createGunzip();
  else if (encoding === "deflate") decoder = zlib.createInflate();
  else if (encoding === "br") decoder = zlib.createBrotliDecompress();
  else if (encoding !== "identity" && encoding !== "") {
    res.destroy();
    throw new FetchError("type", "encoding");
  }
  let stream: Readable = res;
  if (decoder) {
    pipeline(res, decoder, () => {}); // destroys the decoder if the response fails, so the loop below ends
    stream = decoder;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > max) {
      res.destroy();
      throw new FetchError("too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toFetchError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  const err = e as { name?: string; code?: string; cause?: unknown } | null;
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return new FetchError("timeout");
  if (err?.code === "ERR_INVALID_URL") return new FetchError("blocked", "invalid url");
  if (err?.cause instanceof FetchError) return err.cause;
  return new FetchError("network", err?.code ?? "error");
}

// GET with SSRF protection and hard limits (time, size, redirects). Every redirect target goes through
// the same checks as the first URL.
export async function fetchLimited(input: string | URL, o: FetchOptions): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
  try {
    let url = new URL(input);
    for (let hop = 0; hop <= (o.maxRedirects ?? 4); hop++) {
      assertAllowedUrl(url, o.allowPrivate);
      const res = await open(url, o, ctl.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        url = new URL(location, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new FetchError("status", String(status));
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        throw new FetchError("too_large");
      }
      const body = await readBody(res, o.maxBytes);
      const [type = "", ...params] = String(res.headers["content-type"] ?? "").split(";");
      const charset =
        params
          .map((p) => p.trim())
          .find((p) => /^charset=/i.test(p))
          ?.slice("charset=".length)
          .replace(/["']/g, "") ?? null;
      return { url, contentType: type.trim().toLowerCase(), charset, body };
    }
    throw new FetchError("redirects");
  } catch (e) {
    // Once the deadline has fired, whatever error the aborted socket reports (AbortError, ECONNRESET, ...) means "too slow".
    if (ctl.signal.aborted && !(e instanceof FetchError)) throw new FetchError("timeout");
    throw toFetchError(e);
  } finally {
    clearTimeout(timer);
  }
}
