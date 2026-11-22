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

// Case-insensitive equality for tags (the server treats "snack" and "Snack" as the same tag).
export const sameTag = (a: string, b: string) => a.toLocaleLowerCase("de") === b.toLocaleLowerCase("de");

// Groups names under their first letter for an A-Z list, sorted as in German. Umlauts and other accents count as their
// base letter ("Öl" under O, as in a dictionary), anything else that is no letter as "#". localeCompare sorts "Öl"
// between "Obst" and "Orange", so grouping by the raw first character gave O, Ö, O: a duplicate key that makes Svelte's
// keyed {#each} throw in production and leaves the list empty. The map keeps every letter once whatever the order.
export function groupByInitial<T>(items: T[], name: (item: T) => string): { letter: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => name(a).localeCompare(name(b), "de"))) {
    const letter = initial(name(item));
    const group = groups.get(letter);
    if (group) group.push(item);
    else groups.set(letter, [item]);
  }
  return [...groups].map(([letter, grouped]) => ({ letter, items: grouped }));
}

const NOT_A_LETTER = "#";
function initial(name: string): string {
  const first = name.trim().charAt(0).normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase("de");
  return /\p{L}/u.test(first) ? first : NOT_A_LETTER;
}
