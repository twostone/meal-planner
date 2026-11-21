<script lang="ts">
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { app, openRename, openSplit, showError } from "./store.svelte";
  import { groupByInitial } from "./util";
  import type { CatalogIngredient, IngredientCategory } from "./types";

  const MAX_CATEGORY_LENGTH = 30; // like the server (MAX_CATEGORY_LENGTH in app.ts)
  const ALL = "all";
  const PANTRY = "pantry";

  let ingredients = $state<CatalogIngredient[]>([]);
  let categories = $state<IngredientCategory[]>([]);
  let loaded = $state(false);
  let s = $state("");
  // "all", "pantry" or the key of a category.
  let filter = $state(ALL);
  // Key of the row whose actions are shown, and whether its delete/reset waits for the second tap.
  let openKey = $state<string | null>(null);
  let confirming = $state(false);
  let busy = $state(false);

  // Loads again after a split or rename rewrote recipes (app.ingredientsRevision), so counts and names are current.
  $effect(() => {
    void app.ingredientsRevision;
    load();
  });

  async function load() {
    try {
      [ingredients, categories] = await Promise.all([api.listIngredients(), api.listIngredientCategories()]);
    } catch (e) {
      showError(e);
    } finally {
      loaded = true;
    }
  }

  async function loadCategories() {
    try {
      categories = await api.listIngredientCategories();
    } catch (e) {
      showError(e);
    }
  }

  // Same rule as the server's nameKey: single spaces, lower case. A typed name with an existing key is no new ingredient.
  const keyOf = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase("de");
  const typed = $derived(s.replace(/\s+/g, " ").trim());
  const canCreate = $derived(typed.length > 0 && !ingredients.some((i) => i.key === keyOf(typed)));
  const inPantry = (i: CatalogIngredient) => i.pantry || i.category_pantry;
  // A category chip disappears with the category: fall back to "Alle".
  const activeCategory = $derived(categories.find((c) => c.key === filter) ?? null);

  const groups = $derived.by(() => {
    const needle = keyOf(s);
    const shown = ingredients
      .filter((i) => !needle || i.key.includes(needle))
      .filter((i) => (filter === PANTRY ? inPantry(i) : activeCategory ? i.category !== null && keyOf(i.category) === activeCategory.key : true));
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

  async function setCategory(i: CatalogIngredient, value: string) {
    const category = value.replace(/\s+/g, " ").trim() || null;
    if (category === i.category) return;
    try {
      replace(await api.setIngredientCategory(i.key, category));
      await loadCategories();
    } catch (e) {
      showError(e);
    }
  }

  async function toggleCategoryPantry(c: IngredientCategory) {
    busy = true;
    try {
      await api.setCategoryPantry(c.key, !c.pantry);
      await load();
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
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
      await loadCategories();
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
      confirming = false;
    }
  }

  const usage = (i: CatalogIngredient) =>
    i.dishes === 0 ? "in keinem Rezept" : i.dishes === 1 ? "in 1 Gericht" : `in ${i.dishes} Gerichten`;
  const subline = (i: CatalogIngredient) =>
    [usage(i), i.category, i.pantry ? "haben wir immer" : i.category_pantry ? "haben wir immer (Kategorie)" : null].filter(Boolean).join(" · ");
</script>

<main>
  <form class="search" onsubmit={(e) => (e.preventDefault(), create())}>
    <span class="search-icon"><Icon name="search" size={22} /></span>
    <input type="search" aria-label="Zutat suchen oder neu anlegen" placeholder="Zutat suchen oder anlegen" autocomplete="off" bind:value={s} />
  </form>

  <div class="filters" role="group" aria-label="Zutaten filtern">
    <button type="button" class="tagchip" aria-pressed={filter === ALL || (filter !== PANTRY && !activeCategory)} onclick={() => (filter = ALL)}>Alle</button>
    <button type="button" class="tagchip" aria-pressed={filter === PANTRY} onclick={() => (filter = PANTRY)}>Haben wir immer</button>
    {#each categories as c (c.key)}
      <button type="button" class="tagchip" aria-pressed={filter === c.key} onclick={() => (filter = c.key)}>{c.name}</button>
    {/each}
  </div>

  {#if activeCategory}
    <label class="check-row category-pantry">
      <input type="checkbox" checked={activeCategory.pantry} disabled={busy} onchange={() => toggleCategoryPantry(activeCategory)} />
      <span>Alles aus „{activeCategory.name}“ haben wir immer</span>
    </label>
  {:else}
    <p class="ingredients-hint">Haken = haben wir immer zu Hause. Diese Zutaten stehen in der Einkaufsliste abgewählt.</p>
  {/if}

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

  <datalist id="ingredient-categories">
    {#each categories as c (c.key)}<option value={c.name}></option>{/each}
  </datalist>

  {#each groups as g (g.letter)}
    <section class="group">
      <h2 class="letter">{g.letter}</h2>
      <ul class="rows">
        {#each g.items as i (i.key)}
          {@const on = inPantry(i)}
          <li class="ingredient">
            <div class="row" class:pantry={on}>
              <!-- Pantry through the category has no exception per ingredient: the box is then fixed. -->
              <button
                type="button"
                class="check"
                role="checkbox"
                aria-checked={on}
                aria-label="{i.name}: haben wir immer"
                disabled={i.category_pantry}
                title={i.category_pantry ? `Gilt für die ganze Kategorie „${i.category}“` : undefined}
                onclick={() => togglePantry(i)}
              >
                <span class="box">{#if on}<Icon name="check" size={16} />{/if}</span>
              </button>
              <button type="button" class="title" aria-expanded={openKey === i.key} onclick={() => toggleOpen(i.key)}>
                <span>{i.name}</span>
                <small class="tags-line">{subline(i)}</small>
              </button>
            </div>
            {#if openKey === i.key}
              <div class="ingredient-actions">
                <label class="category-field">
                  Kategorie
                  <input
                    type="text"
                    list="ingredient-categories"
                    maxlength={MAX_CATEGORY_LENGTH}
                    autocomplete="off"
                    placeholder="z. B. Gewürz"
                    value={i.category ?? ""}
                    onchange={(e) => setCategory(i, e.currentTarget.value)}
                  />
                </label>
                {#if i.dishes === 0}
                  <button type="button" class="btn ghost-danger" disabled={busy} onclick={() => removeOrReset(i)}>
                    {confirming ? "Wirklich löschen?" : "Zutat löschen"}
                  </button>
                {:else}
                  <!-- Offered for every used name: the split suggestion may miss a separator. -->
                  <button type="button" class="btn outline" onclick={() => openRename(i.key)}>Umbenennen …</button>
                  <button type="button" class="btn outline" onclick={() => openSplit(i.key)}>Aufteilen …</button>
                  {#if i.pantry || i.category}
                    <button type="button" class="btn ghost-danger" disabled={busy} onclick={() => removeOrReset(i)}>
                      {confirming ? "Wirklich zurücksetzen?" : "Angaben zurücksetzen"}
                    </button>
                  {/if}
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</main>
