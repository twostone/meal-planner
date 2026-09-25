import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base "./": the app is served under an unknown, changing prefix by HA ingress
// (/api/hassio_ingress/<token>/), so every asset URL must be relative.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [svelte()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8099" } },
});
