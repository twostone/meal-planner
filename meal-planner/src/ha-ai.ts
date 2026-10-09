import type { RawDraft } from "./recipe-draft.ts";
import { UNITS } from "./repo.ts";

export const SUPERVISOR_CORE_URL = "http://supervisor/core/api/";
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
  generate(text: string): Promise<RawDraft>;
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
- Einheit nur aus dieser Liste: ${UNITS.join(", ")}.
  Gezählte Dinge ohne Einheit ("1 Zwiebel"): unit = null. Passt sonst keine Einheit, unit = null und den Rest in note.
- Zahlwörter in Zahlen umwandeln ("Eine Zehe" -> 1). Spannen ("1-2") als amount und amount_max.
- Ignorieren: Hashtags (auch ohne #), Emojis, Werbung, Nährwerte, Hinweise zum Video.
- ingredients ist ein JSON-Array von Objekten
  {"section": string|null, "amount": number|null, "amount_max": number|null,
   "unit": string|null, "name": string, "note": string|null, "raw": string}.
  "raw" ist die Originalzeile unverändert, "section" die Zwischenüberschrift unverändert.
  Jede Zutatenzeile übernehmen, auch "Salz & Pfeffer".
- instructions: ein Schritt pro Zeile, Wortlaut möglichst erhalten. Lücken nicht füllen.`;

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

// Talks to Home Assistant's AI task (ai_task.generate_data) through the Supervisor's Core proxy
// (needs `homeassistant_api: true`). Like ha-notify.ts, deliberately plain fetch and not fetchLimited: the
// target is fixed in code and never user input. The recipe text goes to the LLM service configured in
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
    let res: Response;
    try {
      res = await request(
        "services/ai_task/generate_data?return_response",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No entity_id: Home Assistant uses the preferred AI task entity. The model gets no tools.
          body: JSON.stringify({ task_name: taskName, instructions, structure }),
        },
        token,
        baseUrl,
        timeout,
      );
    } catch (e) {
      throw new AiError(e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable");
    }
    if (!res.ok) {
      console.error(`[ha-ai] ${taskName} failed: supervisor responded ${res.status}`);
      throw new AiError("unreachable");
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new AiError("bad_response");
    }
    const sr = body?.service_response;
    const data = sr?.data ?? Object.values(sr ?? {}).map((v: any) => v?.data).find((d) => d && typeof d === "object");
    if (!data || typeof data !== "object") throw new AiError("bad_response");
    return data as Record<string, unknown>;
  }

  return {
    async status() {
      if (!token) return { ai: false, reason: "disabled" };
      try {
        const res = await request("states", { method: "GET" }, token, baseUrl, STATUS_TIMEOUT_MS);
        if (!res.ok) {
          console.error(`[ha-ai] status check failed: supervisor responded ${res.status}`);
          return { ai: false, reason: "unreachable" };
        }
        const states = (await res.json()) as { entity_id?: unknown; state?: unknown }[];
        const has = Array.isArray(states) && states.some((s) => typeof s.entity_id === "string" && s.entity_id.startsWith("ai_task.") && s.state !== "unavailable");
        return has ? { ai: true, reason: null } : { ai: false, reason: "no_entity" };
      } catch (e) {
        console.error("[ha-ai] status check failed:", e instanceof Error ? e.message : e);
        return { ai: false, reason: "unreachable" };
      }
    },

    async generate(text) {
      return (await run("meal_planner_recipe", `${PROMPT}\n\nText:\n${text}`, STRUCTURE, timeoutMs)) as RawDraft;
    },

    async titles({ title, text, lang }) {
      const instructions = `${titlesPrompt(languageName(lang))}\n\nTitel der Seite:\n${title}\n\nText:\n${text}`;
      return (await run("meal_planner_title", instructions, TITLES_STRUCTURE, titlesTimeoutMs)).titles;
    },
  };
}

async function request(path: string, init: RequestInit, token: string, baseUrl: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}
