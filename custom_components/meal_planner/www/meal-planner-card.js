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
    return 5;
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
      this._root.innerHTML = `
        <style>
          ha-card { padding: 16px; }
          .header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 4px; }
          h2 { margin: 0; font-size: 1.1em; }
          a.app { flex: none; color: var(--primary-color); font-size: 0.9em; text-decoration: none; }
          .range { color: var(--secondary-text-color); font-size: 0.9em; margin-bottom: 12px; }
          .range b { color: var(--primary-text-color); font-weight: 500; }
          .group-title { font-size: 0.85em; color: var(--secondary-text-color); margin: 12px 0 4px; text-transform: uppercase; }
          ul { list-style: none; margin: 0; padding: 0; }
          li { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-top: 1px solid var(--divider-color); }
          li:first-child { border-top: none; }
          .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; }
          .dot.open { border: 2px solid var(--secondary-text-color); }
          .dot.done { background: var(--primary-color); }
          .body { min-width: 0; flex: 1; }
          .title { overflow-wrap: anywhere; }
          .done .title { text-decoration: line-through; color: var(--secondary-text-color); }
          .note { color: var(--secondary-text-color); font-size: 0.9em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
          .tags { color: var(--secondary-text-color); font-size: 0.85em; }
          a.link { flex: none; color: var(--secondary-text-color); text-decoration: none; margin-top: 3px; }
          .empty { color: var(--secondary-text-color); }
        </style>
        <ha-card><div class="content"></div></ha-card>
      `;
    }

    const content = this._root.querySelector(".content");
    if (!state) {
      content.innerHTML = `<div class="empty">Entität ${this._config.entity} nicht gefunden.</div>`;
      return;
    }
    // planTitle: the optional name of the list (not the card's own `title`).
    const { start_date, end_date, entries, title: planTitle } = state.attributes;
    // Link to the add-on's UI (Ingress path): from the sensor (known through discovery), the YAML `app_url`
    // overrides it. Plain navigation, no write-back.
    const appUrl = this._config.app_url || state.attributes.app_url;
    const appLink = appUrl ? `<a class="app" href="${escapeAttr(appUrl)}" title="Oberfläche der App öffnen">App öffnen ↗</a>` : "";
    let html = `<div class="header"><h2>${escapeHtml(this._config.title)}</h2>${appLink}</div>`;
    if (!start_date) {
      html += `<div class="empty">Keine aktuelle Liste.</div>`;
    } else {
      const list = Array.isArray(entries) ? entries : [];
      const open = list.filter((e) => !e.done);
      const done = list.filter((e) => e.done);
      html += `<div class="range">${planTitle ? `<b>${escapeHtml(planTitle)}</b> · ` : ""}${escapeHtml(start_date)} – ${escapeHtml(end_date)}</div>`;
      if (!list.length) html += `<div class="empty">Noch keine Gerichte.</div>`;
      if (open.length) html += `<div class="group-title">Offen</div>${renderList(open)}`;
      if (done.length && this._config.show_done) html += `<div class="group-title">Gekocht</div>${renderList(done)}`;
    }
    // The next list is optional: hidden when its entity is missing or there is none.
    const next = demo ? DEMO.next : this._hass.states[this._config.next_entity];
    if (this._config.show_next && next && next.attributes.start_date) {
      const { start_date: ns, end_date: ne, entries: nextEntries, title: nextTitle } = next.attributes;
      const name = nextTitle ? `${escapeHtml(nextTitle)} · ` : "";
      html += `<div class="group-title">Nächste Liste · ${name}${escapeHtml(ns)} – ${escapeHtml(ne)}</div>`;
      html += Array.isArray(nextEntries) && nextEntries.length
        ? renderList(nextEntries)
        : `<div class="empty">Noch keine Gerichte.</div>`;
    }
    content.innerHTML = html;
  }
}

const DEMO = {
  current: {
    attributes: {
      start_date: "2026-09-28",
      end_date: "2026-10-04",
      entries: [
        { title: "Spaghetti Bolognese", note: "Mit frischem Basilikum", tags: ["Pasta"], done: false },
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
];
const EDITOR_LABELS = {
  title: "Titel",
  entity: "Aktuelle Liste",
  next_entity: "Nächste Liste",
  app_url: "Link zur App-Oberfläche (optional, sonst automatisch)",
  show_next: "Nächste Liste anzeigen",
  show_done: "Gekochte Gerichte anzeigen",
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
      ...this._config,
    };
  }
}

function renderList(items) {
  return `<ul>${items.map(renderEntry).join("")}</ul>`;
}

function renderEntry(entry) {
  const tags = Array.isArray(entry.tags) && entry.tags.length ? escapeHtml(entry.tags.join(" · ")) : "";
  return `
    <li class="${entry.done ? "done" : ""}">
      <span class="dot ${entry.done ? "done" : "open"}"></span>
      <div class="body">
        <div class="title">${escapeHtml(entry.title)}</div>
        ${entry.note ? `<div class="note">${escapeHtml(entry.note)}</div>` : ""}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </div>
      ${entry.url ? `<a class="link" href="${escapeAttr(entry.url)}" target="_blank" rel="noopener noreferrer" title="Rezept öffnen">🔗</a>` : ""}
    </li>
  `;
}

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
