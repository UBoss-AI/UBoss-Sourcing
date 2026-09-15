/**
 * Resolves the theme and puts it on the `<html>` element.
 *
 * Where the answer comes from, most specific first:
 *
 *   1. A choice made in this browser (`localStorage`, `uboss.theme`).
 *   2. The operating system, via `prefers-color-scheme`.
 *
 * There is deliberately no third step and no server round trip. A theme is a
 * property of the screen somebody is looking at, not of their account: the
 * same buyer wants dark on the phone they check orders on in the evening and
 * light on the warehouse terminal, and a preference synced to the profile
 * would fight them on one of the two. It is also why this provider sits
 * outside the session — it works identically for a guest, and signing in
 * neither changes nor overwrites what the browser already knows.
 *
 * ---
 *
 * **How the choice reaches the CSS.** Absence is meaningful. `system` removes
 * `data-theme` entirely, which hands the decision to the
 * `@media (prefers-color-scheme: dark)` block in index.css; an explicit choice
 * stamps `data-theme="light"` or `"dark"`, which that media query is narrowed
 * to lose against. So the attribute is not a cache of the resolved value —
 * writing `data-theme="light"` for a visitor who is merely on a light machine
 * would freeze them there and break the sunset case this whole file exists to
 * support.
 *
 * **This panel and the storefront share the key.** Served from one origin, as
 * they are in every deployment that puts the panel under /admin, one choice
 * covers both — which is the correct behaviour for one product, and is why
 * the key is not namespaced per app.
 *
 * **First paint is handled in index.html, not here.** React mounts after the
 * first paint, so a provider is structurally incapable of preventing a white
 * flash on a dark-themed machine. The inline script in index.html stamps the
 * attribute before the document is painted; this provider adopts whatever it
 * decided and is the only thing that changes it afterwards. The two read the
 * same key and follow the same rule, and they have to stay in step — the
 * comment in index.html says so from the other side.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ThemeContext,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeState,
} from './theme-context';

/** Shared with the inline script in index.html. Change both or neither. */
const STORAGE_KEY = 'uboss.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStored(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // A private window, cleared site data, or a browser refusing storage.
    // Following the machine is the right answer when we cannot remember.
  }

  return 'system';
}

/** True when the operating system is asking for dark. */
function systemPrefersDark(): boolean {
  // jsdom has no `matchMedia` unless a test installs one, and a theme
  // provider is not worth a polyfill in every test file that mounts a page.
  if (typeof window.matchMedia !== 'function') return false;

  return window.matchMedia(DARK_QUERY).matches;
}

function resolve(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  const resolved = resolve(preference, prefersDark);

  // Follow the machine for as long as nobody has overruled it. Subscribed
  // unconditionally rather than only while `preference === 'system'`: the
  // resolved value has to be correct the instant somebody switches back to
  // `system`, and a listener attached at that moment would not fire until the
  // next sunset.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };

    query.addEventListener('change', onChange);
    // The machine may have changed between the initial read and this effect.
    setPrefersDark(query.matches);

    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  // Stamp the document. See the note at the top about why `system` removes
  // the attribute rather than writing the value it happens to resolve to.
  useEffect(() => {
    const root = document.documentElement;

    if (preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);

    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice holds for this page view only, which is better than
      // refusing to apply it.
    }
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      preference,
      resolved,
      followsSystem: preference === 'system',
      setPreference,
    }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
