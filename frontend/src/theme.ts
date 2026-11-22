/**
 * Theme variables (LLD Part 3 §2.1, §2.3).
 *
 * The adopter themes the editor through a fixed allowlist of CSS custom properties, set
 * inline on the `.odx-root` container. Nothing else is written, so a theme can't change any
 * other style of the container or of the adopter's page.
 *
 * @module
 */

/** Every CSS custom property the adopter may set through `ui.theme`. */
export const THEME_VAR_NAMES = [
  '--odx-font-family',
  '--odx-color-bg',
  '--odx-color-fg',
  '--odx-color-muted',
  '--odx-color-accent',
  '--odx-color-border',
  '--odx-color-canvas',
  '--odx-color-page',
  '--odx-color-warning',
  '--odx-color-error',
  '--odx-radius',
  '--odx-toolbar-height',
] as const;

/** The name of a theme variable (LLD Part 3 §2.1). */
export type ThemeVarName = (typeof THEME_VAR_NAMES)[number];

/** A partial theme: each key is an allow-listed variable, each value a CSS value. */
export type Theme = Partial<Record<ThemeVarName, string>>;

/**
 * Sets the allow-listed `--odx-*` variables from `theme` on `el`. Unknown keys, inherited
 * keys and non-string values are ignored. `theme` may be absent.
 */
export function applyTheme(el: HTMLElement, theme: Theme | undefined): void {
  if (theme === undefined || theme === null || typeof theme !== 'object') return;
  for (const name of THEME_VAR_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(theme, name)) continue;
    const value: unknown = theme[name];
    if (typeof value === 'string') el.style.setProperty(name, value);
  }
}
