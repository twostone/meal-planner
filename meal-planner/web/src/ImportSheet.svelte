<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import * as api from "./api";
  import Sheet from "./Sheet.svelte";
  import { app, closeSheet, reloadDishes, showError, showInfo } from "./store.svelte";
  import type { ImportAction, ImportPreview } from "./types";

  let { file }: { file: unknown } = $props();

  type Choice = "skip" | "replace" | "new";
  // title: the one to create the dish under (editable); fileTitle: as it stands in the file.
  type Row = ImportPreview["dishes"][number] & { choice: Choice; fileTitle: string; error: string | null };

  let rows = $state<Row[] | null>(null);
  let withTags = $state(true);
  let confirming = $state(false);
  let busy = $state(false);
  // Fetching pictures after the import: how far it got. Stops when the sheet closes (the dishes are saved already).
  let images = $state<{ done: number; total: number } | null>(null);
  let closed = false;
  onDestroy(() => (closed = true));

  const keyOf = (t: string) => t.trim().toLocaleLowerCase("de");

  // "<title> (n)" with the lowest n from 2 that neither the catalog nor another row of this file uses.
  function freeTitle(title: string, taken: Set<string>): string {
    for (let n = 2; ; n++) {
      const candidate = `${title} (${n})`;
      if (!taken.has(keyOf(candidate))) return candidate;
    }
  }

  onMount(async () => {
    try {
      const preview = await api.previewImport(file);
      const taken = new Set([...app.dishes.map((d) => keyOf(d.title)), ...preview.dishes.map((d) => keyOf(d.title))]);
      rows = preview.dishes.map((d) => {
        // A match keeps its title only for "skip"/"replace"; a taken title (other recipe, other link) needs another one.
        const title = d.exists || d.title_taken ? freeTitle(d.title, taken) : d.title;
        taken.add(keyOf(title));
        return { ...d, choice: d.exists ? "skip" : "new", title, fileTitle: d.title, error: null };
      });
    } catch (e) {
      showError(e);
      closeSheet();
    }
  });

  const chosen = $derived(rows?.filter((r) => r.choice !== "skip") ?? []);
  const replacing = $derived(chosen.some((r) => r.choice === "replace"));

  function edit() {
    confirming = false;
  }

  async function run() {
    if (!rows || busy || chosen.length === 0) return;
    if (replacing && !confirming) {
      confirming = true;
      return;
    }
    busy = true;
    for (const r of rows) r.error = null;
    const actions: ImportAction[] = chosen.map((r) =>
      r.choice === "replace" ? { index: r.index, action: "replace" } : { index: r.index, action: "new", title: r.title.trim() },
    );
    try {
      const result = await api.importDishes(file, withTags, actions);
      await reloadDishes();
      showInfo(result.created + result.replaced === 1 ? "1 Gericht importiert" : `${result.created + result.replaced} Gerichte importiert`);
      await fetchImages(result.needs_image);
    } catch (e) {
      // A taken title: mark the rows whose title already exists in the catalog, the sheet stays open.
      const known = new Set(app.dishes.map((d) => keyOf(d.title)));
      const clashes = chosen.filter((r) => r.choice === "new" && known.has(keyOf(r.title)));
      for (const r of clashes) r.error = "Diesen Titel gibt es schon.";
      showError(e);
      busy = false;
      confirming = false;
    }
  }

  // One after another through the link preview (it stores the picture), then onto the dish. Failures are skipped:
  // many pages give no picture, and the dish can still get one later in its sheet.
  async function fetchImages(todo: { id: number; url: string }[]) {
    if (todo.length === 0) return closeSheet();
    images = { done: 0, total: todo.length };
    let found = 0;
    for (const { id, url } of todo) {
      if (closed) return;
      try {
        const p = await api.previewUrl(url);
        const dish = app.dishes.find((d) => d.id === id);
        if (p.image && dish && !closed) {
          await api.updateDish(id, { ...dish, image: p.image });
          found++;
        }
      } catch {
        // skipped on purpose, see above
      }
      images.done++;
    }
    if (closed) return;
    await reloadDishes();
    closeSheet();
    showInfo(found === 1 ? "1 Bild geholt" : `${found} Bilder geholt`);
  }
