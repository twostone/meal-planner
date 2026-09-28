// Social-media links carry the whole caption as og:title. Instagram, for example, sends
// `Name auf Instagram: "<caption, often with ingredients, steps and 20 hashtags>"`.
// This turns such a caption into a few short title candidates. Plain rules, no network, no guessing:
// where nothing sensible can be derived, fewer candidates come back (possibly none).

// The word before "Instagram" follows the request language (the app asks for German), not the caption's.
const PREFIX = /^[^\r\n]{1,120}? (?:auf|on) Instagram: /;
const QUOTES_AT_EDGES = /^["„“”]+|["“”]+$/g;
// Extended_Pictographic, not Emoji: the latter also matches digits and "#".
const EMOJI = /[\p{Extended_Pictographic}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}]/gu;
const HASHTAG = /#\S+/g; // \S, not \w: tags may end in combining marks
const EDGE_DECORATION = /^[\s\-–—•·:|]+|[\s\-–—•·:|]+$/g;
const LINK = /https?:\/\/[^\s"”„“]+/;
const LINK_ONLY = /^https?:\/\/\S+$/;

export const MAX_SUGGESTION_LENGTH = 80;

function shorten(s: string): string {
  if (s.length <= MAX_SUGGESTION_LENGTH) return s;
  // A whole first sentence beats a cut in the middle of one.
  const sentence = /^.+?[.!?](?=\s|$)/.exec(s)?.[0];
  if (sentence && sentence.length <= MAX_SUGGESTION_LENGTH) return sentence;
  return `${s.slice(0, MAX_SUGGESTION_LENGTH).replace(/\s+\S*$/, "")}…`;
}

// First line that still says something once emojis, hashtags and decoration are gone.
function firstLine(body: string): string | null {
  for (const line of body.split(/[\r\n]+/)) {
    const clean = line.replace(EMOJI, "").replace(HASHTAG, " ").replace(/\s+/g, " ").replace(EDGE_DECORATION, "");
    if (/\p{L}/u.test(clean) && !LINK_ONLY.test(clean)) return shorten(clean);
  }
  return null;
}

// A recipe link in the caption often ends in the dish name: .../italian-sausage-gnocchi-soup/
// Only words made of letters count, at least three of them, so ids and short links give nothing.
function linkSlug(text: string): string | null {
  const found = LINK.exec(text)?.[0];
  if (!found) return null;
  let last: string | undefined;
  try {
    last = new URL(found.replace(/[).,;!?]+$/, "")).pathname.split("/").filter(Boolean).pop();
  } catch {
    return null;
  }
  const words = (last ?? "").replace(/\.\w{2,5}$/, "").split("-").filter(Boolean);
  if (words.length < 3 || !words.every((w) => /^\p{L}+$/u.test(w))) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// `raw` must keep its line breaks. Returns 0-2 candidates, best first; the caller adds the original title.
export function suggestTitles(raw: string): string[] {
  const text = raw.trim();
  // Only captions: an Instagram prefix or several lines. Ordinary page titles stay untouched.
  if (!PREFIX.test(text) && !/[\r\n]/.test(text)) return [];
  const body = text.replace(PREFIX, "").replace(QUOTES_AT_EDGES, "");
  const out: string[] = [];
  for (const candidate of [firstLine(body), linkSlug(body)]) {
    if (candidate && !out.some((x) => x.toLowerCase() === candidate.toLowerCase())) out.push(candidate);
  }
  return out;
}
