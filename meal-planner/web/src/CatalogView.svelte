<script lang="ts">
  import { onMount } from "svelte";
  import { exportDishes, imageSrc, listDishesWithIngredient, listIngredientNames } from "./api";
  import Icon from "./Icon.svelte";
  import { addDishToPlan, app, openDishSheet, openImport, openRecipe, showError } from "./store.svelte";
  import { groupByInitial, sameTag } from "./util";

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

  // Dishes with a matching ingredient: the search box finds them as well as titles. A failed request just
  // leaves the title search. The response of an older search text is ignored.
  let byIngredient = $state(new Set<number>());
  $effect(() => {
    const needle = s.trim();
    if (needle.length < 2) {
      byIngredient = new Set();
      return;
    }
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const found = await listDishesWithIngredient(needle);
        if (current) byIngredient = new Set(found.map((d) => d.id));
      } catch {
        if (current) byIngredient = new Set();
      }
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });

  // Ingredient names in use as suggestions for the search box: names are stored in the base form ("Apfel"), which
  // the search would not find from "äpfel". Without them the box simply has no suggestions.
  let ingredientNames = $state<string[]>([]);
  onMount(() => {
    listIngredientNames()
      .then((names) => (ingredientNames = names))
      .catch(() => {});
  });

  const inPlan = $derived(new Set(app.plan?.entries.map((e) => e.dish_id) ?? []));

  const groups = $derived.by(() => {
    const needle = s.trim().toLowerCase();
    const shown = app.dishes
      .filter((d) => !needle || d.title.toLowerCase().includes(needle) || byIngredient.has(d.id))
      .filter((d) => !activeFilter || d.tags.some((t) => sameTag(t, activeFilter)));
    return groupByInitial(shown, (d) => d.title);
  });

  // Sharing: pick dishes, then hand the file to the system share menu (phone: straight into a messenger) or download it.
  let selecting = $state(false);
  let selected = $state(new Set<number>());
  let withNotes = $state(true);
  let sharing = $state(false);
  const shownIds = $derived(groups.flatMap((g) => g.items.map((d) => d.id)));
  const allShownSelected = $derived(shownIds.length > 0 && shownIds.every((id) => selected.has(id)));

  function toggle(id: number) {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    selected = next;
  }
  // "Alle" follows the search and the category chip, so a whole category is one tap.
  function toggleAllShown() {
    const next = new Set(selected);
    for (const id of shownIds) allShownSelected ? next.delete(id) : next.add(id);
    selected = next;
  }
  function stopSelecting() {
    selecting = false;
    selected = new Set();
  }

  async function share() {
    if (selected.size === 0 || sharing) return;
    sharing = true;
    try {
      const data = await exportDishes([...selected], withNotes);
      const file = new File([JSON.stringify(data, null, 2)], `essensplanung-${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "AbortError")) throw e; // the user closed the share menu
          return;
        }
      } else download(file);
      stopSelecting();
    } catch (e) {
      showError(e);
    } finally {
      sharing = false;
    }
  }
  function download(file: File) {
    const href = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href, download: file.name });
    a.click();
    URL.revokeObjectURL(href);
  }

  // The file is only parsed here; the server checks its content in the import sheet.
  async function pickImport(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const picked = input.files?.[0];
    input.value = ""; // choosing the same file again must fire `change` again
    if (!picked) return;
    try {
      openImport(JSON.parse(await picked.text()));
    } catch {
      showError("Diese Datei ist keine Rezept-Datei.");
    }
  }
</script>

<main>
  <div class="search">
    <span class="search-icon"><Icon name="search" size={22} /></span>
    <input type="search" aria-label="Gerichte oder Zutaten suchen" placeholder="Gericht oder Zutat suchen" autocomplete="off" list="ingredient-names" bind:value={s} />
    <datalist id="ingredient-names">
      {#each ingredientNames as n (n)}<option value={n}></option>{/each}
    </datalist>
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

  {#if selecting}
    <div class="share-bar">
      <button type="button" class="btn outline" disabled={shownIds.length === 0} onclick={toggleAllShown}>
        {allShownSelected ? "Keine" : `Alle (${shownIds.length})`}
      </button>
      <label class="check-row">
        <input type="checkbox" bind:checked={withNotes} />
        <span>Notizen mitschicken</span>
      </label>
    </div>
  {:else if app.dishes.length > 0}
    <div class="share-bar">
      <button type="button" class="btn ghost" onclick={() => (selecting = true)}>Teilen …</button>
      <label class="btn ghost">
        <input type="file" accept="application/json,.json" class="visually-hidden" onchange={pickImport} />
        Importieren …
      </label>
    </div>
  {/if}

  {#if app.dishes.length === 0}
    <p class="empty">Der Katalog ist noch leer. Lege mit „Neues Gericht“ eins an oder trage eins in eine Liste ein.</p>
    <p class="empty">
      <label class="btn outline">
        <input type="file" accept="application/json,.json" class="visually-hidden" onchange={pickImport} />
        Gerichte aus einer Datei importieren
      </label>
    </p>
  {:else if groups.length === 0}
    <p class="empty">Nichts gefunden.</p>
  {/if}

  {#each groups as g (g.letter)}
    <section class="group">
      <h2 class="letter">{g.letter}</h2>
      <ul class="rows">
        {#each g.items as d (d.id)}
          <li class="row">
            {#if d.image}
              <img class="thumb" src={imageSrc(d.image)} alt="" loading="lazy" decoding="async" />
            {/if}
            <button type="button" class="title" onclick={() => (selecting ? toggle(d.id) : openRecipe(d.id))}>
              <span>{d.title}</span>
              {#if d.tags.length}<small class="tag-pills">{#each d.tags as t (t)}<span class="pill">{t}</span>{/each}</small>{/if}
            </button>
            {#if selecting}
              <label class="pick">
                <input type="checkbox" checked={selected.has(d.id)} aria-label="{d.title} zum Teilen auswählen" onchange={() => toggle(d.id)} />
              </label>
            {:else if d.url}
              <a class="icon-link" href={d.url} target="_blank" rel="noopener noreferrer" aria-label="Rezept-Link von {d.title} öffnen">
                <Icon name="link" size={16} />
              </a>
            {/if}
            {#if selecting}
              <!-- no list actions while picking dishes to share -->
            {:else if inPlan.has(d.id)}
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

{#if selecting}
  <div class="share-actions">
    <button type="button" class="btn outline" onclick={stopSelecting}>Abbrechen</button>
    <button type="button" class="btn primary" disabled={selected.size === 0 || sharing} onclick={share}>
      {sharing ? "Bereite vor …" : selected.size === 1 ? "1 Gericht teilen" : `${selected.size} Gerichte teilen`}
    </button>
  </div>
{:else}
  <button type="button" class="fab" onclick={() => openDishSheet({ tags: activeFilter ? [activeFilter] : [] })}>
    <Icon name="plus" />Neues Gericht
  </button>
{/if}
