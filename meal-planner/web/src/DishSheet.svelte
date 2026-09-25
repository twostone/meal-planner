<script lang="ts">
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import { app, deleteDish, removeEntry, saveDish, type SheetState } from "./store.svelte";
  import { isUrl } from "./util";

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
    };
  });

  let title = $state(start.title);
  let url = $state(start.url);
  let note = $state(start.note);
  let problem = $state("");
  let confirmDelete = $state(false);
  let busy = $state(false);

  const creating = start.dishId === null;

  // "chefkoch.de/x" -> "https://chefkoch.de/x"
  function normalizeUrl(v: string): string {
    const t = v.trim();
    return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+/.test(t) ? `https://${t}` : t;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const u = normalizeUrl(url);
    if (!title.trim()) return void (problem = "Bitte einen Titel eingeben.");
    if (u && !isUrl(u)) return void (problem = "Der Link muss mit http:// oder https:// beginnen.");
    problem = "";
    busy = true;
    await saveDish(start.dishId, { title: title.trim(), url: u || null, note: note.trim() || null }, start.addToPlan);
    busy = false;
  }
</script>

<Sheet title={creating ? "Neues Gericht" : "Gericht bearbeiten"}>
  <form onsubmit={submit} novalidate>
    <label>
      Titel
      <input type="text" bind:value={title} autocomplete="off" />
    </label>
    <label>
      Link (optional)
      <input type="text" inputmode="url" placeholder="https://…" bind:value={url} autocomplete="off" autocapitalize="off" />
    </label>
    <label>
      Notiz (optional)
      <input type="text" bind:value={note} autocomplete="off" />
    </label>
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
