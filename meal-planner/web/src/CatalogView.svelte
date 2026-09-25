<script lang="ts">
  import { imageSrc } from "./api";
  import Icon from "./Icon.svelte";
  import { addDishToPlan, app, openDishSheet } from "./store.svelte";
  import type { Dish } from "./types";
  import { sameTag } from "./util";

  let s = $state("");
  let filter = $state<string | null>(null); // active category chip

  // Every tag in use, each once, sorted.
  const allTags = $derived.by(() => {
    const out: string[] = [];
    for (const t of app.dishes.flatMap((d) => d.tags)) if (!out.some((x) => sameTag(x, t))) out.push(t);
    return out.sort((a, b) => a.localeCompare(b, "de"));
  });
  // The chip disappears when its last dish loses the tag: fall back to "Alle".
  const activeFilter = $derived(filter && allTags.some((t) => sameTag(t, filter!)) ? filter : null);

  const inPlan = $derived(new Set(app.plan?.entries.map((e) => e.dish_id) ?? []));

  const groups = $derived.by(() => {
    const needle = s.trim().toLowerCase();
    const shown = app.dishes
      .filter((d) => !needle || d.title.toLowerCase().includes(needle))
      .filter((d) => !activeFilter || d.tags.some((t) => sameTag(t, activeFilter)))
      .sort((a, b) => a.title.localeCompare(b.title, "de"));
    const out: { letter: string; dishes: Dish[] }[] = [];
    for (const d of shown) {
      const first = d.title.trim().charAt(0).toLocaleUpperCase("de");
      const letter = /\p{L}/u.test(first) ? first : "#";
      const last = out[out.length - 1];
      if (last?.letter === letter) last.dishes.push(d);
      else out.push({ letter, dishes: [d] });
    }
    return out;
  });
</script>

<main>
  <div class="search">
    <span class="search-icon"><Icon name="search" size={22} /></span>
    <input type="search" aria-label="Gerichte suchen" placeholder="Gerichte suchen" autocomplete="off" bind:value={s} />
  </div>

  {#if allTags.length}
    <div class="filters" role="group" aria-label="Nach Kategorie filtern">
      <button type="button" class="tagchip" aria-pressed={activeFilter === null} onclick={() => (filter = null)}>Alle</button>
      {#each allTags as t (t)}
        <button
          type="button"
          class="tagchip"
          aria-pressed={activeFilter !== null && sameTag(activeFilter, t)}
          onclick={() => (filter = t)}
        >
          {t}
        </button>
      {/each}
    </div>
  {/if}

  {#if app.dishes.length === 0}
    <p class="empty">Der Katalog ist noch leer. Gerichte entstehen automatisch, wenn du sie in eine Liste einträgst.</p>
  {:else if groups.length === 0}
    <p class="empty">Nichts gefunden.</p>
  {/if}

  {#each groups as g (g.letter)}
    <section class="group">
      <h2 class="letter">{g.letter}</h2>
      <ul class="rows">
        {#each g.dishes as d (d.id)}
          <li class="row">
            {#if d.image}
              <img class="thumb" src={imageSrc(d.image)} alt="" loading="lazy" decoding="async" />
            {/if}
            <button type="button" class="title" onclick={() => openDishSheet({ dishId: d.id })}>
              <span>{d.title}</span>
              {#if d.tags.length}<small class="tags-line">{d.tags.join(" · ")}</small>{/if}
            </button>
            {#if d.url}
              <a class="icon-link" href={d.url} target="_blank" rel="noopener noreferrer" aria-label="Rezept-Link von {d.title} öffnen">
                <Icon name="link" size={16} />
              </a>
            {/if}
            {#if inPlan.has(d.id)}
              <span class="in-plan"><Icon name="check" size={16} />In Liste</span>
            {:else}
              <button
                type="button"
                class="btn outline square"
                aria-label="{d.title} zur Liste hinzufügen"
                disabled={!app.plan}
                onclick={() => addDishToPlan(d.id)}
              >
                <Icon name="plus" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</main>

<button type="button" class="fab" onclick={() => openDishSheet({ tags: activeFilter ? [activeFilter] : [] })}>
  <Icon name="plus" />Neues Gericht
</button>
