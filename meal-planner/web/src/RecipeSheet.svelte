<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { fmtAmount, groupBySection, ingredientExtra, ingredientText, parseAmount, stepLines } from "./recipe";
  import Sheet from "./Sheet.svelte";
  import { app, closeSheet } from "./store.svelte";
  import { UNITS, type AiStatus, type IngredientChange, type Recipe, type RecipeDraft } from "./types";

  let { dishId }: { dishId: number } = $props();

  type Row = { key: number; section: string; amount: string; unit: string; name: string; plural: string; note: string; prep: string; raw: string | null; sig: string; verified: boolean };

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
  let fetching = $state(false);
  let confirmReplace = $state(false);
  let sourceHint = $state("");
  let ai = $state<AiStatus>({ ai: false, reason: null, image: false });
  let drafting = $state(false);
  let draftMode = $state(false); // the editor shows a draft from the AI, not the saved recipe
  // "Zutaten vereinheitlichen": suggestions of the AI for the saved lines, each can be left out (null = none asked for)
  let changes = $state<IngredientChange[] | null>(null);
  let keptPos = $state<number[]>([]);
  let normalizing = $state(false);
  let confirmApply = $state(false);

  const hasLink = $derived(!!dish?.url);
  // Structured part only: a recipe that has just the original text is still shown, not edited.
  const isEmpty = (r: Recipe) => r.servings === null && !r.instructions && r.ingredients.length === 0;
  const isBlank = (r: Recipe) => isEmpty(r) && !r.source_text;
  const steps = $derived(stepLines(recipe?.instructions ?? null));

  onMount(async () => {
    try {
      recipe = await api.getRecipe(dishId);
      // Nothing saved yet: straight into the editor, unless there is a link to get the recipe from first.
      if (isBlank(recipe) && !hasLink) startEdit();
    } catch {
      loadError = true;
    }
    // Only matters for the button; a failed status simply hides it.
    ai = await api.getRecipeStatus().catch(() => ({ ai: false, reason: null, image: false }));
  });

  // The signature says whether a row was touched: only an untouched row keeps its original line (raw).
  const sigOf = (r: Pick<Row, "amount" | "unit" | "name">) => [r.amount, r.unit, r.name].join("|");

  // `draft`: values from the AI instead of the saved recipe (nothing is saved before "Speichern").
  function startEdit(draft?: RecipeDraft) {
    const r = draft ?? recipe!;
    draftMode = !!draft;
    servings = r.servings === null ? "" : String(r.servings);
    instructions = r.instructions ?? "";
    rows = r.ingredients.map((i) => {
      const row = { section: i.section ?? "", amount: fmtAmount(i), unit: i.unit ?? "", name: i.name, plural: i.plural ?? "", note: i.note ?? "", prep: i.prep ?? "" };
      return { key: nextKey++, ...row, raw: i.raw, sig: sigOf(row), verified: !("verified" in i) || i.verified };
    });
    problem = "";
    editing = true;
  }

  function addRow() {
    // A new ingredient starts in the section of the previous one.
    rows.push({ key: nextKey++, section: rows.at(-1)?.section ?? "", amount: "", unit: "", name: "", plural: "", note: "", prep: "", raw: null, sig: "", verified: true });
  }

  function cancel() {
    if (isBlank(recipe!)) closeSheet();
    else editing = false;
  }

  async function recognize() {
    drafting = true;
    sourceHint = "";
    app.error = "";
    try {
      startEdit(await api.draftRecipe(dishId));
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      drafting = false;
    }
  }

  async function suggestUniform() {
    normalizing = true;
    sourceHint = "";
    app.error = "";
    try {
      changes = (await api.normalizeRecipe(dishId)).changes;
      keptPos = changes.map((c) => c.pos);
      confirmApply = false;
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      normalizing = false;
    }
  }

  function toggleChange(pos: number) {
    confirmApply = false;
    keptPos = keptPos.includes(pos) ? keptPos.filter((p) => p !== pos) : [...keptPos, pos];
  }

  // Replacing cannot be undone by the app, so it takes a second tap. The ticks of cook mode stay.
  async function applyUniform() {
    if (!confirmApply) return void (confirmApply = true);
    confirmApply = false;
    busy = true;
    app.error = "";
    try {
      recipe = await api.applyNormalizedRecipe(dishId, changes!.filter((c) => keptPos.includes(c.pos)));
      changes = null;
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // "Zwiebel (Mz. Zwiebeln), rot, gewürfelt": what a line becomes.
  const changedText = (c: IngredientChange) =>
    [c.to.name + (c.to.plural ? ` (Mz. ${c.to.plural})` : ""), ingredientExtra(c.to)].filter(Boolean).join(", ");
  const lineText = (pos: number) => {
    const i = recipe!.ingredients[pos]!;
    return [ingredientText(i), ingredientExtra(i)].filter(Boolean).join(", ");
  };

  // A line the AI changed or made up is marked until the user touches it.
  const suspicious = (r: Row) => !r.verified && r.sig === sigOf(r);

  // Replaces the saved original text; with one already there only after a second tap.
  async function getSource() {
    if (recipe?.source_text && !confirmReplace) return void (confirmReplace = true);
    confirmReplace = false;
    fetching = true;
    sourceHint = "";
    app.error = "";
    try {
      const r = await api.fetchSource(dishId);
      if ("reason" in r) sourceHint = "Auf der Seite wurde kein Rezept gefunden.";
      else recipe = r;
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      fetching = false;
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const sv = servings.trim() === "" ? null : Number(servings);
    if (sv !== null && (!Number.isInteger(sv) || sv < 1 || sv > 50)) return void (problem = "Portionen: eine ganze Zahl von 1 bis 50.");
    const ingredients = [];
    for (const [n, r] of rows.entries()) {
      if (!r.name.trim() && !r.amount.trim() && !r.unit && !r.note.trim() && !r.prep.trim()) continue; // empty row
      const a = parseAmount(r.amount);
      if (!a) return void (problem = `Zutat ${n + 1}: Menge wie „1,5“ oder „1-2“ eintragen.`);
      if (!r.name.trim()) return void (problem = `Zutat ${n + 1}: Bitte eine Zutat eintragen.`);
      ingredients.push({
        section: r.section.trim() || null,
        ...a,
        unit: r.unit || null,
        name: r.name.trim(),
        plural: r.plural.trim() || null,
        note: r.note.trim() || null,
        prep: r.prep.trim() || null,
        raw: r.raw !== null && r.sig === sigOf(r) ? r.raw : null,
      });
    }
    problem = "";
    busy = true;
    app.error = "";
    try {
      recipe = await api.putRecipe(dishId, { servings: sv, instructions: instructions.trim() || null, ingredients });
      if (isBlank(recipe)) startEdit();
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
      {#if draftMode}
        <p class="draft-note">
          Entwurf der KI. Bitte mit dem Originaltext unten vergleichen, bevor du speicherst: Die KI kann Zeilen weglassen oder verändern.
        </p>
      {/if}
      <label>
        Portionen (optional)
        <input type="text" inputmode="numeric" placeholder="z. B. 4" maxlength="2" bind:value={servings} autocomplete="off" />
      </label>

      <fieldset class="ingredients">
        <legend>Zutaten</legend>
        {#each rows as r, n (r.key)}
          <div class="ing-row" class:suspicious={suspicious(r)}>
            {#if suspicious(r)}<p class="ing-warn">Nicht so im Originaltext gefunden. Bitte prüfen.</p>{/if}
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
            {#if draftMode && r.raw}<small class="ing-raw">Original: {r.raw}</small>{/if}
            <details class="more" open={!!(r.plural || r.note || r.prep || r.section)}>
              <summary>Mehrzahl, Sorte, Zubereitung, Abschnitt</summary>
              <div class="ing-extra">
                <input type="text" aria-label="Mehrzahl" placeholder="Mehrzahl" maxlength="80" bind:value={r.plural} autocomplete="off" />
                <input type="text" aria-label="Sorte" placeholder="Sorte, z. B. rot" maxlength="200" bind:value={r.note} autocomplete="off" />
                <input type="text" aria-label="Zubereitung" placeholder="Zubereitung" maxlength="200" bind:value={r.prep} autocomplete="off" />
                <input type="text" aria-label="Abschnitt" placeholder="Abschnitt" maxlength="80" bind:value={r.section} autocomplete="off" />
              </div>
            </details>
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
      {#if recipe.source_text}
        <details class="source" open={draftMode}>
          <summary>Originaltext vom Link</summary>
          <p class="source-text">{recipe.source_text}</p>
        </details>
      {/if}
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <div class="actions sticky-actions">
        <button type="button" class="btn outline" onclick={cancel}>Abbrechen</button>
        <button type="submit" class="btn primary" disabled={busy}>Speichern</button>
      </div>
    </form>
  {:else}
    <article class="recipe">
      {#if isBlank(recipe)}<p class="status">Noch kein Rezept. Du kannst es aus dem Link holen oder von Hand eintragen.</p>{/if}
      {#if recipe.servings !== null}<p class="servings">{recipe.servings} {recipe.servings === 1 ? "Portion" : "Portionen"}</p>{/if}
      {#if recipe.ingredients.length}
        <h3>Zutaten</h3>
        {#each groupBySection(recipe.ingredients) as g, gi (gi)}
          {#if g.section}<h4>{g.section}</h4>{/if}
          <ul>
            {#each g.items as i, ii (ii)}
              <li>{ingredientText(i)}{#if ingredientExtra(i)}<span class="ing-note">, {ingredientExtra(i)}</span>{/if}</li>
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
      {#if recipe.source_text}
        <details class="source" open={isEmpty(recipe)}>
          <summary>{isEmpty(recipe) ? "Rezept vom Link" : "Originaltext vom Link"}</summary>
          <p class="source-text">{recipe.source_text}</p>
          {#if recipe.source_truncated}<p class="status">Der Text ist evtl. gekürzt. Bei Bedarf den vollständigen Text von Hand ergänzen.</p>{/if}
        </details>
      {/if}
    </article>
    {#if changes}
      <section class="form-group" aria-label="Vorschläge zum Vereinheitlichen">
        {#if changes.length}
          <ul class="rows shop-items">
            {#each changes as c (c.pos)}
              {@const on = keptPos.includes(c.pos)}
              <li>
                <button type="button" class="row shop-item" class:off={!on} role="checkbox" aria-checked={on} onclick={() => toggleChange(c.pos)}>
                  <span class="check" aria-hidden="true"><span class="box">{#if on}<Icon name="check" size={16} />{/if}</span></span>
                  <span class="shop-text">
                    <span class="shop-name">{changedText(c)}{#if c.unit}<span class="shop-spec">{" · "}{c.unit} → g/ml</span>{/if}</span>
                    <small>vorher: {lineText(c.pos)}</small>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
          <small class="field-hint">Die App kann das Ersetzen nicht rückgängig machen. Die Originalzeilen bleiben gespeichert.</small>
          <div class="actions">
            <button type="button" class="btn outline" onclick={() => (changes = null)}>Verwerfen</button>
            <button type="button" class="btn primary" disabled={busy || !keptPos.length} onclick={applyUniform}>
              {confirmApply ? `Wirklich ${keptPos.length} ersetzen?` : `${keptPos.length} übernehmen`}
            </button>
          </div>
        {:else}
          <p class="status" aria-live="polite">Die Zutaten sind schon einheitlich.</p>
        {/if}
      </section>
    {/if}
{#if recipe.source_text || hasLink || (ai.ai && recipe.ingredients.length && !changes)}
<section class="form-group">
    {#if ai.ai && recipe.ingredients.length && !changes}
      <button type="button" class="btn outline wide" disabled={normalizing} onclick={suggestUniform}>
        {normalizing ? "Frage KI …" : "Zutaten vereinheitlichen"}
      </button>
    {/if}
    {#if recipe.source_text}
      {#if ai.ai}
        <button type="button" class="btn primary wide" disabled={drafting} onclick={recognize}>
          {drafting ? "Erkenne Zutaten …" : "Zutaten erkennen"}
        </button>
        <small class="field-hint">Der Text wird an den KI-Dienst von Home Assistant geschickt. Du prüfst das Ergebnis, bevor es gespeichert wird.</small>
      {:else if ai.reason === "no_entity"}
        <small class="field-hint">Zum automatischen Erkennen braucht Home Assistant eine „AI Task“-Entität (Einstellungen, System, KI-Aufgaben).</small>
      {/if}
    {/if}
    {#if hasLink}
      <button type="button" class="btn outline wide" disabled={fetching} onclick={getSource}>
        {fetching ? "Hole Rezept …" : confirmReplace ? "Vorhandenen Text ersetzen?" : "Rezept aus Link holen"}
      </button>
    {/if}
    {#if sourceHint}<p class="status" aria-live="polite">{sourceHint}</p>{/if}
</section>
{/if}
    <div class="actions sticky-actions">
      <button type="button" class="btn outline" onclick={closeSheet}>Schließen</button>
      <button type="button" class="btn primary" onclick={() => startEdit()}>{isEmpty(recipe) ? "Von Hand eintragen" : "Bearbeiten"}</button>
    </div>
  {/if}
</Sheet>
