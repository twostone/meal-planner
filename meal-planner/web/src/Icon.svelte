<script lang="ts">
  let { name, size = 20 }: { name: "check" | "plus" | "link" | "chevron-down" | "search" | "trash"; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2.2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "check"}
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === "plus"}
    <path d="M12 5v14M5 12h14" />
  {:else if name === "link"}
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  {:else if name === "chevron-down"}
    <path d="M6 9l6 6 6-6" />
  {:else if name === "search"}
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  {:else if name === "trash"}
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  {/if}
</svg>
