import type { RawDraft } from "./recipe-draft.ts";
import { UNITS } from "./repo.ts";
import { FOREIGN_UNITS } from "./units.ts";
import { logger } from "./log.ts";
import { errorBody, isAbort, request, SUPERVISOR_CORE_URL } from "./ha-core.ts";
import { clip, toJson } from "./text.ts";

const log = logger("ha-ai");

const STATUS_TIMEOUT_MS = 5000;
export const GENERATE_TIMEOUT_MS = 30_000;
// Title suggestions are a convenience next to the preview, so they get less time than a recipe draft.
export const TITLES_TIMEOUT_MS = 15_000;

export type AiStatus = { ai: boolean; reason: "disabled" | "no_entity" | "unreachable" | null };
export class AiError extends Error {
  constructor(public reason: "disabled" | "timeout" | "unreachable" | "bad_response") {
    super(reason);
  }
}
export type RecipeAi = {
  status(): Promise<AiStatus>;
  // `knownNames`: ingredient names already in use, so the model reuses them (most frequent first).
  generate(text: string, knownNames: string[]): Promise<RawDraft>;
  // The model's raw `titles` field (clean it with cleanAiTitles). `lang` is a validated language code like "de" or "en-GB".
  titles(input: { title: string; text: string; lang: string }): Promise<unknown>;
};

export const DEFAULT_LANGUAGE = "Deutsch";
// "en-GB" -> "Englisch". Only this name ever reaches the prompt, never the code from the client. Unknown -> German.
export function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(["de"], { type: "language", fallback: "none" }).of(lang) ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export const PROMPT = `Zerlege das folgende Rezept (meist eine Instagram-Caption) in strukturierte Daten.
Regeln:
- Nur übernehmen, was im Text steht. Nichts erfinden, nichts ergänzen.
- servings nur, wenn eine Portionszahl im Text steht. servings_quote ist dann die exakte Textstelle, sonst beides leer.
- Einheit nur aus dieser Liste: ${[...UNITS, ...FOREIGN_UNITS].join(", ")}.
  Englische Einheiten (cup, tbsp, tsp, oz, fl oz, lb) unverändert angeben, nicht selbst umrechnen.
  Gezählte Dinge ohne Einheit ("1 Zwiebel"): unit = null. Passt sonst keine Einheit, unit = null und den Rest in note.
- Zahlwörter in Zahlen umwandeln ("Eine Zehe" -> 1). Spannen ("1-2") als amount und amount_max.
- name: die Zutat in der Grundform Singular auf Deutsch, ohne Sorte und ohne Zubereitung.
  Sorte, Farbe oder was beim Einkauf zählt (rot, TK, Macadamia, Bio) gehört in note.
  Zubereitung (gewürfelt, zimmerwarm, in Ringen, fein gehackt) gehört in prep.
  Beispiel: "2 rote Zwiebeln, gewürfelt" -> name "Zwiebel", note "rot", prep "gewürfelt".
- Ignorieren: Hashtags (auch ohne #), Emojis, Werbung, Nährwerte, Hinweise zum Video.
- ingredients ist ein JSON-Array von Objekten
  {"section": string|null, "amount": number|null, "amount_max": number|null,
   "unit": string|null, "name": string, "note": string|null, "prep": string|null, "raw": string}.
  "raw" ist die Originalzeile unverändert, "section" die Zwischenüberschrift unverändert.
  Jede Zutatenzeile übernehmen, auch "Salz & Pfeffer".
- instructions: ein Schritt pro Zeile, Wortlaut möglichst erhalten. Lücken nicht füllen.`;

// How many known ingredient names go into the prompt, and how long that list may get at most.
export const MAX_KNOWN_NAMES = 300;
const MAX_KNOWN_NAMES_CHARS = 6000;

// The names already in the catalog, so "Zwiebeln" and "Zwiebel" do not both end up there. Empty -> nothing.
export function knownNamesPrompt(names: string[]): string {
  const list = clip(names.slice(0, MAX_KNOWN_NAMES).join(", "), MAX_KNOWN_NAMES_CHARS);
  return list ? `\n\nBereits verwendete Namen. Wiederverwenden, wenn dieselbe Zutat gemeint ist:\n${list}` : "";
}

export const titlesPrompt = (language: string) => `Nenne genau 2 kurze Titel für das folgende Gericht, einen pro Zeile.
Regeln:
- Nur der Name des Gerichts, höchstens 6 Wörter. Kein Satz, keine Werbung, keine Aufmerksamkeitsfänger ("Das beste …", "Musst du probieren").
- Keine Emojis, Hashtags, Anführungszeichen oder Nummerierung.
- Nur Gerichte benennen, die im Text vorkommen. Nichts erfinden.
- Der zweite Titel ist eine andere sinnvolle Benennung (z. B. mit der Hauptzutat), nicht derselbe Titel in anderen Worten.
- Sprache der Titel: ${language}.`;

