import type { ImageStore } from "./images.ts";
import { FetchError, type FetchFailure } from "./net-guard.ts";
import { fetchLimited, type Fetched } from "./safe-fetch.ts";

export type Parsed = { title: string | null; imageUrl: string | null };
export type PreviewResult = { title: string | null; image: string | null; reason: FetchFailure | "no_metadata" | null };

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  hellip: "…", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

// Titles that mean "we were sent to a login or bot-check page", not a dish name.
const GENERIC_TITLE = /^(instagram|log ?in|login\s*[•·|-]\s*instagram|anmelden|just a moment\.{0,3}|access denied|403 forbidden|attention required.*)$/i;

function cleanTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = decodeEntities(s).replace(/\s+/g, " ").trim();
  return t && !GENERIC_TITLE.test(t) ? t.slice(0, 200) : null;
}

const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrs(tag: string): Record<string, string> {
  const inner = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
  const out: Record<string, string> = {};
  for (const m of inner.matchAll(ATTR)) {
    const key = m[1]!.toLowerCase();
    if (!(key in out)) out[key] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      // malformed block, ignore
    }
  }
  return out;
}

function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
    if (types.includes("Recipe")) return o;
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) {
      const r = findRecipe(o[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function firstImage(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(firstImage).find((x) => x !== null) ?? null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return firstImage(o.url ?? o.contentUrl);
  }
  return null;
}

function stripSiteName(title: string, site: string | undefined): string {
  if (!site?.trim()) return title;
  const s = decodeEntities(site).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = decodeEntities(title)
    .replace(new RegExp(`\\s*[|–—·•:-]\\s*${s}\\s*$`, "i"), "")
    .replace(new RegExp(`^\\s*${s}\\s*[|–—·•:-]\\s*`, "i"), "")
    .trim();
  return stripped || title;
}

function resolveImage(raw: string | null | undefined, base: URL): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw).trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// Title: the schema.org recipe name is the cleanest source (no "| Site" suffix), then og:title, then <title>.
// Image: og:image first (usually a landscape photo), then the recipe image.
export function parsePreview(html: string, base: URL): Parsed {
  const meta = new Map<string, string>();
  for (const m of html.matchAll(META_TAG)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  const recipe = findRecipe(jsonLd(html));
  const recipeName = typeof recipe?.name === "string" ? recipe.name : null;
  const pageTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const site = meta.get("og:site_name");
  const fallback = meta.get("og:title") ?? meta.get("twitter:title") ?? pageTitle ?? null;

  const title = cleanTitle(recipeName) ?? cleanTitle(fallback === null ? null : stripSiteName(fallback, site));
  const imageUrl = resolveImage(
    meta.get("og:image") ??
      meta.get("og:image:secure_url") ??
      meta.get("twitter:image") ??
      meta.get("twitter:image:src") ??
      firstImage(recipe?.image),
    base,
  );
  return { title, imageUrl };
}

function decodeBody(page: Fetched): string {
  const head = page.body.toString("latin1", 0, 2048);
  const label = (page.charset ?? /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1] ?? "utf-8").trim();
  try {
    return new TextDecoder(label).decode(page.body);
  } catch {
    return new TextDecoder("utf-8").decode(page.body);
  }
}

const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8";
export const MAX_PAGE_BYTES = 1_500_000;
export const MAX_IMAGE_BYTES = 3_000_000;

type Deps = { images: ImageStore; fetcher?: typeof fetchLimited; log?: (line: string) => void };

// Never throws: a preview is a convenience, so every failure becomes { title: null, image: null, reason }.
export function createPreviewService({ images, fetcher = fetchLimited, log = console.log }: Deps) {
  return async function preview(rawUrl: string): Promise<PreviewResult> {
    const host = (() => {
      try {
        return new URL(rawUrl).hostname;
      } catch {
        return "?";
      }
    })();
    const result = await run(rawUrl);
    // Host only: full links can carry tokens.
    log(`[preview] ${host} title=${result.title ? "yes" : "no"} image=${result.image ? "yes" : "no"} reason=${result.reason ?? "-"}`);
    return result;
  };

  async function run(rawUrl: string): Promise<PreviewResult> {
    let page: Fetched;
    try {
      page = await fetcher(rawUrl, { maxBytes: MAX_PAGE_BYTES, accept: HTML_ACCEPT });
    } catch (e) {
      return { title: null, image: null, reason: e instanceof FetchError ? e.reason : "network" };
    }
    if (!/html|xml/.test(page.contentType)) return { title: null, image: null, reason: "type" };

    const parsed = parsePreview(decodeBody(page), page.url);
    let image: string | null = null;
    if (parsed.imageUrl) {
      try {
        const img = await fetcher(parsed.imageUrl, { maxBytes: MAX_IMAGE_BYTES, accept: IMAGE_ACCEPT });
        image = await images.save(img.body);
      } catch {
        // title alone is still useful
      }
    }
    return { title: parsed.title, image, reason: parsed.title || image ? null : "no_metadata" };
  }
}

export type PreviewService = ReturnType<typeof createPreviewService>;
