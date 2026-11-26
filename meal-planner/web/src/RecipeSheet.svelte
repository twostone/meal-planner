<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { domain } from "./util";
  import { groupBySection, ingredientExtra, ingredientText, stepLines } from "./recipe";
  import { collectRecipe, formFrom, type RecipeForm } from "./recipe-form";
  import RecipeEditor from "./RecipeEditor.svelte";
  import Sheet from "./Sheet.svelte";
  import { app, clearToast, openCook, openDishSheet, showError } from "./store.svelte";
  import type { AiStatus, IngredientChange, Recipe, RecipeDraft } from "./types";

  let { dishId, entryId }: { dishId: number; entryId: number | null } = $props();

  const dish = $derived(app.dishes.find((d) => d.id === dishId));
  // The entry of this dish in the current list: opened from the list it is that entry, from elsewhere the dish's own.
  const entry = $derived(app.plan?.entries.find((e) => (entryId !== null ? e.id === entryId : e.dish_id === dishId)));
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
    changes = null;
    editing = false;
  }

  async function recognize() {
    drafting = true;
    sourceHint = "";
    clearToast();
    try {
      startEdit(await api.draftRecipe(dishId));
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
      form = formFrom(recipe); // the editor shows the replaced lines
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
      editing = false;
    } catch (err) {
      showError(err);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title={dish?.title ?? "Rezept"}>
  {#if dish?.image && !editing}
    <img class="dish-hero" src={api.imageSrc(dish.image)} alt="" />
  {/if}
  {#if dish && !editing}
    <div class="dish-facts">
      {#if recipe?.servings != null}<span class="pill">{recipe.servings} {recipe.servings === 1 ? "Portion" : "Portionen"}</span>{/if}
      {#each dish.tags as t (t)}<span class="pill">{t}</span>{/each}
      {#if dish.url}
        <a class="pill link" href={dish.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} />{domain(dish.url)}</a>
      {/if}
    </div>
    {#if entry?.note}
      <p class="list-note"><small>Notiz für diese Liste</small>{entry.note}</p>
    {/if}
    {#if dish.note}<p class="dish-note">{dish.note}</p>{/if}
  {/if}

  {#if loadError}
    <p class="problem" role="alert">Rezept konnte nicht geladen werden.</p>
  {:else if !recipe}
    <p class="status">Lade …</p>
  {:else if editing}
    {@render tools()}
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
      {#if isBlank(recipe)}
        <p class="status">Noch kein Rezept.{hasLink ? " Du kannst es aus dem Link holen oder von Hand eintragen." : ""}</p>
        {#if hasLink}{@render fetchButton()}{/if}
        {#if sourceHint}<p class="status" aria-live="polite">{sourceHint}</p>{/if}
      {:else if isEmpty(recipe) && ai.ai}
        <!-- Only the text from the link so far: recognizing it is the obvious next step, so it is not hidden in the editor. -->
        {@render recognizeButton()}
      {/if}
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
    <div class="sticky-actions dish-actions">
      {#if entry}
        <button type="button" class="btn primary wide" onclick={() => openCook(entry.id)}>Jetzt kochen</button>
      {/if}
      <div class="actions">
        <button type="button" class="btn outline" onclick={() => openDishSheet({ dishId, entryId: entry?.id ?? null })}>Gericht bearbeiten</button>
        <button type="button" class="btn outline" onclick={() => startEdit()}>{isEmpty(recipe) ? "Rezept eintragen" : "Rezept bearbeiten"}</button>
      </div>
    </div>
  {/if}
</Sheet>

{#snippet recognizeButton()}
  <button type="button" class="btn primary wide" disabled={drafting} onclick={recognize}>
    {drafting ? "Erkenne Zutaten …" : "Zutaten erkennen"}
  </button>
  <small class="field-hint">Der Text wird an den KI-Dienst von Home Assistant geschickt. Du prüfst das Ergebnis, bevor es gespeichert wird.</small>
{/snippet}

{#snippet fetchButton()}
  <button type="button" class="btn outline wide" disabled={fetching} onclick={getSource}>
    {fetching ? "Hole Rezept …" : confirmReplace ? "Vorhandenen Text ersetzen?" : "Rezept aus Link holen"}
  </button>
{/snippet}

<!-- Edit mode: getting, recognizing and unifying the recipe. -->
{#snippet tools()}
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
        <small class="field-hint">Die App kann das Ersetzen nicht rückgängig machen. Die Originalzeilen bleiben gespeichert. Ungespeicherte Änderungen im Editor gehen dabei verloren.</small>
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
  {#if recipe && (recipe.source_text || hasLink || (ai.ai && recipe.ingredients.length && !changes))}
    <section class="form-group">
      {#if ai.ai && recipe.ingredients.length && !changes}
        <button type="button" class="btn outline wide" disabled={normalizing} onclick={suggestUniform}>
          {normalizing ? "Frage KI …" : "Zutaten vereinheitlichen"}
        </button>
      {/if}
      {#if recipe.source_text}
        {#if ai.ai}
          {@render recognizeButton()}
        {:else if ai.reason === "no_entity"}
          <small class="field-hint">Zum automatischen Erkennen braucht Home Assistant eine „AI Task“-Entität (Einstellungen, System, KI-Aufgaben).</small>
        {/if}
      {/if}
      {#if hasLink}{@render fetchButton()}{/if}
      {#if sourceHint}<p class="status" aria-live="polite">{sourceHint}</p>{/if}
    </section>
  {/if}
{/snippet}
