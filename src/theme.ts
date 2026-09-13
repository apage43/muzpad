export type Theme = "light" | "dark";
const cache = new Map<string, string>();
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#080808" : "#ffffff");
  cache.clear();
  try {
    localStorage.setItem("muzpad-theme", theme);
  } catch {}
}
export function color(hex: string) {
  if (!cache.has(hex))
    cache.set(
      hex,
      getComputedStyle(document.documentElement)
        .getPropertyValue("--c-" + hex.slice(1))
        .trim() || hex,
    );
  return cache.get(hex)!;
}
let initial: Theme = "light";
try {
  if (localStorage.getItem("muzpad-theme") === "dark") initial = "dark";
} catch {}
setTheme(initial);
