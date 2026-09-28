import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SUGGESTION_LENGTH, suggestTitles } from "../src/title-suggest.ts";

// Shaped like real Instagram og:title values (checked against three real reels): account prefix, dish name
// on the first line wrapped in emojis, ingredients and steps, hashtags at the end. Names and texts are invented.
const dishFirst = [
  'Alex 🍓🏋🏼‍♀️✨ auf Instagram: "💛🥦 High-Protein Brokkoli Pasta mit Hähnchen 💛',
  "",
  "Zutaten (für 2 Portionen):",
  "• 160 g Nudeln",
  "",
  "# Optional für mehr Protein:",
  "Einfach Protein einrühren. 🙂‍↕️✨💛",
  "",
  "#proteinrezepte #highprotein",
  '#viralerezepte"',
].join("\n");

// Real captions mix \r\n and \n.
const crlf = 'Sam Beispiel auf Instagram: "Schnelles Rotes Curry\r\n\r\nDie Paste ist mild.\n\r\n2-3 Portionen\r\n1 EL Öl"';

// Hook instead of a dish name; the dish only shows up in the recipe link. The hashtag ends in a combining mark.
const hook = [
  'Kim Example auf Instagram: "The coziest soup you’ll make all season! Still my favorite soup to make every year! ✨',
  "",
  "Follow @kim for more and comment RECIPE!",
  "",
  "https://example.com/italian-sausage-gnocchi-soup/",
  "",
  '#soupseason #dinnerideas\u064f #gnocchisoup"',
].join("\n");

test("suggestTitles: dish name from the first line, emojis, hashtags and the account prefix gone", () => {
  assert.deepEqual(suggestTitles(dishFirst), ["High-Protein Brokkoli Pasta mit Hähnchen"]);
});

test("suggestTitles: mixed \\r\\n and \\n line breaks", () => {
  assert.deepEqual(suggestTitles(crlf), ["Schnelles Rotes Curry"]);
});

test("suggestTitles: a long hook is cut at its first sentence; the recipe link adds a second candidate", () => {
  assert.deepEqual(suggestTitles(hook), ["The coziest soup you’ll make all season!", "Italian Sausage Gnocchi Soup"]);
});

test("suggestTitles: the English prefix works too, and identical candidates are merged", () => {
  const raw = 'Kim on Instagram: "Italian Sausage Gnocchi Soup 🍲\n\nhttps://example.com/italian-sausage-gnocchi-soup/"';
  assert.deepEqual(suggestTitles(raw), ["Italian Sausage Gnocchi Soup"]);
});

test("suggestTitles: ordinary titles are left alone", () => {
  for (const t of ["Käsespätzle", "Käsespätzle 🧀 Rezept | Chefkoch", ""]) assert.deepEqual(suggestTitles(t), [], t);
});

test("suggestTitles: nothing usable in the caption gives no candidates", () => {
  assert.deepEqual(suggestTitles('Kim auf Instagram: "🍲✨💛\n\n#soup #dinner"'), []);
  assert.deepEqual(suggestTitles('Kim auf Instagram: ""'), []);
  // a first line that is only a link is skipped, the next real line wins
  assert.deepEqual(suggestTitles('Kim auf Instagram: "https://example.com/x\nLinsensuppe"'), ["Linsensuppe"]);
});

test("suggestTitles: a long first line without a short first sentence is cut at a word boundary", () => {
  const long = "Sehr lange Überschrift ohne jedes Satzzeichen die einfach weitergeht und weitergeht und weitergeht bis zum Ende";
  const [t] = suggestTitles(`Kim auf Instagram: "${long}\nZeile zwei"`);
  assert.ok(t!.endsWith("…"));
  assert.ok(t!.length <= MAX_SUGGESTION_LENGTH + 1);
  assert.ok(long.startsWith(t!.slice(0, -1)), "a prefix of the original, no half words");
  assert.ok(!/\s…$/.test(t!));
});

test("suggestTitles: link slugs need three words made of letters, so ids and short links give nothing", () => {
  const withLink = (u: string) => suggestTitles(`Kim auf Instagram: "\n\n${u}\n"`);
  assert.deepEqual(withLink("https://example.com/gruene-sosse-mit-eiern.html"), ["Gruene Sosse Mit Eiern"]);
  for (const u of ["https://bit.ly/3xYz", "https://linktr.ee/kim", "https://example.com/rezept-123-abc", "https://example.com/zwei-woerter", "https://example.com/"]) {
    assert.deepEqual(withLink(u), [], u);
  }
});
