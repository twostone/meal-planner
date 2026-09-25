<script lang="ts">
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import { app, saveEntryNote, type SheetState } from "./store.svelte";

  let { sheet }: { sheet: Extract<SheetState, { kind: "entryNote" }> } = $props();

  // Mounted fresh on every open, so the initial values are all we need.
  const entry = untrack(() => app.plan?.entries.find((e) => e.id === sheet.entryId));
  const hadNote = !!entry?.note;
  let note = $state(entry?.note ?? "");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    await saveEntryNote(sheet.entryId, note.trim() || null);
    busy = false;
  }
</script>

<Sheet title="Notiz für diese Liste">
  <form onsubmit={submit} novalidate>
    {#if entry}<p class="sub">{entry.dish.title}</p>{/if}
    <label>
      Gilt nur für diesen Eintrag in dieser Liste
      <textarea rows="4" maxlength="1000" bind:value={note} placeholder="z. B. doppelte Portion, ohne Käse"></textarea>
    </label>
    <div class="actions">
      <button type="submit" class="btn primary" disabled={busy}>Speichern</button>
    </div>
    {#if hadNote}
      <button type="button" class="btn ghost-danger wide" disabled={busy} onclick={() => saveEntryNote(sheet.entryId, null)}>
        Notiz löschen
      </button>
    {/if}
  </form>
</Sheet>
