/**
 * Which of the two palettes the page is painted in, and who decided.
 *
 * Split from the provider so that file exports only components — React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two.
 *
 * There are three preferences and only two themes, and the distinction is the
 * whole point of the feature. `system` is not a third look: it is a standing
 * instruction to keep following the operating system, so a visitor whose
 * laptop turns dark at sunset gets a dark storefront at sunset without ever
 * having visited this setting. `light` and `dark` are a visitor overruling
 * that machine-wide setting for this site alone, which is a thing people do
 * — a warehouse office at midday, a phone in bed — and which no amount of
 * clever detection can infer.
 *
 * The consequence worth naming: `preference` and `resolved` are different
 * values and both are needed. A control has to show what was *chosen*, or
 * pressing it is a guess; a component that draws differently in dark — a map,
 * a chart, an embedded image plate — has to know what was *resolved*, because
 * "system" tells it nothing.
 */
import { createContext, useContext } from 'react';

/** What the visitor asked for. Persisted. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What is actually on screen. Never `system`. */
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeState {
  /** The stored choice. `system` until somebody changes it. */
  preference: ThemePreference;
  /** The palette in force right now, after resolving `system`. */
  resolved: ResolvedTheme;
  /** True when `preference` is `system`, i.e. the OS is still in charge. */
  followsSystem: boolean;
  /** Save a choice. Takes effect on the next paint, and persists. */
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);

  if (context === null) {
    throw new Error('useTheme must be used inside a ThemeProvider.');
  }

  return context;
}
