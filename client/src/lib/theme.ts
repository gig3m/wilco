/**
 * The browser-local mirror of the theme preference, read by /theme.js
 * before the first paint (see that file). The server holds the preference;
 * this only removes the light-then-dark flash on every load.
 */
export const THEME_MIRROR_KEY = "wilco.theme";

export function rememberTheme(theme: "light" | "dark"): void {
  try {
    window.localStorage?.setItem(THEME_MIRROR_KEY, theme);
  } catch {
    // A browser that refuses storage still gets the theme, just after the fetch.
  }
}
