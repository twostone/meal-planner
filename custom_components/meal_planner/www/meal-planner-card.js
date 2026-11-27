// Read-only Lovelace card for the Meal Planner integration. Renders the attributes (title, start_date,
// end_date, entries[]) of sensor.meal_planner_current_list and, below it, sensor.meal_planner_next_list.
// No write-back to the add-on: this integration only ever reads its state, it never writes back
// (see the add-on's AGENTS.md) — so nothing clickable here changes anything (the optional `app_url` is a plain link). Intentionally no images: entry.image is only a filename the add-on serves behind its
// Ingress-only API, which this card (served from HA core's own frontend) cannot reach without a
// Supervisor-side ingress session this integration has no access to. Title/note/tags/done only.

class MealPlannerCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = {
      entity: "sensor.meal_planner_current_list",
      next_entity: "sensor.meal_planner_next_list",
      title: "Essensplanung",
      show_next: true,
      show_done: true,
      compact: false,
      ...config,
    };
    if (this._root) this._render();
  }

  static getConfigElement() {
    return document.createElement("meal-planner-card-editor");
  }

  // Used by the card picker's preview. Without the integration's sensors (e.g. before setup)
  // `demo` renders sample data instead of an error, so the preview is never empty.
  static getStubConfig(hass) {
    const config = { entity: "sensor.meal_planner_current_list" };
    if (!hass?.states?.[config.entity]) config.demo = true;
    return config;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return this._config?.compact ? 2 : 5;
  }

  _render() {
    if (!this._hass) return;
    // `demo` may end up saved in the config (added from the picker before the sensors existed), so it
    // only applies while the entity is actually missing; real data always wins.
    const live = this._hass.states[this._config.entity];
    const demo = this._config.demo && !live;
    const state = demo ? DEMO.current : live;
    if (!this._root) {
      this.attachShadow({ mode: "open" });
      this._root = this.shadowRoot;
      this._root.innerHTML = `<style>${STYLE}</style><ha-card><div class="content"></div></ha-card>`;
    }

    const content = this._root.querySelector(".content");
    if (!state) {
      content.innerHTML = `<div class="empty">Entität ${escapeHtml(this._config.entity)} nicht gefunden.</div>`;
      return;
    }
    // Link to the add-on's UI (Ingress path): from the sensor (known through discovery), the YAML `app_url`
    // overrides it. Plain navigation, no write-back.
    const appUrl = this._config.app_url || state.attributes.app_url;
    const next = demo ? DEMO.next : this._hass.states[this._config.next_entity];
    const showNext = this._config.show_next && next?.attributes.start_date;
    content.innerHTML = this._config.compact
      ? renderCompact(state.attributes, appUrl)
      : renderFull(this._config, state.attributes, appUrl, showNext ? next.attributes : null);
  }
}

const DEMO = {
  current: {
    attributes: {
      title: "Woche 40",
      start_date: "2026-09-28",
      end_date: "2026-10-04",
      entries: [
        { title: "Spaghetti Bolognese", note: "Mit frischem Basilikum", tags: ["Pasta"], url: "https://example.com/rezept", done: false },
        { title: "Gemüsecurry", tags: ["Vegetarisch"], done: false },
        { title: "Pizza", done: true },
      ],
    },
  },
  next: {
    attributes: {
      start_date: "2026-10-05",
      end_date: "2026-10-11",
      entries: [{ title: "Linsensuppe", done: false }],
    },
  },
};

const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "entity", selector: { entity: { domain: "sensor" } } },
  { name: "next_entity", selector: { entity: { domain: "sensor" } } },
  { name: "app_url", selector: { text: {} } },
  { name: "show_next", selector: { boolean: {} } },
  { name: "show_done", selector: { boolean: {} } },
  { name: "compact", selector: { boolean: {} } },
];
const EDITOR_LABELS = {
  title: "Titel",
  entity: "Aktuelle Liste",
  next_entity: "Nächste Liste",
  app_url: "Link zur App-Oberfläche (optional, sonst automatisch)",
  show_next: "Nächste Liste anzeigen",
  show_done: "Gekochte Gerichte anzeigen",
  compact: "Kompakt (nur offene Gerichte als Chips)",
};

class MealPlannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
      this._form.addEventListener("value-changed", (ev) => {
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }),
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = {
      title: "Essensplanung",
      entity: "sensor.meal_planner_current_list",
      next_entity: "sensor.meal_planner_next_list",
      show_next: true,
      show_done: true,
      compact: false,
      ...this._config,
    };
  }
}

// Variant A: header with progress ring, open and cooked dishes, the next list as one line.
function renderFull(config, plan, appUrl, nextPlan) {
  const list = Array.isArray(plan.entries) ? plan.entries : [];
  const open = list.filter((e) => !e.done);
  const done = list.filter((e) => e.done);
  const sub = plan.start_date ? planLabel(plan) : "Keine aktuelle Liste";
  let html = header(escapeHtml(config.title), sub, plan.start_date ? ring(done.length, list.length) : "", appUrl);
  if (plan.start_date && !list.length) html += `<div class="empty">Noch keine Gerichte.</div>`;
  if (open.length) html += `<div class="group-title">Offen</div>${renderList(open)}`;
  if (done.length && config.show_done) html += `<div class="group-title">Gekocht</div>${renderList(done)}`;
  if (nextPlan) {
    const n = Array.isArray(nextPlan.entries) ? nextPlan.entries.length : 0;
    html += `<div class="next"><span>Nächste: ${planLabel(nextPlan)}</span><span>${n} ${n === 1 ? "Gericht" : "Gerichte"}</span></div>`;
  }
  return html;
}

