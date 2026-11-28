<script lang="ts">
  import Icon from "./Icon.svelte";
  import { addRow, isSuspicious, MAX_INGREDIENTS, type RecipeForm } from "./recipe-form";
  import { UNITS } from "./types";

  // Only the fields: the surrounding sheet owns the <form> and the buttons (the create sheet has one form for all).
  let { form = $bindable(), sourceText }: { form: RecipeForm; sourceText: string | null } = $props();
</script>

{#if form.draft}
  <p class="draft-note">
    Entwurf der KI. Bitte mit dem Originaltext unten vergleichen, bevor du speicherst: Die KI kann Zeilen weglassen oder verändern.
  </p>
{/if}
<label>
  Portionen (optional)
  <input type="text" inputmode="numeric" placeholder="z. B. 4" maxlength="2" bind:value={form.servings} autocomplete="off" />
</label>

<fieldset class="ingredients">
  <legend>Zutaten</legend>
  {#each form.rows as r, n (r.key)}
    <div class="ing-row" class:suspicious={isSuspicious(r)}>
      {#if isSuspicious(r)}<p class="ing-warn">Nicht so im Originaltext gefunden. Bitte prüfen.</p>{/if}
      <div class="ing-main">
        <input type="text" inputmode="decimal" aria-label="Menge" placeholder="Menge" maxlength="12" bind:value={r.amount} autocomplete="off" />
        <select aria-label="Einheit" bind:value={r.unit}>
          <option value="">–</option>
          {#each UNITS as u (u)}<option value={u}>{u}</option>{/each}
        </select>
        <button type="button" class="btn ghost-danger square" aria-label="Zutat {n + 1} löschen" onclick={() => form.rows.splice(n, 1)}>
          <Icon name="trash" />
        </button>
      </div>
      <input type="text" aria-label="Zutat" placeholder="Zutat" maxlength="80" bind:value={r.name} autocomplete="off" />
      {#if form.draft && r.raw}<small class="ing-raw">Original: {r.raw}</small>{/if}
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
  {#if form.rows.length < MAX_INGREDIENTS}
    <button type="button" class="btn outline" onclick={() => addRow(form)}><Icon name="plus" /> Zutat hinzufügen</button>
  {/if}
</fieldset>

<label>
  Zubereitung
  <textarea rows="6" maxlength="10000" bind:value={form.instructions} placeholder="Ein Schritt pro Zeile, Abschnitt mit ## Überschrift"></textarea>
</label>
{#if sourceText}
  <details class="source" open={form.draft}>
    <summary>Originaltext vom Link</summary>
    <p class="source-text">{sourceText}</p>
  </details>
{/if}