</script>

<Sheet title="Gerichte importieren">
  {#if !rows}
    <p class="empty">Lade …</p>
  {:else if images}
    <p class="empty" aria-live="polite">Bilder von den Links holen … {images.done}/{images.total}</p>
    <p class="field-hint">Die Gerichte sind schon gespeichert. Schließen bricht nur das Holen der Bilder ab.</p>
  {:else}
    <ul class="import-rows">
      {#each rows as r (r.index)}
        <li class="import-row">
          {#if r.exists}
            <div class="import-head">
              <strong>{r.exists.title}</strong>
              <small>
                {keyOf(r.exists.title) === keyOf(r.fileTitle) ? "Gibt es schon" : `Gibt es schon als „${r.exists.title}“ (gleicher Link)`}
                · {r.ingredients === 1 ? "1 Zutat" : `${r.ingredients} Zutaten`}
              </small>
            </div>
            <label class="import-choice">
              <span class="visually-hidden">Was tun mit {r.exists.title}?</span>
              <select bind:value={r.choice} onchange={edit}>
                <option value="skip">Überspringen</option>
                <option value="replace">Ersetzen</option>
                <option value="new">Unter anderem Titel anlegen</option>
              </select>
            </label>
            {#if r.choice === "new"}
              <label>
                Neuer Titel
                <input type="text" maxlength="200" autocomplete="off" bind:value={r.title} oninput={edit} />
              </label>
            {:else if r.choice === "replace"}
              <p class="field-hint">Rezept und Originaltext kommen aus der Datei. Dein Titel, Link und Bild bleiben, Kategorien kommen dazu.</p>
            {/if}
          {:else}
            <label class="check-row">
              <input type="checkbox" checked={r.choice === "new"} onchange={(e) => ((r.choice = e.currentTarget.checked ? "new" : "skip"), edit())} />
              <span>{r.title_taken ? "Neues Gericht" : r.title}</span>
              <small>{r.ingredients === 1 ? "1 Zutat" : `${r.ingredients} Zutaten`}</small>
            </label>
            {#if r.title_taken && r.choice === "new"}
              <label>
                Titel
                <input type="text" maxlength="200" autocomplete="off" bind:value={r.title} oninput={edit} />
              </label>
              <p class="field-hint">Ein anderes Rezept mit diesem Titel gibt es schon (anderer Link).</p>
            {/if}
          {/if}
          {#if r.error}<p class="field-hint error">{r.error}</p>{/if}
        </li>
      {/each}
    </ul>

    <label class="check-row">
      <input type="checkbox" bind:checked={withTags} onchange={edit} />
      <span>Kategorien übernehmen</span>
    </label>
    <p class="field-hint">Danach holt die App die Bilder von den Links der Gerichte (nur für Gerichte ohne eigenes Bild).</p>

    <div class="sticky-actions">
      <button type="button" class="btn primary wide" disabled={busy || chosen.length === 0 || chosen.some((r) => r.choice === "new" && !r.title.trim())} onclick={run}>
        {busy
          ? "Importiere …"
          : confirming
            ? "Wirklich ersetzen? Nicht rückgängig zu machen"
            : chosen.length === 1
              ? "1 Gericht importieren"
              : `${chosen.length} Gerichte importieren`}
      </button>
    </div>
  {/if}
</Sheet>

<style>
  .import-rows {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .import-row {
    background: var(--surface);
    border-radius: 18px;
    box-shadow: var(--card-shadow);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .import-row .check-row {
    margin-bottom: 0;
  }
  .import-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 4px;
  }
  .import-head small {
    color: var(--muted);
  }
  .import-choice select {
    width: 100%;
    min-height: 44px;
  }
  .error {
    color: var(--danger);
  }
</style>
