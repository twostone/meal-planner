<script lang="ts">
  import { app, clearToast } from "./store.svelte";
</script>

<!-- Rendered by the shell and inside each sheet: a modal <dialog> sits in the top layer and would cover the shell's toast. -->
{#if app.toast}
  <div class="toast" class:info={app.toast.kind === "info"} role={app.toast.kind === "error" ? "alert" : "status"}>
    <span>{app.toast.text}</span>
    <button type="button" class="link-btn" onclick={clearToast}>OK</button>
  </div>
{/if}
