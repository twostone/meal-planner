<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import Sheet from "./Sheet.svelte";
  import { app, closeSheet, showError, showInfo } from "./store.svelte";

  let { ingredientKey }: { ingredientKey: string } = $props();

  // The same limits as the server (MIN/MAX_SPLIT_PARTS in app.ts).
  const MIN_PARTS = 2;
  const MAX_PARTS = 10;

  let name = $state("");
  let dishes = $state<{ id: number; title: string }[]>([]);
  let parts = $state<{ name: string; note: string }[]>([]);
  let loading = $state(true);
  let confirming = $state(false);
  let busy = $state(false);

  onMount(async () => {
    try {
      const preview = await api.previewSplit(ingredientKey);
      name = preview.name;
      dishes = preview.dishes;
      parts = preview.parts.map((p) => ({ name: p, note: "" }));
      while (parts.length < MIN_PARTS) parts.push({ name: "", note: "" });
    } catch (e) {
      showError(e);
    } finally {
      loading = false;
    }
  });

  const filled = $derived(parts.filter((p) => p.name.trim()));
  const keyOf = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase("de");
  // A part named like the line would keep it; the server refuses that too.
  const keepsName = $derived(filled.some((p) => keyOf(p.name) === ingredientKey));
  const ready = $derived(filled.length >= MIN_PARTS && !keepsName);

  function edit() {
    confirming = false;
  }

  async function split() {
    if (!ready || busy) return;
    if (!confirming) {
      confirming = true;
      return;
    }
    busy = true;
    try {
      const r = await api.splitIngredient(
        ingredientKey,
        filled.map((p) => ({ name: p.name.trim(), note: p.note.trim() || null })),
      );
      app.ingredientsRevision++;
      closeSheet();
      showInfo(r.dishes === 1 ? "In 1 Gericht aufgeteilt" : `In ${r.dishes} Gerichten aufgeteilt`);
    } catch (e) {
      showError(e);
      confirming = false;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title="Zutat aufteilen">
  {#if loading}
    <p class="empty">Lade …</p>
  {:else if name}
    <p class="split-source">„{name}“ wird in jedem Rezept durch diese Zutaten ersetzt (ohne Menge, die Originalzeile bleibt):</p>
    <fieldset class="ingredients">
      <legend>Neue Zutaten</legend>
      {#each parts as p, n (n)}
        <div class="ing-main">
          <input type="text" aria-label="Zutat {n + 1}" placeholder="Zutat" maxlength="80" autocomplete="off" bind:value={p.name} oninput={edit} />
          <input type="text" aria-label="Sorte von Zutat {n + 1}" placeholder="Sorte (optional)" maxlength="200" autocomplete="off" bind:value={p.note} oninput={edit} />
          <button
            type="button"
            class="btn ghost-danger square"
            aria-label="Zutat {n + 1} entfernen"
            disabled={parts.length <= MIN_PARTS}
            onclick={() => (parts.splice(n, 1), edit())}
          >
            <Icon name="trash" />
          </button>
        </div>
      {/each}
      {#if parts.length < MAX_PARTS}
        <button type="button" class="btn outline" onclick={() => (parts.push({ name: "", note: "" }), edit())}><Icon name="plus" /> Zutat hinzufügen</button>
      {/if}
    </fieldset>
    {#if keepsName}<p class="problem">Ein Teil darf nicht wie die ganze Zeile heißen.</p>{/if}
    <p class="field-hint">
      Betrifft {dishes.length === 1 ? "1 Gericht" : `${dishes.length} Gerichte`}: {dishes.map((d) => d.title).join(", ")}.
      Haken im Kochmodus für diese Zutaten werden zurückgesetzt.
    </p>
    <div class="sticky-actions">
      <button type="button" class="btn primary wide" disabled={!ready || busy} onclick={split}>
        {busy ? "Teile auf …" : confirming ? "Wirklich aufteilen? Nicht rückgängig zu machen" : `In ${filled.length} Zutaten aufteilen`}
      </button>
    </div>
  {/if}
</Sheet>
