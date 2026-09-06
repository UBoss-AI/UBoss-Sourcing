/**
 * "You are reading in Polish — shall we quote you in złoty?"
 *
 * Raised when the interface language points at a market the shopper is not
 * being quoted in. It is an offer and never an action: switching the language
 * of somebody who has already told us where they are must not silently change
 * what they are charged in, because the number on the page is the whole basis
 * of a purchase decision. See `LocaleProvider` for when the offer exists at
 * all — a visitor who has never answered simply starts in the language's
 * market, with no banner and nothing to accept.
 *
 * A strip under the header rather than a modal. The catalogue behind it stays
 * readable and comparable while they decide, and a shopper who wants neither
 * option can ignore it — turning it down is remembered, so it is a one-time
 * interruption at worst.
 *
 * `role="status"` rather than `alert`: nothing is wrong. A screen reader
 * should mention it at the next pause, not cut across whatever is being read.
 */
import { useState } from 'react';
import { useLocale } from '@/app/locale-context';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The country's name in the language being read.
 *
 * `Country.name` is admin-configured and stored once, in whatever language
 * staff typed it in - so a Greek reader would otherwise be offered "Greece".
 * `Intl` already knows every region name in every language we ship, and the
 * configured name is kept as the fallback for a browser that disagrees.
 */
function regionName(intlLocale: string, code: string, configured: string): string {
  try {
    return new Intl.DisplayNames([intlLocale], { type: 'region' }).of(code) ?? configured;
  } catch {
    return configured;
  }
}

export function MarketSuggestionBanner(): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();
  const locale = useLocale();

  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  const suggestion = locale.marketSuggestion;

  if (suggestion === null) return null;

  const accept = async (): Promise<void> => {
    setSwitching(true);
    setFailed(false);

    try {
      await locale.acceptSuggestion();
    } catch {
      // The save is what failed, so the prices on screen are still the old
      // ones and still correct. Say so and leave the offer up to retry.
      setFailed(true);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div role="status" className="border-b border-border bg-brand-soft">
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <p className="text-sm text-ink">
          {t('marketSuggestion.message', {
            current: locale.currency,
            country: regionName(intlLocale, suggestion.country, suggestion.countryName),
            currency: suggestion.currency,
          })}
          {failed && (
            <span className="ml-2 text-danger">{t('marketSuggestion.couldNotSwitch')}</span>
          )}
        </p>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={locale.dismissSuggestion} disabled={switching}>
            {t('marketSuggestion.keep', { current: locale.currency })}
          </Button>
          <Button onClick={() => void accept()} disabled={switching}>
            {switching
              ? t('marketSuggestion.switching')
              : t('marketSuggestion.switch', { currency: suggestion.currency })}
          </Button>
        </div>
      </div>
    </div>
  );
}
