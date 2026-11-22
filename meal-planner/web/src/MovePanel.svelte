<script lang="ts">
  import { fmtRange, today } from "./dates";
  import { app } from "./store.svelte";

  // Picks the plan to move dishes to (dish sheet: one entry, period sheet: all open ones). Opening it and tapping
  // "Verschieben" are two separate taps, so nothing moves by accident.
  let {
    fromPlanId,
    label,
    detail = "",
    onmove,
  }: { fromPlanId: number; label: string; detail?: string; onmove: (planId: number, planLabel: string) => Promise<unknown> } = $props();

  // Only plans that are not over yet: moving into a past week makes no sense. The earliest comes first and is preselected.
  const targets = $derived(
    app.plans
      .filter((p) => p.id !== fromPlanId && p.end_date >= today())
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .map((p) => ({ id: p.id, label: p.title ?? fmtRange(p.start_date, p.end_date) })),
  );
  let open = $state(false);
  let targetId = $state<number | null>(null);
  let busy = $state(false);

  function start() {
    targetId = targets[0]?.id ?? null;
    open = true;
  }

  async function move() {
    const target = targets.find((t) => t.id === targetId);
    if (!target) return;
    busy = true;
    await onmove(target.id, target.label);
    busy = false;
  }
</script>

{#if !open}
  <button type="button" class="btn ghost" onclick={start}>{label}</button>
{:else}
  <div class="move">
    {#if targets.length === 0}
      <p class="hint">Es gibt keine andere aktuelle oder künftige Liste. Lege zuerst eine neue Liste an.</p>
    {:else}
      <label>
        Verschieben nach
        <select bind:value={targetId}>
          {#each targets as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </label>
      {#if detail}<p class="hint">{detail}</p>{/if}
      <button type="button" class="btn primary wide" disabled={busy} onclick={move}>Verschieben</button>
    {/if}
    <button type="button" class="btn outline wide" onclick={() => (open = false)}>Abbrechen</button>
  </div>
{/if}
