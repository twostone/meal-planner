<script lang="ts">
  import { onMount } from "svelte";
  import CatalogView from "./CatalogView.svelte";
  import { fmtRange } from "./dates";
  import DishSheet from "./DishSheet.svelte";
  import Icon from "./Icon.svelte";
  import ListView from "./ListView.svelte";
  import PeriodSheet from "./PeriodSheet.svelte";
  import { app, dismissError, init, openPeriods } from "./store.svelte";

  onMount(() => {
    init();
  });
</script>

<div class="shell">
  <header>
    {#if app.view === "list"}
      <button type="button" class="period" onclick={openPeriods}>
        <span>{app.plan ? fmtRange(app.plan.start_date, app.plan.end_date) : "Zeitraum wählen"}</span>
        <Icon name="chevron-down" />
      </button>
    {:else}
      <h1>Katalog</h1>
      {#if app.plan}
        <p class="target">Hinzufügen zu: {fmtRange(app.plan.start_date, app.plan.end_date)}</p>
      {/if}
    {/if}

    <nav class="segmented" aria-label="Ansicht">
      <button type="button" aria-current={app.view === "list" ? "page" : undefined} onclick={() => (app.view = "list")}>
        Liste
      </button>
      <button
        type="button"
        aria-current={app.view === "catalog" ? "page" : undefined}
        onclick={() => (app.view = "catalog")}
      >
        Katalog
      </button>
    </nav>
  </header>

  {#if app.error && app.sheet.kind === "none"}
    <div class="error" role="alert">
      <span>{app.error}</span>
      <button type="button" class="link-btn" onclick={dismissError}>OK</button>
    </div>
  {/if}

  {#if !app.ready}
    <p class="empty">Lade …</p>
  {:else if app.view === "list"}
    <ListView />
  {:else}
    <CatalogView />
  {/if}

  {#if app.sheet.kind === "dish"}
    <DishSheet sheet={app.sheet} />
  {:else if app.sheet.kind === "periods"}
    <PeriodSheet />
  {/if}
</div>
