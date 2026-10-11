// Strings are UTF-16 in JavaScript. A plain `.slice` can cut between the two halves of a character outside the
// BMP (emoji, bold math letters like 𝗕) and leave a lone surrogate. JSON.stringify writes that as "\ud83d", which
// Node accepts but Home Assistant's JSON parser (orjson) rejects: the call fails with 400 "Data should be valid JSON".

// `.slice(0, max)` that never leaves half a character at the end. At most `max` UTF-16 units, so the zod limits
// (which count units too) still hold.
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// JSON.stringify for everything that leaves for Home Assistant. Lone surrogates become U+FFFD *before* serializing:
// afterwards they are only the ASCII text "\ud83d" and can no longer be told apart.
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "string" ? v.toWellFormed() : v));
}
