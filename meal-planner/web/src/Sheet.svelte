<script lang="ts">
  import type { Snippet } from "svelte";
  import { app, closeSheet, dismissError } from "./store.svelte";

  let { title, children }: { title: string; children: Snippet } = $props();
  let dlg: HTMLDialogElement;

  // Native <dialog>: focus trap, Escape and inert background come for free.
  $effect(() => {
    dlg.showModal();
  });
</script>

<dialog
  bind:this={dlg}
  aria-labelledby="sheet-title"
  onclose={closeSheet}
  onclick={(e) => {
    if (e.target === dlg) dlg.close();
  }}
>
  <div class="sheet">
    <h2 id="sheet-title">{title}</h2>
    {#if app.error}
      <div class="error" role="alert">
        <span>{app.error}</span>
        <button type="button" class="link-btn" onclick={dismissError}>OK</button>
      </div>
    {/if}
    {@render children()}
  </div>
</dialog>
