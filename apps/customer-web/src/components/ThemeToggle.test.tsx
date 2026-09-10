/**
 * The appearance control, and the one rule about it that is easy to break:
 * **choosing "match my device" must not write a theme down.**
 *
 * `data-theme` is not a cache of the theme on screen. Its *absence* is what
 * hands the decision to the `@media (prefers-color-scheme: dark)` block in
 * index.css, so somebody following their device keeps following it when the
 * device changes at sunset. Stamping the resolved value would look identical in
 * every screenshot and quietly freeze them.
 *
 * The rest is what a segmented control owes a user: all three options present
 * and reachable, the one in force reporting that it is, one press to any of
 * them, and a choice made on a previous visit still in force on this one.
 *
 * **Both forms are in the DOM here, and only one is in a browser.** The
 * component renders the segmented group and the compact cycling button and
 * hides one of them with `sm:hidden` / `hidden sm:flex`; jsdom implements no
 * media queries, so nothing is hidden and every name matches twice. Hence the
 * scoping: `segment()` looks inside the group, `compact()` looks for the
 * button that is not in it. Querying the whole screen instead is what makes
 * this file fail with "found multiple elements", which is a test artefact and
 * not a duplicate control.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { ThemeToggle } from './ThemeToggle';

function renderToggle(): void {
  render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <ThemeToggle />
      </I18nextProvider>
    </ThemeProvider>,
  );
}

const DEVICE = /Match my device/;
const LIGHT = /Light theme/;
const DARK = /Dark theme/;

/** The segmented form: what a laptop gets. */
function group(): HTMLElement {
  return screen.getByRole('group', { name: 'Appearance' });
}

/** One of its three segments. They have no visible text, only a name. */
function segment(name: RegExp): HTMLElement {
  return within(group()).getByRole('button', { name });
}

/** The compact form: what a phone gets. Named by its whole sentence. */
function compact(): HTMLElement {
  return screen.getByRole('button', { name: /^Appearance:/ });
}

function stamped(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

function stored(): string | null {
  return window.localStorage.getItem('uboss.theme');
}

/**
 * The smallest stand-in for the media query the provider subscribes to:
 * `.matches`, and the two listener methods.
 */
function stubMatchMedia(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersDark,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('the appearance control', () => {
  it('offers all three options, in a group that says what they are for', () => {
    renderToggle();

    // The point of the segmented form over the cycling button it replaced: a
    // light theme is visibly on offer without pressing anything first.
    expect(within(group()).getAllByRole('button')).toHaveLength(3);
    expect(segment(DEVICE)).toBeInTheDocument();
    expect(segment(LIGHT)).toBeInTheDocument();
    expect(segment(DARK)).toBeInTheDocument();
  });

  it('starts on the device, and says which segment that is', () => {
    renderToggle();

    expect(segment(DEVICE)).toHaveAttribute('aria-pressed', 'true');
    expect(segment(LIGHT)).toHaveAttribute('aria-pressed', 'false');
    expect(segment(DARK)).toHaveAttribute('aria-pressed', 'false');

    // Nothing written. The stylesheet's media query is in charge.
    expect(stamped()).toBeNull();
    expect(stored()).toBeNull();
  });

  it('reaches either theme in one press, from either other state', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(segment(DARK));
    expect(stamped()).toBe('dark');
    expect(stored()).toBe('dark');
    expect(segment(DARK)).toHaveAttribute('aria-pressed', 'true');

    // One press, not two: this is the whole reason the cycling button stopped
    // being the only form of this control.
    await user.click(segment(LIGHT));
    expect(stamped()).toBe('light');
    expect(stored()).toBe('light');
    expect(segment(DARK)).toHaveAttribute('aria-pressed', 'false');
  });

  it('hands the decision back to the device when that segment is pressed', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(segment(DARK));
    await user.click(segment(DEVICE));

    // The attribute is *removed*, not set to whatever the machine currently
    // happens to say. Writing the resolved value here is the bug this test
    // exists for: it looks right on the day and freezes the visitor.
    expect(stamped()).toBeNull();
    expect(stored()).toBe('system');
    expect(segment(DEVICE)).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not stamp a theme when the device is the one asking for dark', () => {
    stubMatchMedia(true);
    renderToggle();

    // The page is dark — the media query in index.css is what makes it so —
    // and the control still shows the *device* segment as the selected one,
    // which is the distinction the preference exists to preserve.
    expect(stamped()).toBeNull();
    expect(segment(DEVICE)).toHaveAttribute('aria-pressed', 'true');
    expect(segment(DARK)).toHaveAttribute('aria-pressed', 'false');
  });

  it('holds a choice made on a previous visit', () => {
    window.localStorage.setItem('uboss.theme', 'dark');
    renderToggle();

    expect(stamped()).toBe('dark');
    expect(segment(DARK)).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a stored value that is not one of the three', () => {
    // Somebody else's key collision, or a half-written value. Falling back to
    // the device is the answer that cannot be wrong.
    window.localStorage.setItem('uboss.theme', 'midnight');
    renderToggle();

    expect(stamped()).toBeNull();
    expect(segment(DEVICE)).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the compact form, for a header with 44px left in it', () => {
  it('names the state it is in and says that pressing changes it', () => {
    renderToggle();

    // An icon alone cannot say either of those, and this is the only control
    // in the band with no visible label at the width it appears at.
    expect(compact()).toHaveAccessibleName(
      'Appearance: Match my device. Press to change it.',
    );
  });

  it('advances through the same three options, in the same order', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(compact());
    expect(stored()).toBe('light');

    await user.click(compact());
    expect(stored()).toBe('dark');
    expect(stamped()).toBe('dark');

    // Round the ring rather than stopping on dark, so the device option is
    // still reachable on the form that cannot show three segments.
    await user.click(compact());
    expect(stored()).toBe('system');
    expect(stamped()).toBeNull();
  });

  it('agrees with the segmented form, because there is one preference', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(segment(DARK));

    expect(compact()).toHaveAccessibleName(
      'Appearance: Dark theme. Press to change it.',
    );
  });
});
