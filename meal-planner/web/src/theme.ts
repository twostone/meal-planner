// Light/dark theme. "auto" follows the device; inside Home Assistant's Ingress iframe that is the phone's or browser's
// setting, not the HA theme, so the viewer can pick one per device (stored in localStorage, never on the server).
export type Theme = "auto" | "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseTheme(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "auto";
}

export function loadTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "auto"; // storage blocked (private mode, settings): the device setting still applies
  }
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // storage blocked: the choice lasts until the page reloads, which is all we can offer
  }
  applyTheme(theme);
}

// Sets data-theme on <html> (app.css reads it) and keeps the browser bar color in step with the page background.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

// Called once before mounting, so the first frame already has the right colors.
export function initTheme(): void {
  applyTheme(loadTheme());
  // With "auto", a change of the device setting changes --bg; the bar color follows.
  matchMedia(DARK_QUERY).addEventListener("change", () => applyTheme(loadTheme()));
}
