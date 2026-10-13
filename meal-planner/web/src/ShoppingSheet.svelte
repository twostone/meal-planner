<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import Sheet from "./Sheet.svelte";
  import { app } from "./store.svelte";
  import type { ShoppingList, TodoList } from "./types";

  const planId = app.plan!.id;

  let lists = $state<TodoList[]>([]);
  let listId = $state<string | null>(null);
  let data = $state<ShoppingList | null>(null);
  // Entry ids that go into the list; null = the server's default (the open entries).
  let chosen = $state<number[] | null>(null);
  // Names of the items that will be sent. Items already on the to-do list start unticked.
  let ticked = $state<string[]>([]);
  let loading = $state(true);
  let sending = $state(false);
  let result = $state("");
  let loadSeq = 0;

  const list = $derived(lists.find((l) => l.entity_id === listId) ?? null);
  const withRecipe = $derived(data?.entries.filter((e) => e.has_recipe) ?? []);
  const withoutRecipe = $derived(data?.entries.filter((e) => e.selected && !e.has_recipe) ?? []);
  const toSend = $derived(data?.items.filter((i) => ticked.includes(i.name)) ?? []);

  async function start() {
    try {
      const status = await api.getShoppingStatus();
      lists = status.lists;
      listId = status.selected ?? status.lists[0]?.entity_id ?? null;
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    }
    await load();
  }

  // Only the newest answer counts: chips can be tapped faster than the server answers.
  async function load() {
    const seq = ++loadSeq;
    loading = true;
    try {
      const r = await api.getShopping(planId, chosen ?? undefined, listId);
      if (seq !== loadSeq) return;
      data = r;
      chosen = r.entries.filter((e) => e.selected).map((e) => e.entry_id);
      ticked = r.items.filter((i) => !i.on_list).map((i) => i.name);
    } catch (e) {
      if (seq === loadSeq) app.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  onMount(() => {
    start();
  });

  function toggleEntry(id: number) {
    chosen = chosen?.includes(id) ? chosen.filter((c) => c !== id) : [...(chosen ?? []), id];
    result = "";
    load();
  }

  function toggleItem(name: string) {
    ticked = ticked.includes(name) ? ticked.filter((t) => t !== name) : [...ticked, name];
  }

  function changeList() {
    result = "";
    load();
  }

  async function send() {
    if (!list || !toSend.length) return;
    sending = true;
    result = "";
    try {
      const r = await api.sendShopping(
        list.entity_id,
        toSend.map((i) => ({ name: i.name, spec: i.spec })),
      );
      result = r.failed
        ? `${r.added} hinzugefügt, ${r.failed} nicht gesendet. Bitte später noch einmal versuchen.`
        : `${r.added} Artikel auf „${list.name}“ gesetzt.`;
      // Sent items now show as "steht schon auf der Liste".
      await load();
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }
</script>

<Sheet title="Einkaufsliste">
  {#if lists.length}
    <label>
      Senden an
      <select bind:value={listId} onchange={changeList}>
        {#each lists as l (l.entity_id)}
          <option value={l.entity_id}>{l.name}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if data}
    {#if withRecipe.length}
      <div class="chips" role="group" aria-label="Gerichte für die Einkaufsliste">
        {#each withRecipe as e (e.entry_id)}
          <button type="button" class="tagchip" aria-pressed={chosen?.includes(e.entry_id) ?? false} onclick={() => toggleEntry(e.entry_id)}>
            {e.title}
          </button>
        {/each}
      </div>
    {/if}
    {#if withoutRecipe.length}
      <p class="field-hint">Ohne Zutaten: {withoutRecipe.map((e) => e.title).join(", ")}</p>
    {/if}
    {#if data.list_error}
      <p class="field-hint">Die Liste konnte nicht gelesen werden: Was schon draufsteht, ist nicht markiert.</p>
    {/if}

    {#if data.items.length}
      <ul class="rows shop-items" aria-busy={loading}>
        {#each data.items as i (i.name)}
          {@const on = ticked.includes(i.name)}
          <li>
            <button type="button" class="row shop-item" class:off={!on} role="checkbox" aria-checked={on} onclick={() => toggleItem(i.name)}>
              <span class="check" aria-hidden="true"><span class="box">{#if on}<Icon name="check" size={16} />{/if}</span></span>
              <span class="shop-text">
                <span class="shop-name">{i.name}{#if i.spec}<span class="shop-spec">{" · "}{i.spec}</span>{/if}</span>
                <small>{i.on_list ? "steht schon auf der Liste" : i.sources.join(", ")}</small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if !loading}
      <p class="empty">
        {withRecipe.length ? "Keine Gerichte mit Zutaten ausgewählt." : "Die Gerichte dieser Liste haben noch keine Zutaten."}
      </p>
    {/if}
  {:else if loading}
    <p class="empty">Lade …</p>
  {/if}

  {#if result}<p class="status" aria-live="polite">{result}</p>{/if}

  {#if list}
    <div class="sticky-actions">
      <button type="button" class="btn primary wide" disabled={sending || loading || !toSend.length} onclick={send}>
        {sending ? "Sende …" : `${toSend.length} Artikel an „${list.name}“ senden`}
      </button>
    </div>
  {/if}
</Sheet>
