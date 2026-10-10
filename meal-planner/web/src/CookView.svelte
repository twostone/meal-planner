<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { ingredientText, stepLines } from "./recipe";
  import { app, closeSheet, dismissError, finishEntry } from "./store.svelte";
  import type { CookEntry, Ingredient } from "./types";

  const POLL_MS = 4000;
  const planId = app.plan?.id ?? 0;

  let entries = $state<CookEntry[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let active = $state(0);
  // Ticks by "entry:kind:idx". Taps go to the server at once; every phone polls the others' ticks.
  let checked = $state<Record<string, boolean>>({});
  let confirmFinish = $state<number | null>(null);
  let body = $state<HTMLElement>();
  const scrollTop = new Map<number, number>(); // per dish, this device only
  const pending = new Map<string, number>(); // ticks whose request is still running: the poll must not undo them
  let alive = true;

  const key = (entry: number, kind: string, idx: number) => `${entry}:${kind}:${idx}`;
  const current = $derived(entries[active]);

  const steps = (e: CookEntry) => stepLines(e.recipe.instructions);
  const stepsDone = (e: CookEntry) => steps(e).filter((_, i) => checked[key(e.entry_id, "step", i)]).length;

  // Ingredients keep their position (the tick refers to it) and are grouped by neighbouring section.
  function groups(e: CookEntry): { section: string | null; items: { i: Ingredient; idx: number }[] }[] {
    const out: { section: string | null; items: { i: Ingredient; idx: number }[] }[] = [];
    e.recipe.ingredients.forEach((i, idx) => {
      const last = out[out.length - 1];
      if (last && last.section === i.section) last.items.push({ i, idx });
      else out.push({ section: i.section, items: [{ i, idx }] });
    });
    return out;
  }

  function ticksOf(list: { entry_id: number; checks: { ingredients: number[]; steps: number[] } }[]) {
    const out: Record<string, boolean> = {};
    for (const s of list) {
      for (const idx of s.checks.ingredients) out[key(s.entry_id, "ingredient", idx)] = true;
      for (const idx of s.checks.steps) out[key(s.entry_id, "step", idx)] = true;
    }
    return out;
  }

  async function load() {
    try {
      const r = await api.getCook(planId);
      // Open dishes first, finished ones at the back (once, so the tabs do not jump while cooking).
      entries = [...r.entries.filter((e) => !e.done), ...r.entries.filter((e) => e.done)];
      checked = ticksOf(entries);
    } catch {
      failed = true;
    }
    loaded = true;
  }

  async function poll() {
    if (document.visibilityState !== "visible" || !loaded || failed) return;
    try {
      const r = await api.getChecks(planId);
      if (!alive) return;
      for (const s of r.entries) {
        const e = entries.find((x) => x.entry_id === s.entry_id);
        if (e) e.done = s.done;
      }
      const next = ticksOf(r.entries);
      for (const k of pending.keys()) if (checked[k]) next[k] = true;
      checked = next;
    } catch {
      // a missed poll is not worth a message; the next one follows in a few seconds
    }
  }

  async function tickItem(e: CookEntry, kind: "ingredient" | "step", idx: number) {
    const k = key(e.entry_id, kind, idx);
    const next = !checked[k];
    checked[k] = next; // optimistic
    pending.set(k, (pending.get(k) ?? 0) + 1);
    try {
      await api.putCheck(e.entry_id, kind, idx, next);
    } catch (err) {
      checked[k] = !next;
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      const n = (pending.get(k) ?? 1) - 1;
      if (n <= 0) pending.delete(k);
      else pending.set(k, n);
    }
  }

  async function select(i: number) {
    if (i === active) return;
    if (current && body) scrollTop.set(current.entry_id, body.scrollTop);
    active = i;
    confirmFinish = null;
    await tick();
    if (body) body.scrollTop = scrollTop.get(entries[i]!.entry_id) ?? 0;
  }

  async function finish(e: CookEntry) {
    if (confirmFinish !== e.entry_id) return void (confirmFinish = e.entry_id);
    if (await finishEntry(e.entry_id)) {
      e.done = true;
      confirmFinish = null;
    }
  }

  // Keep the screen on while cooking. Quietly does nothing where the browser has no Wake Lock; the browser drops
  // the lock when the page is hidden, so it is requested again when the page comes back.
  let lock: WakeLockSentinel | null = null;
  async function keepAwake() {
    if (document.visibilityState !== "visible" || lock) return;
    try {
      lock = (await navigator.wakeLock?.request("screen")) ?? null;
      lock?.addEventListener("release", () => (lock = null));
    } catch {
      lock = null;
    }
  }
  function onVisible() {
    if (document.visibilityState !== "visible") return;
    void keepAwake();
    void poll();
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    if (!planId) return closeSheet();
    void load();
    void keepAwake();
    timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => {
    alive = false;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    void lock?.release().catch(() => {});
  });
</script>

<div class="cook">
  <div class="cook-bar">
    <button type="button" class="btn outline" onclick={closeSheet}>Beenden</button>
    <strong>Kochen</strong>
  </div>

  {#if app.error}
    <div class="error" role="alert">
      <span>{app.error}</span>
      <button type="button" class="link-btn" onclick={dismissError}>OK</button>
    </div>
  {/if}

  {#if !loaded}
    <p class="empty">Lade …</p>
  {:else if failed}
    <p class="empty">Die Rezepte konnten nicht geladen werden.</p>
  {:else}
    <nav class="cook-tabs" aria-label="Gerichte">
      {#each entries as e, i (e.entry_id)}
        {@const total = steps(e).length}
        <button type="button" class="cook-tab" class:done={e.done} aria-current={i === active ? "true" : undefined} onclick={() => select(i)}>
          {#if e.done}<Icon name="check" size={14} />{/if}
          <span class="cook-tab-title">{e.title}</span>
          {#if total}<small>{stepsDone(e)}/{total}</small>{/if}
        </button>
      {/each}
    </nav>

    <div class="cook-body" bind:this={body}>
      {#if current}
        {@const e = current}
        {@const r = e.recipe}
        {@const list = steps(e)}
        <h2>{e.title}</h2>
        {#if e.note}<p class="cook-note">{e.note}</p>{/if}
        {#if r.servings !== null}<p class="servings">{r.servings} {r.servings === 1 ? "Portion" : "Portionen"}</p>{/if}

        {#if r.ingredients.length}
          <h3>Zutaten</h3>
          {#each groups(e) as g, gi (gi)}
            {#if g.section}<h4>{g.section}</h4>{/if}
            <ul class="cook-list">
              {#each g.items as { i, idx } (idx)}
                {@const on = !!checked[key(e.entry_id, "ingredient", idx)]}
                <li>
                  <button type="button" class="tick" aria-pressed={on} onclick={() => tickItem(e, "ingredient", idx)}>
                    <span class="box">{#if on}<Icon name="check" size={16} />{/if}</span>
                    <span class="tick-text">{ingredientText(i)}{#if i.note}<span class="ing-note">, {i.note}</span>{/if}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/each}
        {/if}

        {#if list.length}
          <h3>Zubereitung</h3>
          <ul class="cook-list">
            {#each list as s, idx (idx)}
              {@const on = !!checked[key(e.entry_id, "step", idx)]}
              <li>
                <button type="button" class="tick" aria-pressed={on} onclick={() => tickItem(e, "step", idx)}>
                  <span class="box">{#if on}<Icon name="check" size={16} />{/if}</span>
                  <span class="tick-text"><b>{idx + 1}.</b> {s}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if !r.ingredients.length && !list.length}
          {#if r.source_text}
            <h3>Rezept vom Link</h3>
            <p class="source-text">{r.source_text}</p>
          {:else}
            <p class="status">Kein Rezept hinterlegt.</p>
          {/if}
          {#if e.url}
            <a class="btn outline wide" href={e.url} target="_blank" rel="noopener noreferrer">Link öffnen</a>
          {/if}
        {/if}

        {#if e.done}
          <p class="cook-finished"><Icon name="check" size={16} /> Fertig und in der Liste abgehakt</p>
        {:else}
          <button type="button" class="btn wide" class:primary={confirmFinish === e.entry_id} class:outline={confirmFinish !== e.entry_id} onclick={() => finish(e)}>
            {confirmFinish === e.entry_id ? "Wirklich fertig? In der Liste abhaken" : "Fertig"}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
