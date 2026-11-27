<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { groupBySection, ingredientExtra, ingredientText, stepLines } from "./recipe";
  import { collectRecipe, formFrom, type RecipeForm } from "./recipe-form";
  import RecipeEditor from "./RecipeEditor.svelte";
  import Sheet from "./Sheet.svelte";
  import { app, clearToast, closeSheet, showError } from "./store.svelte";
  import type { AiStatus, IngredientChange, Recipe, RecipeDraft } from "./types";

  let { dishId }: { dishId: number } = $props();

  const dish = $derived(app.dishes.find((d) => d.id === dishId));
  let recipe = $state<Recipe | null>(null);
  let editing = $state(false);
  let loadError = $state(false);
  let form = $state<RecipeForm>(formFrom(null));
  let problem = $state("");
  let busy = $state(false);
  let fetching = $state(false);
  let confirmReplace = $state(false);
  let sourceHint = $state("");
  let ai = $state<AiStatus>({ ai: false, reason: null, image: false });
  let drafting = $state(false);
  // What "Zutaten erkennen" sends: the saved original text, editable for this one request only (never saved).
  let aiText = $derived(recipe?.source_text ?? "");
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

  // `draft`: values from the AI instead of the saved recipe (nothing is saved before "Speichern").
  function startEdit(draft?: RecipeDraft) {
    form = draft ? formFrom(draft, true) : formFrom(recipe);
    problem = "";
    editing = true;
  }

  function cancel() {
    if (isBlank(recipe!)) closeSheet();
    else editing = false;
  }

  async function recognize() {
    if (!aiText.trim() || drafting) return;
    drafting = true;
    sourceHint = "";
    clearToast();
    try {
      startEdit(await api.draftRecipeFromText(aiText));
    } catch (err) {
      showError(err);
    } finally {
      drafting = false;
    }
  }

  async function suggestUniform() {
    normalizing = true;
    sourceHint = "";
    clearToast();
    try {
      changes = (await api.normalizeRecipe(dishId)).changes;
      keptPos = changes.map((c) => c.pos);
      confirmApply = false;
    } catch (err) {
      showError(err);
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
    clearToast();
    try {
      recipe = await api.applyNormalizedRecipe(dishId, changes!.filter((c) => keptPos.includes(c.pos)));
      changes = null;
    } catch (err) {
      showError(err);
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

  // Replaces the saved original text; with one already there only after a second tap.
  async function getSource() {
    if (recipe?.source_text && !confirmReplace) return void (confirmReplace = true);
    confirmReplace = false;
    fetching = true;
    sourceHint = "";
    clearToast();
    try {
      const r = await api.fetchSource(dishId);
      if ("reason" in r) sourceHint = "Auf der Seite wurde kein Rezept gefunden.";
      else recipe = r;
    } catch (err) {
      showError(err);
    } finally {
      fetching = false;
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const checked = collectRecipe(form);
    if ("problem" in checked) return void (problem = checked.problem);
    problem = "";
    busy = true;
    clearToast();
    try {
      recipe = await api.putRecipe(dishId, checked.recipe);
      if (isBlank(recipe)) startEdit();
      else editing = false;
    } catch (err) {
      showError(err);
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
      <RecipeEditor bind:form sourceText={recipe.source_text} />
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
        <details class="source">
          <summary>Text vor dem Erkennen bearbeiten</summary>
          <textarea rows="8" maxlength="10000" aria-label="Text für die KI" bind:value={() => aiText, (v) => (aiText = v)}></textarea>
        </details>
        <button type="button" class="btn primary wide" disabled={drafting || !aiText.trim()} onclick={recognize}>
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
