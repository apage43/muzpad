import type { ThemeId } from "./host/contracts";

const cache = new Map<string, string>();

export function currentTheme(): ThemeId {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || theme === "soft-light" || theme === "soft-dark"
    ? theme
    : "light";
}

export function isDarkTheme(theme: string | undefined = currentTheme()): boolean {
  return theme === "dark" || theme === "soft-dark";
}

export function setTheme(theme: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = isDarkTheme(theme) ? "dark" : "light";
  cache.clear();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", color("#080808"));
}
/** Resolve a legacy hex token or a semantic CSS token for canvas rendering. */
export function color(token: string): string {
  if (!cache.has(token)) {
    const property = token.startsWith("#")
      ? "--c-" + token.slice(1)
      : token.startsWith("--")
        ? token
        : "--" + token;
    cache.set(
      token,
      getComputedStyle(document.documentElement)
        .getPropertyValue(property)
        .trim() || token,
    );
  }
  return cache.get(token)!;
}