// Variant B (`compact: true`): ring, how many are open, the open dishes as chips.
function renderCompact(plan, appUrl) {
  if (!plan.start_date) return header("Essensplanung", "Keine aktuelle Liste", "", appUrl);
  const list = Array.isArray(plan.entries) ? plan.entries : [];
  const open = list.filter((e) => !e.done);
  const title = !list.length ? "Noch keine Gerichte" : open.length ? `${open.length} ${open.length === 1 ? "Gericht" : "Gerichte"} offen` : "Alles gekocht";
  const chips = open.length ? `<div class="chips">${open.map((e) => `<span class="chip">${escapeHtml(e.title)}</span>`).join("")}</div>` : "";
  return header(title, planLabel(plan), ring(list.length - open.length, list.length), appUrl) + chips;
}

function header(title, sub, ringHtml, appUrl) {
  const appLink = appUrl ? `<a class="app" href="${escapeAttr(appUrl)}" title="Oberfläche der App öffnen">App öffnen ↗</a>` : "";
  return `<div class="header">${ringHtml}<div class="head-text"><div class="title">${title}</div><div class="sub">${sub}</div></div>${appLink}</div>`;
}

const RING_RADIUS = 18;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ring(doneCount, total) {
  const ratio = total ? doneCount / total : 0;
  return `<div class="ring" role="img" aria-label="${doneCount} von ${total} gekocht">
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="${RING_RADIUS}"></circle>
    <circle class="value" cx="22" cy="22" r="${RING_RADIUS}" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH * (1 - ratio)}"></circle></svg>
    <span>${doneCount}/${total}</span></div>`;
}

// "Woche 47 · Sa 21. Nov – Fr 27. Nov": the list's name (when it has one) before its period.
function planLabel(plan) {
  const range = `${fmtDay(plan.start_date)} – ${fmtDay(plan.end_date)}`;
  return plan.title ? `${escapeHtml(plan.title)} · ${range}` : range;
}

// Same short German date as the app ("Sa 21. Nov", meal-planner/web/src/dates.ts), so card and app read alike.
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// ISO day (YYYY-MM-DD) as a short German date; anything unexpected is shown as it came.
function fmtDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  // Non-breaking spaces: a narrow card may wrap between two dates, never inside one.
  return `${WEEKDAYS[d.getUTCDay()]}\u00a0${d.getUTCDate()}.\u00a0${MONTHS[d.getUTCMonth()]}`;
}

function renderList(items) {
  return `<ul>${items.map(renderEntry).join("")}</ul>`;
}

function renderEntry(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return `
    <li class="${entry.done ? "done" : ""}">
      <span class="dot"></span>
      <div class="body">
        <div class="name">${escapeHtml(entry.title)}</div>
        ${entry.note ? `<div class="note">${escapeHtml(entry.note)}</div>` : ""}
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      </div>
      ${entry.url ? `<a class="link" href="${escapeAttr(entry.url)}" target="_blank" rel="noopener noreferrer" title="Rezept öffnen" aria-label="Rezept öffnen">🔗</a>` : ""}
    </li>
  `;
}

// Only Home Assistant's theme variables, so the card follows every dashboard theme (light or dark).
const STYLE = `
  ha-card { padding: 16px; }
  .header { display: flex; align-items: center; gap: 12px; }
  .head-text { flex: 1; min-width: 0; }
  .title { font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); }
  .sub { color: var(--secondary-text-color); font-size: 0.9em; }
  a.app { flex: none; align-self: flex-start; color: var(--primary-color); font-size: 0.9em; text-decoration: none; }
  .ring { position: relative; flex: none; width: 44px; height: 44px; }
  .ring svg { width: 44px; height: 44px; transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 4; }
  .ring .track { stroke: var(--divider-color); }
  .ring .value { stroke: var(--primary-color); stroke-linecap: round; }
  .ring span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.75em; font-weight: 600; color: var(--primary-text-color); }
  .group-title { font-size: 0.75em; font-weight: 600; letter-spacing: 0.06em; color: var(--secondary-text-color); margin: 16px 0 4px; text-transform: uppercase; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-top: 1px solid var(--divider-color); }
  li:first-child { border-top: none; }
  .dot { flex: none; width: 14px; height: 14px; margin-top: 3px; border-radius: 50%; border: 2px solid var(--secondary-text-color); box-sizing: border-box; }
  .done .dot { background: var(--primary-color); border-color: var(--primary-color); }
  .body { min-width: 0; flex: 1; }
  .name { overflow-wrap: anywhere; color: var(--primary-text-color); }
  .done .name { text-decoration: line-through; color: var(--secondary-text-color); }
  .note { color: var(--secondary-text-color); font-size: 0.9em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .tags span { font-size: 0.75em; padding: 1px 8px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  a.link { flex: none; color: var(--secondary-text-color); text-decoration: none; margin-top: 1px; }
  .next { display: flex; justify-content: space-between; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--divider-color); color: var(--secondary-text-color); font-size: 0.9em; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .chip { font-size: 0.9em; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--divider-color); color: var(--primary-text-color); overflow-wrap: anywhere; }
  .empty { color: var(--secondary-text-color); margin-top: 12px; }
`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

if (!customElements.get("meal-planner-card")) {
  customElements.define("meal-planner-card", MealPlannerCard);
}
if (!customElements.get("meal-planner-card-editor")) {
  customElements.define("meal-planner-card-editor", MealPlannerCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "meal-planner-card",
  name: "Meal Planner",
  description: "Zeigt die aktuelle und die nächste Essensplanungs-Liste an (nur Anzeige, keine Bearbeitung).",
  preview: true,
});
