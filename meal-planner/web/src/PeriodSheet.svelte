<script lang="ts">
  import Icon from "./Icon.svelte";
  import { addDays, fmtRange, nextSaturday } from "./dates";
  import Sheet from "./Sheet.svelte";
  import { app, createPlan, deletePlan, selectPlan, updatePlan } from "./store.svelte";
  import type { PlanSummary } from "./types";

  // New periods default to the coming Saturday through Friday, both editable.
  let start = $state(nextSaturday());
  let end = $state(addDays(nextSaturday(), 6));
  let confirmId = $state<number | null>(null);
  let creating = $state(app.plans.length === 0);

  // The plan being edited in place (name and period); null = none.
  let editId = $state<number | null>(null);
  let editTitle = $state("");
  let editStart = $state("");
  let editEnd = $state("");

  const valid = $derived(!!start && !!end && end >= start);
  const editValid = $derived(!!editStart && !!editEnd && editEnd >= editStart);

  function onStart() {
    if (start) end = addDays(start, 6);
  }

  function startEdit(p: PlanSummary) {
    confirmId = null;
    editId = p.id;
    editTitle = p.title ?? "";
    editStart = p.start_date;
    editEnd = p.end_date;
  }

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (editId === null || !editValid) return;
    // An empty name clears it; the server refuses overlaps and the sheet shows that error.
    if (await updatePlan(editId, { title: editTitle.trim() || null, start_date: editStart, end_date: editEnd })) editId = null;
  }
</script>

<Sheet title="Zeitraum">
  {#if app.plans.length}
    <ul class="rows plans">
      {#each app.plans as p (p.id)}
        {#if editId === p.id}
          <li>
            <form class="newplan" onsubmit={saveEdit}>
              <label>
                Name (optional)
                <input type="text" maxlength="100" placeholder={fmtRange(p.start_date, p.end_date)} bind:value={editTitle} />
              </label>
              <div class="dates">
                <label>
                  Von
                  <input type="date" bind:value={editStart} />
                </label>
                <label>
                  Bis
                  <input type="date" bind:value={editEnd} min={editStart} />
                </label>
              </div>
              {#if !editValid}<p class="problem" role="alert">Das Ende darf nicht vor dem Start liegen.</p>{/if}
              <button type="submit" class="btn primary wide" disabled={!editValid}>Speichern</button>
              <button type="button" class="btn outline wide" onclick={() => (editId = null)}>Abbrechen</button>
            </form>
          </li>
        {:else}
          <li class="row" class:current={p.id === app.plan?.id}>
            <button type="button" class="title plan-pick" onclick={() => selectPlan(p.id)} aria-current={p.id === app.plan?.id ? "true" : undefined}>
              <span>{p.title ?? fmtRange(p.start_date, p.end_date)}</span>
              <small>{p.title ? `${fmtRange(p.start_date, p.end_date)} · ` : ""}{p.done_count} von {p.entry_count} gekocht</small>
            </button>
            <button type="button" class="btn outline square" aria-label="Zeitraum {p.title ?? fmtRange(p.start_date, p.end_date)} bearbeiten" onclick={() => startEdit(p)}>
              <Icon name="pencil" />
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
        {/if}
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
