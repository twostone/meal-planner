<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Sheet from "./Sheet.svelte";
  import { app, closeSheet, showError, showInfo } from "./store.svelte";
  import type { RenamePreview } from "./types";

  let { ingredientKey }: { ingredientKey: string } = $props();

  const PREVIEW_DELAY_MS = 250; // like the ingredient search of the catalog: wait until typing pauses

  let name = $state("");
  let plural = $state("");
  let note = $state("");
  let pantry = $state(false);
  let preview = $state<RenamePreview | null>(null);
  let knownNames = $state<string[]>([]);
  let confirming = $state(false);
  let busy = $state(false);
  // The target the plural/pantry fields were filled for: they are only prefilled when it changes, never over an edit.
  let filledFor: string | null | undefined;

  const keyOf = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase("de");
  const typed = $derived(name.replace(/\s+/g, " ").trim());

  onMount(async () => {
    try {
      const first = await api.previewRename(ingredientKey, ingredientKey);
      name = first.source.name;
      apply(first);
    } catch (e) {
      showError(e);
    }
    api.listIngredientNames()
      .then((names) => (knownNames = names.filter((n) => keyOf(n) !== ingredientKey)))
      .catch(() => {}); // suggestions only; the sheet works without them
  });

  function apply(p: RenamePreview) {
    preview = p;
    const target = p.target?.name ?? null;
    if (target === filledFor) return;
    filledFor = target;
    plural = p.target?.plural ?? p.source.plural ?? "";
    pantry = p.target ? p.target.pantry || p.source.pantry : p.source.pantry;
  }

  // The preview follows the typed name: with a known one the two ingredients are merged.
  $effect(() => {
    const wanted = typed;
    if (!wanted || !preview) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const p = await api.previewRename(ingredientKey, wanted);
        if (current) apply(p);
      } catch (e) {
        if (current) showError(e);
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });

  const unchanged = $derived(!!preview && typed === preview.source.name);
  const ready = $derived(!!preview && typed.length > 0 && !unchanged);
  const pluralDiffers = $derived(!!preview?.target && !!preview.target.plural && !!preview.source.plural && preview.target.plural !== preview.source.plural);
  const pantryDiffers = $derived(!!preview?.target && preview.target.pantry !== preview.source.pantry);

  function edit() {
    confirming = false;
  }

  async function rename() {
    if (!ready || busy) return;
    if (!confirming) {
      confirming = true;
      return;
    }
    busy = true;
    try {
      const r = await api.renameIngredient(ingredientKey, { name: typed, plural: plural.trim() || null, note: note.trim() || null, pantry });
      app.ingredientsRevision++;
      closeSheet();
      showInfo(r.dishes === 1 ? "In 1 Gericht geändert" : `In ${r.dishes} Gerichten geändert`);
    } catch (e) {
      showError(e);
      confirming = false;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title="Zutat umbenennen">
  {#if !preview}
    <p class="empty">Lade …</p>
  {:else}
    <label>
      Neuer Name
      <input type="text" maxlength="80" autocomplete="off" list="rename-names" bind:value={name} oninput={edit} />
      <datalist id="rename-names">
        {#each knownNames as n (n)}<option value={n}></option>{/each}
      </datalist>
    </label>
    <p class="field-hint" aria-live="polite">
      {#if preview.target}
        Wird mit „{preview.target.name}“ zusammengeführt ({preview.target.dishes === 1 ? "1 Gericht" : `${preview.target.dishes} Gerichte`}).
      {:else if unchanged}
        Neuen Namen eingeben oder eine vorhandene Zutat wählen.
      {:else}
        „{preview.source.name}“ wird in „{typed}“ umbenannt.
      {/if}
    </p>

    <label>
      Mehrzahl
      <input type="text" maxlength="80" autocomplete="off" placeholder="keine" bind:value={plural} oninput={edit} />
    </label>
    {#if pluralDiffers}
      <p class="field-hint">Bisher: „{preview.source.plural}“ bei {preview.source.name}, „{preview.target?.plural}“ bei {preview.target?.name}. Gilt danach für alle.</p>
    {/if}

    <label>
      Sorte (optional)
      <input type="text" maxlength="200" autocomplete="off" placeholder="z. B. edelsüß" bind:value={note} oninput={edit} />
    </label>
    <p class="field-hint">
      Nur für Zeilen ohne Sorte.{#if preview.notes.length} Behalten ihre: {preview.notes.join(", ")}.{/if}
    </p>

    <label class="check-row">
      <input type="checkbox" bind:checked={pantry} onchange={edit} />
      <span>Haben wir immer</span>
      {#if pantryDiffers}<small>bisher nur bei {preview.source.pantry ? preview.source.name : preview.target?.name}</small>{/if}
    </label>

    <p class="field-hint">Betrifft {preview.dishes.length === 1 ? "1 Gericht" : `${preview.dishes.length} Gerichte`}: {preview.dishes.map((d) => d.title).join(", ")}.</p>
    <div class="sticky-actions">
      <button type="button" class="btn primary wide" disabled={!ready || busy} onclick={rename}>
        {busy ? "Ändere …" : confirming ? "Wirklich ändern? Nicht rückgängig zu machen" : preview.target ? "Zusammenführen" : "Umbenennen"}
      </button>
    </div>
  {/if}
</Sheet>
