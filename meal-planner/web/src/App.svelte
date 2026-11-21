<script lang="ts">
  import { onMount } from "svelte";
  import CatalogView from "./CatalogView.svelte";
  import { fmtRange } from "./dates";
  import CookView from "./CookView.svelte";
  import DishSheet from "./DishSheet.svelte";
  import IngredientSplitSheet from "./IngredientSplitSheet.svelte";
  import IngredientsView from "./IngredientsView.svelte";
  import Icon from "./Icon.svelte";
  import ListView from "./ListView.svelte";
  import PeriodSheet from "./PeriodSheet.svelte";
  import RecipeSheet from "./RecipeSheet.svelte";
  import ShoppingSheet from "./ShoppingSheet.svelte";
  import Toast from "./Toast.svelte";
  import { app, init, openCook, openPeriods, openShopping } from "./store.svelte";

  onMount(() => {
    init();
  });

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
          <button type="button" class="btn primary" onclick={openCook}>Kochen</button>
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
    <button type="button" aria-current={app.view === "list" ? "page" : undefined} onclick={() => (app.view = "list")}>
      Liste
    </button>
    <button type="button" aria-current={app.view === "catalog" ? "page" : undefined} onclick={() => (app.view = "catalog")}>
      Katalog
    </button>
    <button type="button" aria-current={app.view === "ingredients" ? "page" : undefined} onclick={() => (app.view = "ingredients")}>
      Zutaten
    </button>
  </nav>

  {#if app.sheet.kind === "dish"}
    <DishSheet sheet={app.sheet} />
  {:else if app.sheet.kind === "recipe"}
    <RecipeSheet dishId={app.sheet.dishId} />
  {:else if app.sheet.kind === "cook"}
    <CookView />
  {:else if app.sheet.kind === "shopping"}
    <ShoppingSheet />
  {:else if app.sheet.kind === "split"}
    <IngredientSplitSheet ingredientKey={app.sheet.ingredientKey} />
  {:else if app.sheet.kind === "periods"}
    <PeriodSheet />
  {/if}
  <!-- Sheets show the toast themselves; cook mode is no dialog, so the shell's toast lies above it. -->
  {#if app.sheet.kind === "none" || app.sheet.kind === "cook"}
    <Toast />
  {/if}
</div>
