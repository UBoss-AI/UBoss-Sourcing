/**
 * Language and region — the one screen that owns the three coupled answers.
 *
 * It does not reimplement them. Country and currency go through
 * `LocaleProvider.choose`, which is what invalidates every priced query and
 * lets the server restamp the open cart, and the language goes through the i18n
 * provider, which is what persists it to the account. A second implementation
 * of "reprice the catalogue" is how a customer ends up with a header saying
 * one currency and a grid showing another.
 *
 * Why this exists at all when the header already carries a market control: the
 * header control is a compact dropdown built to be used in passing, and this
 * is where somebody who came looking for a *setting* expects to find it — with
 * room to explain what each of the three actually decides. Both write to the
 * same place.
 *
 * The three are applied together, for the same reason the header control
 * applies them together: picking "Germany" and then "euro" as two separate
 * acts reprices the whole catalogue twice and restamps the cart twice, and the
 * shopper watches two rounds of skeletons for one decision.
 */
import { useState } from 'react';
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { CountryFlag } from '@/components/CountryFlag';
import { useToast } from '@/components/toast-context';
import { Button, Field, PageHeader, Select } from '@/components/ui';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { isLanguageCode } from '@/i18n/config';
import { useI18n } from '@/i18n/i18n-context';
import { LANGUAGES } from '@/i18n/languages';
import { TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import type { LanguageCode } from '@/i18n/languages';
import { AccountPanel } from './AccountPanel';

export function RegionPage(): React.JSX.Element {
  const { t, language, setLanguage } = useI18n();
  const { business } = useStorefront();
  const locale = useLocale();
  const toast = useToast();

  useDocumentMeta(
    { title: t('account.nav.languageAndRegion'), noIndex: true },
    business.displayName,
  );

  const [country, setCountry] = useState(locale.country ?? '');
  const [currency, setCurrency] = useState(locale.currency);
  const [nextLanguage, setNextLanguage] = useState<LanguageCode>(
    isLanguageCode(language) ? language : 'en',
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The currency the chosen country uses, when this catalogue prices it. */
  const countryCurrency = (code: string): string | null => {
    const wanted = locale.countries.find((entry) => entry.code === code)?.currencyCode;
    if (wanted === undefined) return null;
    return locale.currencies.some((entry) => entry.code === wanted) ? wanted : null;
  };

  const isDirty =
    country !== (locale.country ?? '') ||
    currency !== locale.currency ||
    nextLanguage !== language;

  const apply = async (): Promise<void> => {
    setIsSaving(true);
    setError(null);

    try {
      if (nextLanguage !== language) setLanguage(nextLanguage);

      const currencyMoved = currency !== locale.currency;
      const countryMoved = country !== '' && country !== locale.country;

      if (currencyMoved || countryMoved) {
        if (country === '') await locale.setCurrency(currency);
        else await locale.choose(country, currency);

        // Every price on screen has just been requoted from the server — a
        // different price list, and a different destination's tax on top of it
        // — and the cart with them. Saying nothing about that is the most
        // expensive silence this storefront can produce.
        toast.success(
          t('market.pricesRequoted', {
            country: locale.countries.find((entry) => entry.code === country)?.name ?? country,
            currency,
          }),
        );
      } else {
        toast.success(t('region.saved'));
      }
    } catch {
      setError(t('market.thatCouldNotBeSaved'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('account.nav.languageAndRegion')}
        description={t('region.description')}
      />

      <AccountPanel title={t('region.heading')}>
        <div className="space-y-5">
          <Field label={t('market.languageLabel')} hint={t('region.languageHint')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={nextLanguage}
                onChange={(event) => {
                  const value = event.target.value;
                  // The DOM is not a type system, and a stray value must not
                  // put the app in a language that has no catalogue.
                  if (isLanguageCode(value)) setNextLanguage(value);
                }}
              >
                {/* Each option in its own language, never translated into the
                    current one: somebody stuck in a language they cannot read
                    is scanning for the shape of "Ελληνικά". */}
                {LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.endonym}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <TranslationQualityNotice />

          {locale.countries.length > 1 && (
            <Field label={t('market.countryLabel')} hint={t('region.countryHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={country}
                  onChange={(event) => {
                    const code = event.target.value;
                    setCountry(code);
                    // Choosing a country adopts that country's currency, which
                    // is what somebody selecting "Germany" means. The control
                    // below is how they say otherwise.
                    const adopted = countryCurrency(code);
                    if (adopted !== null) setCurrency(adopted);
                  }}
                >
                  {country === '' && <option value="">{t('countryPicker.selectACountry')}</option>}
                  {locale.countries.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {locale.currencies.length > 1 && (
            <Field label={t('market.currencyLabel')} hint={t('region.currencyHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                  }}
                >
                  {locale.currencies.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.symbol.trim()} {entry.code} — {entry.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {/* The honest answer to an unpriced market — staff can activate a
              country before anything is priced in the currency it uses, and
              the shopper must not be handed an empty shop for it. */}
          {country !== '' && countryCurrency(country) === null && (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm leading-relaxed text-warning">
              {t('market.currencyNotPriced', { currency })}
            </p>
          )}

          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 border-t border-border-subtle pt-4">
            <Button
              variant="primary"
              disabled={!isDirty}
              isLoading={isSaving}
              onClick={() => void apply()}
            >
              {t('common.saveChanges')}
            </Button>

            {/* What is in force now, beside the button that changes it. */}
            <span className="flex items-center gap-2 text-sm text-ink-muted">
              {locale.country !== null && (
                <CountryFlag code={locale.country} className="h-3.5 w-5" />
              )}
              {t('region.currently', { currency: locale.currency })}
            </span>
          </div>
        </div>
      </AccountPanel>
    </>
  );
}
