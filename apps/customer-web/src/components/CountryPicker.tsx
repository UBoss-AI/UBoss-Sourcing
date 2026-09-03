/**
 * "Where are you ordering from?"
 *
 * Asked once, the first time a shopper signs in, because the answer decides
 * which currency every price on the site is quoted in — and this store holds a
 * real price per market rather than converting one.
 *
 * The browser's own reading is offered as a suggestion, never as the answer.
 * Two signals feed it: the time zone, which needs no permission, and precise
 * location, which the shopper can grant from the button here. Whatever they
 * pick is what gets saved, and a disagreement between the two is shown rather
 * than silently resolved — the point of keeping `detectedCountry` beside
 * `preferredCountry` on the server.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '@/app/locale-context';
import { Modal } from '@/components/Modal';
import { Button, Field, Select } from '@/components/ui';
import { detectCountry, type LocationPermission } from '@/lib/geo';

export function CountryPicker(): React.JSX.Element | null {
  const locale = useLocale();

  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [permission, setPermission] = useState<LocationPermission | null>(null);

  // Open on the suggestion, so the common case is one click.
  useEffect(() => {
    if (country === '' && locale.detectedCountry !== null) {
      setCountry(locale.detectedCountry);
    }
  }, [country, locale.detectedCountry]);

  const countryCurrency = useMemo(
    () => locale.countries.find((entry) => entry.code === country)?.currencyCode ?? '',
    [country, locale.countries],
  );

  // The currency follows the country unless the shopper overrides it.
  const effectiveCurrency = currency === '' ? countryCurrency : currency;

  if (!locale.needsChoice) return null;

  const requestPreciseLocation = async (): Promise<void> => {
    setLocating(true);
    setError(null);

    try {
      const result = await detectCountry(true);
      setPermission(result.permission);
      if (result.country !== null) {
        setCountry(result.country);
        setCurrency('');
      }
    } finally {
      setLocating(false);
    }
  };

  const save = async (): Promise<void> => {
    if (country === '') {
      setError('Choose a country to continue.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await locale.choose(country, effectiveCurrency === '' ? undefined : effectiveCurrency);
    } catch {
      setError('That could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const suggestionDiffers =
    locale.detectedCountry !== null && country !== '' && locale.detectedCountry !== country;

  return (
    <Modal
      isOpen
      onClose={locale.dismissChoice}
      title="Where are you ordering from?"
      description="Prices are shown in your country's currency. You can change this at any time from the header."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={locale.dismissChoice} disabled={saving}>
            Not now
          </Button>
          <Button onClick={() => void save()} disabled={saving || country === ''}>
            {saving ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Country" required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={country}
              onChange={(event) => {
                setCountry(event.target.value);
                setCurrency('');
              }}
            >
              <option value="">Select a country</option>
              {locale.countries.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Currency"
          hint="Defaults to your country's currency. Change it if you would rather be quoted in another."
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={effectiveCurrency}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
            >
              {locale.currencies.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} — {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="rounded-md border border-border bg-surface-sunken p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-ink-muted">
              {locale.detectedCountry === null
                ? 'We could not tell where you are.'
                : `Your browser suggests ${countryName(locale, locale.detectedCountry)}.`}
            </p>
            <Button
              variant="secondary"
              onClick={() => void requestPreciseLocation()}
              disabled={locating}
            >
              {locating ? 'Checking…' : 'Use my location'}
            </Button>
          </div>

          {permission === 'denied' && (
            <p className="mt-2 text-xs text-ink-muted">
              Location access was declined. That is fine — the country you choose above is what we
              use.
            </p>
          )}

          {suggestionDiffers && (
            <p className="mt-2 text-xs text-warning">
              Your browser suggests {countryName(locale, locale.detectedCountry ?? '')}, which does
              not match your selection. Your choice is what we will use.
            </p>
          )}
        </div>

        {error !== null && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

function countryName(locale: ReturnType<typeof useLocale>, code: string): string {
  return locale.countries.find((entry) => entry.code === code)?.name ?? code;
}
