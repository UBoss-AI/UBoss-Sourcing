/**
 * The frame the four signed-out screens share.
 *
 * Sign in, activate, set up a second factor, answer a challenge. All four are
 * one column on a phone and a centred card on anything wider, and none of them
 * has navigation - there is nowhere else to go until the person is through.
 *
 * The depth is deliberate and it carries information rather than decoration:
 * the card sits on a soft radial wash in the brand blue, so the eye finds the
 * one thing on the page to act on. That is the whole of the effect; nothing
 * animates and nothing moves, because half the people opening this are doing
 * it at four in the morning in a vehicle.
 *
 * ## The picture beside it
 *
 * From `lg` up the card moves to the right half and `AuthSplit` puts a turning
 * earth on the left, the same one the storefront and the admin panel sign in
 * beside. **Below `lg` nothing changes at all**, and that is the important
 * half of this: the device a driver actually opens this on is a phone in a
 * cab, and it gets the page it has always had — no canvas, no WebGL context,
 * no chunk fetched. The panel is a desk-sized flourish, it is `aria-hidden`,
 * and it is the first thing to go.
 */
import type { ReactNode } from 'react';
import { AuthSplit } from '@/components/ui/auth-split';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useI18n } from '@/i18n/i18n-context';

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
  const { t } = useI18n();

  return (
    <div className="relative flex min-h-screen flex-col bg-surface-sunken">
      {/*
        The wash. `aria-hidden` and `pointer-events-none`: it is a light
        source, not content, and it must never sit between a finger and a
        field.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,rgb(var(--bloom)/0.35),transparent_70%)]"
      />

      <header className="relative flex items-center justify-between px-4 py-4 sm:px-8">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white shadow-sm"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4.5 w-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z" strokeLinejoin="round" />
              <path d="M3 8.5 12 13l9-4.5M12 13v7" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">{t('app.name')}</span>
        </span>

        <span className="flex items-center gap-1">
          <LanguageSwitcher placement="header" />
          <ThemeToggle />
        </span>
      </header>

      {/*
        `items-start` on a phone and centred from `sm`, exactly as before. The
        split inside supplies its own gutters, so `main` keeps only the bottom
        padding that stops the card sitting on the edge of a short window.
      */}
      <main className="relative flex flex-1 flex-col justify-center pb-16 sm:pb-0">
        <AuthSplit contentClassName={wide ? 'max-w-2xl' : 'max-w-md'}>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-lg sm:p-8">
            <h1 className="text-xl font-semibold tracking-tight text-ink">{heading}</h1>
            {subheading === undefined ? null : (
              <p className="mt-1.5 text-sm text-ink-muted">{subheading}</p>
            )}

            <div className="mt-6">{children}</div>
          </div>
        </AuthSplit>
      </main>
    </div>
  );
}
