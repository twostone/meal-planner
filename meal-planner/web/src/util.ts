export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

// Splits a title around the first case-insensitive match of q, for bold highlighting.
export function matchParts(title: string, q: string): [string, string, string] {
  const i = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [title, "", ""] : [title.slice(0, i), title.slice(i, i + q.length), title.slice(i + q.length)];
}
