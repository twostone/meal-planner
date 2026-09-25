<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import Sheet from "./Sheet.svelte";
  import { app, deleteDish, removeEntry, saveDish, type SheetState } from "./store.svelte";
  import { isUrl, sameTag } from "./util";

  let { sheet }: { sheet: Extract<SheetState, { kind: "dish" }> } = $props();

  // The sheet is mounted fresh on every open, so the initial values are all we need.
  const start = untrack(() => {
    const d = sheet.dishId !== null ? app.dishes.find((x) => x.id === sheet.dishId) : undefined;
    return {
      dishId: sheet.dishId,
      entryId: sheet.entryId,
      addToPlan: sheet.addToPlan,
      title: d?.title ?? sheet.prefill.title,
      url: d?.url ?? sheet.prefill.url,
      note: d?.note ?? "",
      image: d?.image ?? null,
      tags: d?.tags ?? sheet.prefill.tags,
    };
  });

  let title = $state(start.title);
  let url = $state(start.url);
  let note = $state(start.note);
  let image = $state<string | null>(start.image);
  let tags = $state<string[]>(start.tags);
  let newTag = $state("");
  let problem = $state("");
  let confirmDelete = $state(false);
  let busy = $state(false);
  let loading = $state(false);
  let hint = $state("");

  const creating = start.dishId === null;

  // All tags in use (plus the ones picked here), each once, sorted.
  const knownTags = $derived.by(() => {
    const out: string[] = [];
    for (const t of [...app.dishes.flatMap((d) => d.tags), ...tags]) if (!out.some((x) => sameTag(x, t))) out.push(t);
    return out.sort((a, b) => a.localeCompare(b, "de"));
  });
  const hasTag = (t: string) => tags.some((x) => sameTag(x, t));

  function toggleTag(t: string) {
    tags = hasTag(t) ? tags.filter((x) => !sameTag(x, t)) : [...tags, t];
  }

  function addNewTag() {
    const t = newTag.trim().replace(/\s+/g, " ");
    if (t && !hasTag(t)) {
      // Reuse the spelling of an existing tag.
      tags = [...tags, knownTags.find((k) => sameTag(k, t)) ?? t];
    }
    newTag = "";
  }

  // "chefkoch.de/x" -> "https://chefkoch.de/x"
  function normalizeUrl(v: string): string {
    const t = v.trim();
    return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+/.test(t) ? `https://${t}` : t;
  }

  const previewable = $derived(isUrl(normalizeUrl(url)));

  // A saved dish has its preview already: only a changed link (or the button) loads a new one.
  let lastUrl = normalizeUrl(start.url);
  let alive = true;
  onDestroy(() => (alive = false));

  async function loadPreview(force = false) {
    const u = normalizeUrl(url);
    if (!isUrl(u) || loading || (!force && u === lastUrl)) return;
    lastUrl = u;
    loading = true;
    hint = "";
    try {
      const r = await api.previewUrl(u);
      if (!alive) return;
      if (r.title && !title.trim()) title = r.title; // never overwrite what the user typed
      if (r.image) image = r.image;
      hint = r.title || r.image ? "" : "Keine Vorschau verfügbar. Titel bitte selbst eintragen.";
    } catch {
      if (alive) hint = "Vorschau nicht verfügbar. Titel bitte selbst eintragen.";
    } finally {
      if (alive) loading = false;
    }
  }

  // Coming from "paste a link in the add bar": the link is already there.
  onMount(() => {
    if (creating && start.url) {
      lastUrl = "";
      void loadPreview();
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const u = normalizeUrl(url);
    if (!title.trim()) {
      return void (problem = loading
        ? "Die Vorschau lädt noch. Bitte kurz warten oder den Titel selbst eintragen."
        : "Bitte einen Titel eingeben.");
    }
    if (u && !isUrl(u)) return void (problem = "Der Link muss mit http:// oder https:// beginnen.");
    addNewTag(); // a tag typed but not confirmed yet must not get lost
    problem = "";
    busy = true;
    await saveDish(
      start.dishId,
      { title: title.trim(), url: u || null, note: note.trim() || null, image, tags },
      start.addToPlan,
    );
    busy = false;
  }
</script>

<Sheet title={creating ? "Neues Gericht" : "Gericht bearbeiten"}>
  <form onsubmit={submit} novalidate>
    {#if image}
      <img class="preview" src={api.imageSrc(image)} alt="Vorschaubild" />
    {/if}
    <label>
      Titel
      <input type="text" bind:value={title} autocomplete="off" />
    </label>
    <label>
      Link (optional)
      <input
        type="text"
        inputmode="url"
        placeholder="https://…"
        bind:value={url}
        onchange={() => loadPreview()}
        autocomplete="off"
        autocapitalize="off"
      />
    </label>
    {#if previewable}
      <button type="button" class="btn outline" disabled={loading} onclick={() => loadPreview(true)}>
        {loading ? "Lade Vorschau …" : "Titel und Bild vom Link laden"}
      </button>
    {/if}
    <p class="status" aria-live="polite">{loading ? "Lade Vorschau …" : hint}</p>
    {#if image}
      <button type="button" class="btn ghost-danger" onclick={() => (image = null)}>Bild entfernen</button>
    {/if}
    <label>
      Notiz (optional)
      <input type="text" bind:value={note} autocomplete="off" />
    </label>
    <fieldset class="tags">
      <legend>Kategorien (optional)</legend>
      {#if knownTags.length}
        <div class="chips">
          {#each knownTags as t (t)}
            <button type="button" class="tagchip" aria-pressed={hasTag(t)} onclick={() => toggleTag(t)}>{t}</button>
          {/each}
        </div>
      {/if}
      <div class="tag-add">
        <input
          type="text"
          aria-label="Neue Kategorie"
          placeholder="Neue Kategorie, z. B. Snack"
          maxlength="30"
          enterkeyhint="done"
          autocomplete="off"
          bind:value={newTag}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addNewTag();
            }
          }}
        />
        <button type="button" class="btn outline square" aria-label="Kategorie hinzufügen" disabled={!newTag.trim()} onclick={addNewTag}><Icon name="plus" /></button>
      </div>
    </fieldset>
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

    <div class="actions">
      <button type="submit" class="btn primary" disabled={busy}>Speichern</button>
    </div>

    {#if start.entryId !== null}
      <button type="button" class="btn outline wide" onclick={() => removeEntry(start.entryId!)}>Aus Liste entfernen</button>
    {/if}
    {#if start.dishId !== null}
      {#if confirmDelete}
        <button type="button" class="btn danger wide" onclick={() => deleteDish(start.dishId!)}>
          Wirklich aus Katalog löschen?
        </button>
      {:else}
        <button type="button" class="btn ghost-danger wide" onclick={() => (confirmDelete = true)}>Aus Katalog löschen</button>
      {/if}
    {/if}
  </form>
</Sheet>
