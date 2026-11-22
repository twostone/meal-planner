import "@fontsource-variable/figtree";
import "@fontsource-variable/bricolage-grotesque";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./theme";

initTheme();

mount(App, { target: document.getElementById("app")! });