const TITLES_STRUCTURE = {
  titles: { description: "Genau 2 Titel, einer pro Zeile", required: true, selector: { text: {} } },
};

// Output fields of the ai_task. Ingredients are a JSON array as text: nested structures are not needed.
const STRUCTURE = {
  servings: { description: "Anzahl Portionen, nur wenn im Text genannt", required: false, selector: { number: {} } },
  servings_quote: { description: "Exakte Textstelle der Portionsangabe", required: false, selector: { text: {} } },
  ingredients: { description: "JSON-Array der Zutaten", required: true, selector: { text: {} } },
  instructions: { description: "Zubereitungsschritte, ein Schritt pro Zeile", required: false, selector: { text: {} } },
};

// Talks to Home Assistant's AI task (ai_task.generate_data) through the Supervisor's Core proxy (see ha-core.ts
// for why this is plain fetch). The recipe text goes to the LLM service configured in
// Home Assistant (possibly a cloud service). `token` null (dev, tests) -> disabled. `baseUrl` is for tests.
export function createHaAi(
  token: string | null,
  baseUrl = SUPERVISOR_CORE_URL,
  timeoutMs = GENERATE_TIMEOUT_MS,
  titlesTimeoutMs = TITLES_TIMEOUT_MS,
): RecipeAi {
  // One ai_task call. Errors become AiError reasons; the answer is `service_response.data` (documented by the
  // plan's test), tolerating a layer keyed by the entity id.
  async function run(taskName: string, instructions: string, structure: object, timeout: number): Promise<Record<string, unknown>> {
    if (!token) throw new AiError("disabled");
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    let res: Response;
    try {
      res = await request(
        "services/ai_task/generate_data?return_response",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No entity_id: Home Assistant uses the preferred AI task entity. The model gets no tools.
          // toJson, not JSON.stringify: Home Assistant answers 400 to a lone surrogate (see text.ts).
          body: toJson({ task_name: taskName, instructions, structure }),
        },
        token,
        baseUrl,
        timeout,
      );
    } catch (e) {
      if (isAbort(e)) {
        log.warn("task_timeout", { task: taskName, ms: ms(), limit_ms: timeout });
        throw new AiError("timeout");
      }
      log.error("task_unreachable", { task: taskName, ms: ms(), err: e });
      throw new AiError("unreachable");
    }
    if (!res.ok) {
      log.error("task_failed", { task: taskName, status: res.status, ms: ms(), body: await errorBody(res) });
      throw new AiError("unreachable");
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      log.warn("task_bad_response", { task: taskName, ms: ms(), why: "not_json" });
      throw new AiError("bad_response");
    }
    const sr = body?.service_response;
    const data = sr?.data ?? Object.values(sr ?? {}).map((v: any) => v?.data).find((d) => d && typeof d === "object");
    if (!data || typeof data !== "object") {
      log.warn("task_bad_response", { task: taskName, ms: ms(), why: "no_data" });
      throw new AiError("bad_response");
    }
    log.info("task_done", { task: taskName, ms: ms() });
    return data as Record<string, unknown>;
  }

  return {
    async status() {
      if (!token) return { ai: false, reason: "disabled" };
      try {
        const res = await request("states", { method: "GET" }, token, baseUrl, STATUS_TIMEOUT_MS);
        if (!res.ok) {
          log.warn("status_check_failed", { status: res.status, body: await errorBody(res) });
          return { ai: false, reason: "unreachable" };
        }
        const states = (await res.json()) as { entity_id?: unknown; state?: unknown }[];
        const has = Array.isArray(states) && states.some((s) => typeof s.entity_id === "string" && s.entity_id.startsWith("ai_task.") && s.state !== "unavailable");
        return has ? { ai: true, reason: null } : { ai: false, reason: "no_entity" };
      } catch (e) {
        log.warn("status_check_failed", { err: e });
        return { ai: false, reason: "unreachable" };
      }
    },

    async generate(text, knownNames) {
      return (await run("meal_planner_recipe", `${PROMPT}${knownNamesPrompt(knownNames)}\n\nText:\n${text}`, STRUCTURE, timeoutMs)) as RawDraft;
    },

    async titles({ title, text, lang }) {
      const instructions = `${titlesPrompt(languageName(lang))}\n\nTitel der Seite:\n${title}\n\nText:\n${text}`;
      return (await run("meal_planner_title", instructions, TITLES_STRUCTURE, titlesTimeoutMs)).titles;
    },
  };
}
