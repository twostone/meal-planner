<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { fmtAmount, groupBySection, ingredientText, parseAmount } from "./recipe";
  import Sheet from "./Sheet.svelte";
  import { app, closeSheet } from "./store.svelte";
  import { UNITS, type Recipe } from "./types";

  let { dishId }: { dishId: number } = $props();

  type Row = { key: number; section: string; amount: string; unit: string; name: string; note: string; raw: string | null; sig: string };

  const dish = $derived(app.dishes.find((d) => d.id === dishId));
  let recipe = $state<Recipe | null>(null);
  let editing = $state(false);
  let loadError = $state(false);
  let servings = $state("");
  let instructions = $state("");
  let rows = $state<Row[]>([]);
  let problem = $state("");
  let busy = $state(false);
  let nextKey = 0;

  const isEmpty = (r: Recipe) => r.servings === null && !r.instructions && r.ingredients.length === 0;
  const steps = $derived((recipe?.instructions ?? "").split("\n").map((s) => s.trim()).filter(Boolean));

  onMount(async () => {
    try {
      recipe = await api.getRecipe(dishId);
      editing = isEmpty(recipe);
      if (editing) startEdit();
    } catch {
      loadError = true;
    }
  });

  // The signature says whether a row was touched: only an untouched row keeps its original line (raw).
  const sigOf = (r: Omit<Row, "sig" | "key" | "raw">) => [r.amount, r.unit, r.name].join("|");

  function startEdit() {
    const r = recipe!;
    servings = r.servings === null ? "" : String(r.servings);
    instructions = r.instructions ?? "";
    rows = r.ingredients.map((i) => {
      const row = { section: i.section ?? "", amount: fmtAmount(i), unit: i.unit ?? "", name: i.name, note: i.note ?? "" };
      return { key: nextKey++, ...row, raw: i.raw, sig: sigOf(row) };
    });
    problem = "";
    editing = true;
  }

  function addRow() {
    // A new ingredient starts in the section of the previous one.
    rows.push({ key: nextKey++, section: rows.at(-1)?.section ?? "", amount: "", unit: "", name: "", note: "", raw: null, sig: "" });
  }

  function cancel() {
    if (isEmpty(recipe!)) closeSheet();
    else editing = false;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const sv = servings.trim() === "" ? null : Number(servings);
    if (sv !== null && (!Number.isInteger(sv) || sv < 1 || sv > 50)) return void (problem = "Portionen: eine ganze Zahl von 1 bis 50.");
    const ingredients = [];
    for (const [n, r] of rows.entries()) {
      if (!r.name.trim() && !r.amount.trim() && !r.unit && !r.note.trim()) continue; // empty row
      const a = parseAmount(r.amount);
      if (!a) return void (problem = `Zutat ${n + 1}: Menge wie „1,5“ oder „1-2“ eintragen.`);
      if (!r.name.trim()) return void (problem = `Zutat ${n + 1}: Bitte eine Zutat eintragen.`);
      ingredients.push({
        section: r.section.trim() || null,
        ...a,
        unit: r.unit || null,
        name: r.name.trim(),
        note: r.note.trim() || null,
        raw: r.raw !== null && r.sig === sigOf(r) ? r.raw : null,
      });
    }
    problem = "";
    busy = true;
    app.error = "";
    try {
      recipe = await api.putRecipe(dishId, { servings: sv, instructions: instructions.trim() || null, ingredients });
      if (isEmpty(recipe)) startEdit();
      else editing = false;
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title={dish?.title ?? "Rezept"}>
  {#if loadError}
    <p class="problem" role="alert">Rezept konnte nicht geladen werden.</p>
  {:else if !recipe}
    <p class="status">Lade …</p>
  {:else if editing}
    <form onsubmit={save} novalidate>
      <label>
        Portionen (optional)
        <input type="text" inputmode="numeric" placeholder="z. B. 4" maxlength="2" bind:value={servings} autocomplete="off" />
      </label>

      <fieldset class="ingredients">
        <legend>Zutaten</legend>
        {#each rows as r, n (r.key)}
          <div class="ing-row">
            <div class="ing-main">
              <input type="text" inputmode="decimal" aria-label="Menge" placeholder="Menge" maxlength="12" bind:value={r.amount} autocomplete="off" />
              <select aria-label="Einheit" bind:value={r.unit}>
                <option value="">–</option>
                {#each UNITS as u (u)}<option value={u}>{u}</option>{/each}
              </select>
              <button type="button" class="btn ghost-danger square" aria-label="Zutat {n + 1} löschen" onclick={() => rows.splice(n, 1)}>
                <Icon name="trash" />
              </button>
            </div>
            <input type="text" aria-label="Zutat" placeholder="Zutat" maxlength="80" bind:value={r.name} autocomplete="off" />
            <div class="ing-extra">
              <input type="text" aria-label="Hinweis" placeholder="Hinweis, z. B. fein" maxlength="200" bind:value={r.note} autocomplete="off" />
              <input type="text" aria-label="Abschnitt" placeholder="Abschnitt" maxlength="80" bind:value={r.section} autocomplete="off" />
            </div>
          </div>
        {/each}
        {#if rows.length < 60}
          <button type="button" class="btn outline" onclick={addRow}><Icon name="plus" /> Zutat hinzufügen</button>
        {/if}
      </fieldset>

      <label>
        Zubereitung
        <textarea rows="6" maxlength="10000" bind:value={instructions} placeholder="Ein Schritt pro Zeile"></textarea>
      </label>
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <div class="actions">
        <button type="button" class="btn outline" onclick={cancel}>Abbrechen</button>
        <button type="submit" class="btn primary" disabled={busy}>Speichern</button>
      </div>
    </form>
  {:else}
    <article class="recipe">
      {#if recipe.servings !== null}<p class="servings">{recipe.servings} {recipe.servings === 1 ? "Portion" : "Portionen"}</p>{/if}
      {#if recipe.ingredients.length}
        <h3>Zutaten</h3>
        {#each groupBySection(recipe.ingredients) as g, gi (gi)}
          {#if g.section}<h4>{g.section}</h4>{/if}
          <ul>
            {#each g.items as i, ii (ii)}
              <li>{ingredientText(i)}{#if i.note}<span class="ing-note">, {i.note}</span>{/if}</li>
            {/each}
          </ul>
        {/each}
      {/if}
      {#if steps.length}
        <h3>Zubereitung</h3>
        <ol>
          {#each steps as s, si (si)}<li>{s}</li>{/each}
        </ol>
      {/if}
    </article>
    <div class="actions">
      <button type="button" class="btn outline" onclick={closeSheet}>Schließen</button>
      <button type="button" class="btn primary" onclick={startEdit}>Bearbeiten</button>
    </div>
  {/if}
</Sheet>
