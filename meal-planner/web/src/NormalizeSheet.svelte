<script lang="ts">
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { ingredientExtra } from "./recipe";
  import Sheet from "./Sheet.svelte";
  import { app } from "./store.svelte";
  import type { IngredientChange } from "./types";

  // Same limits as the server (MAX_PAIRS_PER_BLOCK, MAX_NORMALIZE_CHANGES in app.ts).
  const PAIRS_PER_BLOCK = 80;
  const CHANGES_PER_APPLY = 500;

  type Row = IngredientChange & { key: string; dishes: number };

  let phase = $state<"start" | "running" | "review" | "done">("start");
  let block = $state(0);
  let blocks = $state(0);
  let rows = $state<Row[]>([]);
  let kept = $state<string[]>([]); // keys of the changes that will be applied
  let stopped = $state(""); // a block failed: what was found so far stays selectable
  let confirming = $state(false);
  let applying = $state(false);
  let result = $state("");

  const pairKey = (p: { name: string; note: string | null }) => JSON.stringify([p.name, p.note]);
  const chosen = $derived(rows.filter((r) => kept.includes(r.key)));

  // The model gets the pairs block by block, one request after the other: a single long request through the
  // Home Assistant ingress could time out.
  async function start() {
    phase = "running";
    app.error = "";
    stopped = "";
    try {
      const pairs = await api.listIngredientPairs();
      const dishes = new Map(pairs.map((p) => [pairKey(p), p.dishes]));
      blocks = Math.ceil(pairs.length / PAIRS_PER_BLOCK);
      for (block = 1; block <= blocks; block++) {
        const part = pairs.slice((block - 1) * PAIRS_PER_BLOCK, block * PAIRS_PER_BLOCK);
        try {
          const { changes } = await api.previewNormalize(part.map(({ name, note }) => ({ name, note })));
          const found = changes.map((c) => ({ ...c, key: pairKey(c.from), dishes: dishes.get(pairKey(c.from)) ?? 0 }));
          rows.push(...found);
          kept.push(...found.map((r) => r.key));
        } catch (e) {
          stopped = `Abgebrochen bei Block ${block} von ${blocks}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
      }
      phase = "review";
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
      phase = "start";
    }
  }

  function toggle(key: string) {
    confirming = false;
    kept = kept.includes(key) ? kept.filter((k) => k !== key) : [...kept, key];
  }

  // Replacing cannot be undone by the app, so it takes a second tap.
  async function apply() {
    if (!confirming) return void (confirming = true);
    confirming = false;
    applying = true;
    app.error = "";
    let changed = 0;
    try {
      for (let i = 0; i < chosen.length; i += CHANGES_PER_APPLY) {
        const part = chosen.slice(i, i + CHANGES_PER_APPLY).map(({ from, to, unit }) => ({ from, to, unit }));
        changed += (await api.applyNormalize(part)).changed;
      }
      result = `${changed} ${changed === 1 ? "Zutat" : "Zutaten"} geändert.`;
      phase = "done";
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      applying = false;
    }
  }

  // Written like in the recipe view: "Zwiebel, rot, gewürfelt".
  const before = (r: Row) => [r.from.name, r.from.note].filter(Boolean).join(", ");
  const after = (r: Row) => [r.to.name, ingredientExtra(r.to)].filter(Boolean).join(", ");
</script>

<Sheet title="Zutaten vereinheitlichen">
  {#if phase === "start"}
    <p>
      Die KI von Home Assistant schlägt für alle gespeicherten Zutaten einen einheitlichen Namen vor (Grundform, z. B. „Zwiebel“)
      und trennt Sorte und Zubereitung ab. Englische Einheiten (cup, oz) werden umgerechnet. Du siehst alle Änderungen vorher
      und kannst einzelne abwählen.
    </p>
    <p class="field-hint">
      Die App kann das Ersetzen nicht rückgängig machen. Lege vorher in Home Assistant ein Backup der App an. Die Namen und
      Hinweise gehen an den KI-Dienst von Home Assistant.
    </p>
    <div class="sticky-actions">
      <button type="button" class="btn primary wide" onclick={start}>Vorschläge holen</button>
    </div>
  {:else if phase === "running"}
    <p class="status" aria-live="polite">{blocks ? `Block ${Math.min(block, blocks)} von ${blocks} …` : "Lade Zutaten …"}</p>
  {:else if phase === "review"}
    {#if stopped}<p class="problem" role="alert">{stopped}</p>{/if}
    {#if rows.length}
      <ul class="rows shop-items">
        {#each rows as r (r.key)}
          {@const on = kept.includes(r.key)}
          <li>
            <button type="button" class="row shop-item" class:off={!on} role="checkbox" aria-checked={on} onclick={() => toggle(r.key)}>
              <span class="check" aria-hidden="true"><span class="box">{#if on}<Icon name="check" size={16} />{/if}</span></span>
              <span class="shop-text">
                <span class="shop-name">{after(r)}{#if r.unit}<span class="shop-spec">{" · "}{r.unit} → g/ml</span>{/if}</span>
                <small>vorher: {before(r)} · {r.dishes} {r.dishes === 1 ? "Gericht" : "Gerichte"}</small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="sticky-actions">
        <button type="button" class="btn primary wide" disabled={applying || !chosen.length} onclick={apply}>
          {applying ? "Ändere …" : confirming ? `Wirklich ${chosen.length} ersetzen?` : `${chosen.length} Änderungen übernehmen`}
        </button>
      </div>
    {:else if !stopped}
      <p class="empty">Alles schon einheitlich, nichts zu ändern.</p>
    {/if}
  {:else}
    <p class="status" aria-live="polite">{result}</p>
  {/if}
</Sheet>
