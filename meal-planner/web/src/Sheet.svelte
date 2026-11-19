<script lang="ts">
  import type { Snippet } from "svelte";
  import { closeSheet } from "./store.svelte";
  import Toast from "./Toast.svelte";

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
    <Toast />
    {@render children()}
  </div>
</dialog>
