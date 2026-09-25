<script lang="ts">
  import { imageSrc } from "./api";
  import Icon from "./Icon.svelte";
  import {
    addByTitle,
    addDishToPlan,
    app,
    openDishSheet,
    openPeriods,
    toggleDone,
  } from "./store.svelte";
  import { domain, isUrl, matchParts } from "./util";

  const CIRC = 2 * Math.PI * 26;

  let q = $state("");

  const entries = $derived(app.plan?.entries ?? []);
  const open = $derived(entries.filter((e) => !e.done));
  const done = $derived(entries.filter((e) => e.done));
  const ratio = $derived(entries.length ? done.length / entries.length : 0);

  const query = $derived(q.trim());
  const inPlan = $derived(new Set(entries.map((e) => e.dish_id)));
  const matches = $derived(
    query
      ? app.dishes.filter((d) => !inPlan.has(d.id) && d.title.toLowerCase().includes(query.toLowerCase())).slice(0, 4)
      : [],
  );
  const exact = $derived(app.dishes.find((d) => d.title.toLowerCase() === query.toLowerCase()));
  const exactInPlan = $derived(!!exact && inPlan.has(exact.id));
  const asLink = $derived(isUrl(query));

  async function pickDish(id: number) {
    if (await addDishToPlan(id)) q = "";
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!query || exactInPlan) return;
    if (asLink) {
      openDishSheet({ addToPlan: true, url: query });
      q = "";
    } else if (await addByTitle(query)) {
      q = "";
    }
  }
</script>

<main>
  {#if !app.plan}
    <div class="empty">
      <p>Noch kein Zeitraum angelegt.</p>
      <button type="button" class="btn primary" onclick={openPeriods}>Zeitraum anlegen</button>
    </div>
  {:else}
    <section class="progress">
      <div class="ring">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="8" />
          <circle
            cx="32"
            cy="32"
            r="26"
            fill="none"
            stroke="var(--gold)"
            stroke-width="8"
            stroke-linecap="round"
            stroke-dasharray="{ratio * CIRC} {CIRC}"
            transform="rotate(-90 32 32)"
          />
        </svg>
        <span>{done.length}/{entries.length}</span>
      </div>
      <div>
        {#if entries.length === 0}
          <strong>Noch nichts geplant</strong>
          <span>Unten ein Gericht eintippen.</span>
        {:else if open.length === 0}
          <strong>Alles gekocht</strong>
          <span>{done.length} von {entries.length} Gerichten gekocht</span>
        {:else}
          <strong>{open.length} noch offen</strong>
          <span>{done.length} von {entries.length} Gerichten gekocht</span>
        {/if}
      </div>
    </section>

    {#snippet row(e: (typeof entries)[number])}
      <li class="row" class:done={e.done}>
        <button
          type="button"
          class="check"
          aria-label={e.done ? `${e.dish.title} als offen markieren` : `${e.dish.title} als gekocht markieren`}
          aria-pressed={e.done}
          onclick={() => toggleDone(e)}
        >
          <span class="box">{#if e.done}<Icon name="check" size={16} />{/if}</span>
        </button>
        {#if e.dish.image}
          <img class="thumb" src={imageSrc(e.dish.image)} alt="" loading="lazy" decoding="async" />
        {/if}
        <button
          type="button"
          class="title"
          onclick={() => openDishSheet({ dishId: e.dish_id, entryId: e.id })}
        >
          <span>{e.dish.title}</span>
          {#if e.dish.tags.length}<small class="tags-line">{e.dish.tags.join(" · ")}</small>{/if}
        </button>
        {#if e.dish.url}
          <a class="chip" href={e.dish.url} target="_blank" rel="noopener noreferrer">
            <Icon name="link" size={14} />{domain(e.dish.url)}
          </a>
        {/if}
      </li>
    {/snippet}

    {#if open.length}
      <h2 class="label">Offen</h2>
      <ul class="rows">
        {#each open as e (e.id)}{@render row(e)}{/each}
      </ul>
    {/if}
    {#if done.length}
      <h2 class="label">Gekocht</h2>
      <ul class="rows">
        {#each done as e (e.id)}{@render row(e)}{/each}
      </ul>
    {/if}
  {/if}
</main>

{#if app.plan}
  <div class="addbar">
    {#if query}
      <div class="suggest">
        {#if asLink}
          <button type="button" class="opt" onclick={() => { openDishSheet({ addToPlan: true, url: query }); q = ""; }}>
            <Icon name="link" />
            <span>Link speichern und Gericht benennen</span>
          </button>
        {:else}
          {#each matches as d (d.id)}
            {@const [pre, hit, post] = matchParts(d.title, query)}
            <button type="button" class="opt" onclick={() => pickDish(d.id)}>
              <span class="grow">
                <span>{pre}<b>{hit}</b>{post}</span>
                <small>Aus dem Katalog{d.tags.length ? ` · ${d.tags.join(" · ")}` : ""}</small>
              </span>
              {#if d.url}<span class="chip static"><Icon name="link" size={14} />{domain(d.url)}</span>{/if}
            </button>
          {/each}
          {#if exactInPlan}
            <p class="hint">„{exact?.title}“ steht schon in der Liste.</p>
          {:else if !exact}
            <button type="button" class="opt new" onclick={() => addByTitle(query).then((ok) => ok && (q = ""))}>
              <Icon name="plus" />
              <span>„{query}“ neu anlegen</span>
            </button>
          {/if}
        {/if}
      </div>
    {/if}
    <form onsubmit={submit}>
      <input
        type="text"
        aria-label="Gericht oder Link hinzufügen"
        placeholder="Gericht oder Link hinzufügen"
        autocomplete="off"
        enterkeyhint="done"
        bind:value={q}
      />
      <button type="submit" class="btn primary square" aria-label="Hinzufügen" disabled={!query || exactInPlan}>
        <Icon name="plus" size={24} />
      </button>
    </form>
  </div>
{/if}
