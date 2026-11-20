<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { showError } from "./store.svelte";
  import { groupByInitial } from "./util";
  import type { CatalogIngredient } from "./types";

  let ingredients = $state<CatalogIngredient[]>([]);
  let loaded = $state(false);
  let s = $state("");
  let pantryOnly = $state(false);
  // Key of the row whose actions are shown, and whether its delete/reset waits for the second tap.
  let openKey = $state<string | null>(null);
  let confirming = $state(false);
  let busy = $state(false);

  onMount(async () => {
    try {
      ingredients = await api.listIngredients();
    } catch (e) {
      showError(e);
    } finally {
      loaded = true;
    }
  });

  // Same rule as the server's nameKey: single spaces, lower case. A typed name with an existing key is no new ingredient.
  const keyOf = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase("de");
  const typed = $derived(s.replace(/\s+/g, " ").trim());
  const canCreate = $derived(typed.length > 0 && !ingredients.some((i) => i.key === keyOf(typed)));

  const groups = $derived.by(() => {
    const needle = keyOf(s);
    const shown = ingredients
      .filter((i) => !needle || i.key.includes(needle))
      .filter((i) => !pantryOnly || i.pantry);
    return groupByInitial(shown, (i) => i.name);
  });

  function replace(updated: CatalogIngredient) {
    ingredients = ingredients.map((i) => (i.key === updated.key ? updated : i));
  }

  // Ticks at once and undoes the tick when the server refuses.
  async function togglePantry(i: CatalogIngredient) {
    const before = i;
    replace({ ...i, pantry: !i.pantry });
    try {
      replace(await api.setPantry(i.key, !before.pantry));
    } catch (e) {
      replace(before);
      showError(e);
    }
  }

  async function create() {
    if (!canCreate || busy) return;
    busy = true;
    try {
      const created = await api.createIngredient(typed);
      ingredients = [...ingredients, created];
      s = "";
      openKey = null;
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
    }
  }

  function toggleOpen(key: string) {
    openKey = openKey === key ? null : key;
    confirming = false;
  }

  // In no recipe: delete removes it. Used in a recipe: reset clears the settings, the name stays (the recipes hold it).
  async function removeOrReset(i: CatalogIngredient) {
    if (!confirming) {
      confirming = true;
      return;
    }
    busy = true;
    try {
      if (i.dishes === 0) {
        await api.deleteIngredient(i.key);
        ingredients = ingredients.filter((x) => x.key !== i.key);
      } else replace(await api.resetIngredient(i.key));
      openKey = null;
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
      confirming = false;
    }
  }

  const usage = (i: CatalogIngredient) =>
    i.dishes === 0 ? "in keinem Rezept" : i.dishes === 1 ? "in 1 Gericht" : `in ${i.dishes} Gerichten`;
</script>

<main>
  <form class="search" onsubmit={(e) => (e.preventDefault(), create())}>
    <span class="search-icon"><Icon name="search" size={22} /></span>
    <input type="search" aria-label="Zutat suchen oder neu anlegen" placeholder="Zutat suchen oder anlegen" autocomplete="off" bind:value={s} />
  </form>

  <div class="filters" role="group" aria-label="Zutaten filtern">
    <button type="button" class="tagchip" aria-pressed={!pantryOnly} onclick={() => (pantryOnly = false)}>Alle</button>
    <button type="button" class="tagchip" aria-pressed={pantryOnly} onclick={() => (pantryOnly = true)}>Haben wir immer</button>
  </div>

  <p class="ingredients-hint">Haken = haben wir immer zu Hause. Diese Zutaten stehen in der Einkaufsliste abgewählt.</p>

  {#if canCreate}
    <button type="button" class="row create-row" disabled={busy} onclick={create}>
      <Icon name="plus" />„{typed}“ als Zutat anlegen
    </button>
  {/if}

  {#if !loaded}
    <p class="empty">Lade …</p>
  {:else if ingredients.length === 0}
    <p class="empty">Noch keine Zutaten. Sie erscheinen hier, sobald ein Gericht ein Rezept hat.</p>
  {:else if groups.length === 0 && !canCreate}
    <p class="empty">Nichts gefunden.</p>
  {/if}

  {#each groups as g (g.letter)}
    <section class="group">
      <h2 class="letter">{g.letter}</h2>
      <ul class="rows">
        {#each g.items as i (i.key)}
          <li class="ingredient">
            <div class="row" class:pantry={i.pantry}>
              <button type="button" class="check" role="checkbox" aria-checked={i.pantry} aria-label="{i.name}: haben wir immer" onclick={() => togglePantry(i)}>
                <span class="box">{#if i.pantry}<Icon name="check" size={16} />{/if}</span>
              </button>
              <button type="button" class="title" aria-expanded={openKey === i.key} onclick={() => toggleOpen(i.key)}>
                <span>{i.name}</span>
                <small class="tags-line">{usage(i)}{i.pantry ? " · haben wir immer" : ""}</small>
              </button>
            </div>
            {#if openKey === i.key}
              <div class="ingredient-actions">
                {#if i.dishes === 0}
                  <button type="button" class="btn ghost-danger" disabled={busy} onclick={() => removeOrReset(i)}>
                    {confirming ? "Wirklich löschen?" : "Zutat löschen"}
                  </button>
                {:else if i.pantry}
                  <button type="button" class="btn ghost-danger" disabled={busy} onclick={() => removeOrReset(i)}>
                    {confirming ? "Wirklich zurücksetzen?" : "Angaben zurücksetzen"}
                  </button>
                {:else}
                  <small>Steht in Rezepten, deshalb nicht löschbar. Keine weiteren Angaben.</small>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</main>
