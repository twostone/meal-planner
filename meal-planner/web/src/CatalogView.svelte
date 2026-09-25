<script lang="ts">
  import Icon from "./Icon.svelte";
  import { addDishToPlan, app, openDishSheet } from "./store.svelte";
  import type { Dish } from "./types";

  let s = $state("");

  const inPlan = $derived(new Set(app.plan?.entries.map((e) => e.dish_id) ?? []));

  const groups = $derived.by(() => {
    const needle = s.trim().toLowerCase();
    const shown = app.dishes
      .filter((d) => !needle || d.title.toLowerCase().includes(needle))
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
            <button type="button" class="title" onclick={() => openDishSheet({ dishId: d.id })}>{d.title}</button>
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

<button type="button" class="fab" onclick={() => openDishSheet({})}>
  <Icon name="plus" />Neues Gericht
</button>
