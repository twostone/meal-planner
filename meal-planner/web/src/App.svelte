<script lang="ts">
  import { onMount } from "svelte";
  import CatalogView from "./CatalogView.svelte";
  import { fmtRange } from "./dates";
  import CookView from "./CookView.svelte";
  import DishSheet from "./DishSheet.svelte";
  import IngredientRenameSheet from "./IngredientRenameSheet.svelte";
  import IngredientSplitSheet from "./IngredientSplitSheet.svelte";
  import IngredientsView from "./IngredientsView.svelte";
  import Icon from "./Icon.svelte";
  import ListView from "./ListView.svelte";
  import ImportSheet from "./ImportSheet.svelte";
  import PeriodSheet from "./PeriodSheet.svelte";
  import RecipeSheet from "./RecipeSheet.svelte";
  import ShoppingSheet from "./ShoppingSheet.svelte";
  import Toast from "./Toast.svelte";
  import { app, init, openCook, openPeriods, openShopping } from "./store.svelte";

  onMount(() => {
    init();
  });

  const TABS = [
    { view: "list", label: "Liste", icon: "list" },
    { view: "catalog", label: "Katalog", icon: "book" },
    { view: "ingredients", label: "Zutaten", icon: "leaf" },
  ] as const;

  // A plan is shown by its name when it has one, else by its date range.
  const planLabel = $derived(app.plan ? (app.plan.title ?? fmtRange(app.plan.start_date, app.plan.end_date)) : null);
</script>

<div class="shell">
  <header>
    {#if app.view === "list"}
      <div class="topbar">
        <button type="button" class="period" onclick={openPeriods}>
          <span>{planLabel ?? "Zeitraum wählen"}</span>
          <Icon name="chevron-down" />
        </button>
        {#if app.plan?.entries.length}
          {#if app.shopping}
            <button type="button" class="btn outline square" aria-label="Einkaufen" title="Einkaufen" onclick={openShopping}>
              <Icon name="cart" />
            </button>
          {/if}
          <button type="button" class="btn primary" onclick={() => openCook()}>Kochen</button>
        {/if}
      </div>
    {:else if app.view === "ingredients"}
      <h1>Zutaten</h1>
    {:else}
      <h1>Katalog</h1>
      {#if planLabel}
        <p class="target">Hinzufügen zu: {planLabel}</p>
      {/if}
    {/if}
  </header>

  {#if !app.ready}
    <p class="empty">Lade …</p>
  {:else if app.view === "list"}
    <ListView />
  {:else if app.view === "ingredients"}
    <IngredientsView />
  {:else}
    <CatalogView />
  {/if}

  <nav class="tabbar" aria-label="Ansicht">
    {#each TABS as t (t.view)}
      <button type="button" aria-current={app.view === t.view ? "page" : undefined} onclick={() => (app.view = t.view)}>
        <span class="tab-icon"><Icon name={t.icon} size={22} /></span>
        {t.label}
      </button>
    {/each}
  </nav>

  {#if app.sheet.kind === "dish"}
    <DishSheet sheet={app.sheet} />
  {:else if app.sheet.kind === "recipe"}
    <RecipeSheet dishId={app.sheet.dishId} entryId={app.sheet.entryId} />
  {:else if app.sheet.kind === "cook"}
    <CookView startEntryId={app.sheet.entryId} />
  {:else if app.sheet.kind === "shopping"}
    <ShoppingSheet />
  {:else if app.sheet.kind === "split"}
    <IngredientSplitSheet ingredientKey={app.sheet.ingredientKey} />
  {:else if app.sheet.kind === "rename"}
    <IngredientRenameSheet ingredientKey={app.sheet.ingredientKey} />
  {:else if app.sheet.kind === "periods"}
    <PeriodSheet />
  {:else if app.sheet.kind === "import"}
    <ImportSheet file={app.sheet.file} />
  {/if}
  <!-- Sheets show the toast themselves; cook mode is no dialog, so the shell's toast lies above it. -->
  {#if app.sheet.kind === "none" || app.sheet.kind === "cook"}
    <Toast />
  {/if}
</div>
