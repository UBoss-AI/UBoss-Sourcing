/**
 * The frame the four signed-out screens share.
 *
 * Sign in, activate, set up a second factor, answer a challenge. All four are
 * one column on a phone and, from `lg`, the right half of a split with a
 * turning earth on the left.
 *
 * ## It is the storefront's sign-in screen, and that is the point
 *
 * The three apps' signed-out screens used to be three screens: the storefront
 * had a language switcher above a card, the admin panel had the same card with
 * a "U" badge on it, and this portal had a heading and a subheading floating
 * above a panel with different corners, different padding and a divider at a
 * different width. Three densities of one brand system is deliberate
 * everywhere else in this codebase; three *layouts* for the same task is
 * drift, and it is the kind a person notices without being able to name it.
 *
 * So the order is now the same on all three, top to bottom:
 *
 *   1. The language switcher, in its `auth` placement, above everything. The
 *      first screen somebody lands on is the one that has to offer the way out
 *      of a language they cannot read — a setting buried inside the app is no
 *      use to them.
 *   2. `AuthCard`, holding the heading, the introduction and the form as one
 *      boundary rather than three stacked panels.
 *   3. Whatever the screen closes with.
 *   4. `TranslationQualityNotice`, which renders nothing in English.
 *
 * ## What this app keeps that the other two do not
 *
 * The header bar above the split: the mark, the product name and the theme
 * toggle. That is this app's chrome, and it stays for the same reason the
 * storefront's own header stays on `/login` — a signed-out screen is still a
 * page of the product it belongs to. The storefront gets its theme toggle from
 * `StoreLayout`; this portal has no layout above the signed-out routes, so it
 * carries its own. The LANGUAGE switcher has moved out of it and above the
 * card, where the other two put theirs.
 *
 * ## The height
 *
 * `min-h-screen` below `lg`, an exact window height from `lg` up, with the
 * overflow clipped. That is what stops the earth beside the card scrolling
 * away: a frame that IS the window has nothing under it to scroll to, and the
 * card column inside takes on the scrolling that a ten-recovery-code screen
 * actually needs. `auth-split.tsx` sets out the whole of that reasoning,
 * including the invisible `.sr-only` spans that defeated the first two
 * attempts at it.
 *
 * Nothing changes below `lg`: there is no globe there, and a driver's phone
 * gets the page it has always had.
 */
import type { ReactNode } from 'react';
import { AuthSplit } from '@/components/ui/auth-split';
import { AuthCard } from '@/components/ui/auth-form';
import { LanguageSwitcher, TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { BrandLockup } from '@/layout/BrandLockup';

export function AuthLayout({
  heading,
  subheading,
  children,
  wide = false,
}: {
  heading: string;
  subheading?: string;
  children: ReactNode;
  /** The MFA setup wizard needs room for a QR code and ten recovery codes. */
  wide?: boolean;
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-screen flex-col bg-surface-sunken lg:h-[100dvh] lg:overflow-hidden">
      {/*
        The wash. `aria-hidden` and `pointer-events-none`: it is a light
        source, not content, and it must never sit between a finger and a
        field.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,rgb(var(--bloom)/0.35),transparent_70%)]"
      />

      {/* The mark and the theme toggle only. The language switcher used to sit
          here too; it is above the card now, where the storefront and the
          admin panel put theirs. */}
      <header className="relative flex shrink-0 items-center justify-between px-4 py-4 sm:px-8">
        {/* The same component the rail carries once somebody is through, so
            the two screens cannot drift apart. See `layout/BrandLockup.tsx`. */}
        <BrandLockup />

        <ThemeToggle />
      </header>

      {/* `lg:min-h-0` is the load-bearing half of the note on the frame above:
          without it a flex child refuses to shrink below its content, the
          split pushes the column past the window, and the document scrolls
          again with the globe on board. */}
      <main className="relative flex flex-1 flex-col justify-center pb-16 sm:pb-0 lg:min-h-0">
        <AuthSplit contentClassName={wide ? 'max-w-2xl' : 'max-w-md'}>
          {/* Above the card, not tucked into a header or a footer. Somebody
              who cannot read the interface cannot navigate to a setting buried
              inside it, so the first screen they land on is the one that has
              to offer the way out. */}
          <LanguageSwitcher placement="auth" />

          {/* Title, introduction and form are one card, not three stacked
              panels: everything somebody who cannot get in needs to read is
              inside one boundary. The same card, at the same measure, with the
              same padding as the storefront's sign-in. */}
          <AuthCard className="mt-2">
            <h1 className="text-xl font-bold text-ink">{heading}</h1>
            {subheading === undefined ? null : (
              <p className="mt-2 max-w-sm text-sm text-ink-muted">{subheading}</p>
            )}

            <div className="mt-8">{children}</div>
          </AuthCard>

          {/* Sits at the bottom of the first screen somebody sees, which is
              where a wording complaint is most likely to be worth acting on.
              Renders nothing in English. */}
          <TranslationQualityNotice className="mt-5 text-center" />
        </AuthSplit>
      </main>
    </div>
  );
}
