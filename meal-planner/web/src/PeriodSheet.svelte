<script lang="ts">
  import Icon from "./Icon.svelte";
  import { addDays, fmtRange, nextSaturday } from "./dates";
  import Sheet from "./Sheet.svelte";
  import { app, createPlan, deletePlan, selectPlan } from "./store.svelte";

  // New periods default to the coming Saturday through Friday, both editable.
  let start = $state(nextSaturday());
  let end = $state(addDays(nextSaturday(), 6));
  let confirmId = $state<number | null>(null);
  let creating = $state(app.plans.length === 0);

  const valid = $derived(!!start && !!end && end >= start);

  function onStart() {
    if (start) end = addDays(start, 6);
  }
</script>

<Sheet title="Zeitraum">
  {#if app.plans.length}
    <ul class="rows plans">
      {#each app.plans as p (p.id)}
        <li class="row" class:current={p.id === app.plan?.id}>
          <button type="button" class="title plan-pick" onclick={() => selectPlan(p.id)} aria-current={p.id === app.plan?.id ? "true" : undefined}>
            <span>{fmtRange(p.start_date, p.end_date)}</span>
            <small>{p.done_count} von {p.entry_count} gekocht</small>
          </button>
          {#if confirmId === p.id}
            <button type="button" class="btn danger" onclick={() => deletePlan(p.id).then(() => (confirmId = null))}>
              Löschen?
            </button>
          {:else}
            <button type="button" class="btn ghost-danger square" aria-label="Zeitraum {fmtRange(p.start_date, p.end_date)} löschen" onclick={() => (confirmId = p.id)}>
              <Icon name="trash" />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if creating}
    <form
      class="newplan"
      onsubmit={(e) => {
        e.preventDefault();
        if (valid) createPlan(start, end);
      }}
    >
      <div class="dates">
        <label>
          Von
          <input type="date" bind:value={start} oninput={onStart} />
        </label>
        <label>
          Bis
          <input type="date" bind:value={end} min={start} />
        </label>
      </div>
      {#if !valid}<p class="problem" role="alert">Das Ende darf nicht vor dem Start liegen.</p>{/if}
      <button type="submit" class="btn primary wide" disabled={!valid}>Zeitraum anlegen</button>
    </form>
  {:else}
    <button type="button" class="btn outline wide" onclick={() => (creating = true)}>
      <Icon name="plus" />Neuer Zeitraum
    </button>
  {/if}
</Sheet>
