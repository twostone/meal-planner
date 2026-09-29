// Read-only Lovelace card for the Meal Planner integration. Renders the attributes (start_date,
// end_date, entries[]) of sensor.meal_planner_current_list and, below it, sensor.meal_planner_next_list.
// No write-back to the add-on: this integration only ever reads its state, it never writes back
// (see the add-on's AGENTS.md) — so there is nothing here to click that changes anything. Intentionally no images: entry.image is only a filename the add-on serves behind its
// Ingress-only API, which this card (served from HA core's own frontend) cannot reach without a
// Supervisor-side ingress session this integration has no access to. Title/note/tags/done only.

class MealPlannerCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = {
      entity: "sensor.meal_planner_current_list",
      next_entity: "sensor.meal_planner_next_list",
      ...config,
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _render() {
    const state = this._hass.states[this._config.entity];
    if (!this._root) {
      this.attachShadow({ mode: "open" });
      this._root = this.shadowRoot;
      this._root.innerHTML = `
        <style>
          ha-card { padding: 16px; }
          h2 { margin: 0 0 4px; font-size: 1.1em; }
          .range { color: var(--secondary-text-color); font-size: 0.9em; margin-bottom: 12px; }
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
    const { start_date, end_date, entries } = state.attributes;
    let html = `<h2>Essensplanung</h2>`;
    if (!start_date) {
      html += `<div class="empty">Keine aktuelle Liste.</div>`;
    } else {
      const list = Array.isArray(entries) ? entries : [];
      const open = list.filter((e) => !e.done);
      const done = list.filter((e) => e.done);
      html += `<div class="range">${escapeHtml(start_date)} – ${escapeHtml(end_date)}</div>`;
      if (!list.length) html += `<div class="empty">Noch keine Gerichte.</div>`;
      if (open.length) html += `<div class="group-title">Offen</div>${renderList(open)}`;
      if (done.length) html += `<div class="group-title">Gekocht</div>${renderList(done)}`;
    }
    // The next list is optional: hidden when its entity is missing or there is none.
    const next = this._hass.states[this._config.next_entity];
    if (next && next.attributes.start_date) {
      const { start_date: ns, end_date: ne, entries: nextEntries } = next.attributes;
      html += `<div class="group-title">Nächste Liste · ${escapeHtml(ns)} – ${escapeHtml(ne)}</div>`;
      html += Array.isArray(nextEntries) && nextEntries.length
        ? renderList(nextEntries)
        : `<div class="empty">Noch keine Gerichte.</div>`;
    }
    content.innerHTML = html;
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

window.customCards = window.customCards || [];
window.customCards.push({
  type: "meal-planner-card",
  name: "Meal Planner",
  description: "Zeigt die aktuelle und die nächste Essensplanungs-Liste an (nur Anzeige, keine Bearbeitung).",
});
