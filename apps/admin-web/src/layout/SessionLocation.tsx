/**
 * Where this sign-in came from — in the top bar, on every page.
 *
 * The panel already asks the browser for a position at sign-in and rings the
 * console bell with it, and both of those are aimed at colleagues: they are
 * how a sign-in nobody made becomes something somebody notices. This chip is
 * aimed at the person actually sitting there, and answers a different
 * question: *which* sign-in am I looking at?
 *
 * That question is real in this product and not in most. A self-hosted console
 * is shared by several staff accounts behind nothing but a password; the same
 * laptop gets handed around a warehouse; staff travel, and the panel silently
 * changes what it prices and what language it speaks when they do. The bell
 * said so once, at 09:04, and has been scrolled away since mid-morning. A
 * label in the chrome is what still says it at four in the afternoon.
 *
 * A label, not a control, for the same reason the market beside it is: the
 * position is what the browser reported, and a picker here would only let
 * somebody claim a place they are not in.
 *
 * It renders itself away when the browser told this session nothing — which is
 * every session in a deployment that has `FEATURE_ADMIN_LOGIN_LOCATION` off,
 * and any session behind a plain-HTTP install where there is no Geolocation
 * API to ask. An empty chip saying nothing would be worse than no chip.
 */
import { useSession } from '@/auth/session-context';
import { PinIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The first two parts of a geocoded place.
 *
 * A reverse geocoder does not answer "Pune". Nominatim answers "Shivajinagar,
 * Pune, Pune District, Maharashtra, 411005, India", and the whole of it in a
 * 16px bar would push the account menu off a laptop screen. The first two
 * parts are the neighbourhood and the city, which is the part a person reads;
 * the full string stays in the `title`, so nothing is hidden, only folded.
 *
 * The coordinate fallback — "18.5204, 73.8567" — comes through this unharmed:
 * it has exactly two parts.
 */
function shortPlace(place: string): string {
  const parts = place
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return place.trim();

  return parts.slice(0, 2).join(', ');
}

export function SessionLocation(): React.JSX.Element | null {
  const { user } = useSession();
  const { t } = useI18n();

  const place = user?.locationPlace ?? null;
  if (place === null || place.trim().length === 0) return null;

  const short = shortPlace(place);

  return (
    <span
      // The full geocoded string, and the fact that this is a sign-in rather
      // than a delivery address or a warehouse — a bare place name in an admin
      // panel full of both would be ambiguous.
      title={t('shell.signedInFrom', { place })}
      className="hidden max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs font-medium text-ink-muted md:inline-flex"
    >
      <PinIcon className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
      {/* The screen reader gets the sentence, not the fragment: "Munich,
          Bavaria" read out on its own in a top bar says nothing about what it
          is. Sighted readers have the pin and the tooltip for that. */}
      <span className="sr-only">{t('shell.signedInFrom', { place })}</span>
      <span aria-hidden="true" className="truncate">
        {short}
      </span>
    </span>
  );
}
