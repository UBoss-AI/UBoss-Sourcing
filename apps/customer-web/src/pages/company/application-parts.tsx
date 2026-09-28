/**
 * The components the company application screens share: the form alert,
 * the country picker and the structured address block. Their logic is in
 * application-logic.ts.
 */
import { Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { countryOptions } from '@/lib/iso-countries';
import type { AddressDraft } from './application-logic';

export function FormAlert({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
      {message}
    </p>
  );
}

export function CountrySelect({
  value,
  onChange,
  invalid,
  id,
  describedBy,
}: {
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  id: string;
  describedBy: string | undefined;
}): React.JSX.Element {
  const { t, language } = useI18n();
  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      invalid={invalid === true}
      value={value}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      <option value="">{t('companyForm.chooseCountry')}</option>
      {countryOptions(language).map((option) => (
        <option key={option.code} value={option.code}>
          {option.name}
        </option>
      ))}
    </Select>
  );
}

/** One address, structured: street, city, region, postcode, country. */
export function AddressFields({
  legend,
  value,
  onChange,
  errors,
  errorPrefix,
}: {
  legend: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors: Record<string, string>;
  errorPrefix: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const set = (patch: Partial<AddressDraft>): void => {
    onChange({ ...value, ...patch });
  };
  const err = (field: string): string | undefined => errors[`${errorPrefix}.${field}`];

  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{legend}</legend>
      <Field label={t('companyForm.address.line1')} error={err('line1')} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="address-line1"
            value={value.line1}
            invalid={err('line1') !== undefined}
            onChange={(event) => {
              set({ line1: event.currentTarget.value });
            }}
          />
        )}
      </Field>
      <Field label={t('companyForm.address.line2')} error={err('line2')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="address-line2"
            value={value.line2 ?? ''}
            onChange={(event) => {
              set({ line2: event.currentTarget.value });
            }}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('companyForm.address.city')} error={err('city')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="address-level2"
              value={value.city}
              invalid={err('city') !== undefined}
              onChange={(event) => {
                set({ city: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label={t('companyForm.address.region')} error={err('region')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="address-level1"
              value={value.region ?? ''}
              onChange={(event) => {
                set({ region: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field
          label={t('companyForm.address.postalCode')}
          hint={t('companyForm.address.postalCodeHint')}
          error={err('postalCode')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="postal-code"
              value={value.postalCode ?? ''}
              invalid={err('postalCode') !== undefined}
              onChange={(event) => {
                set({ postalCode: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label={t('companyForm.address.country')} error={err('countryCode')} required>
          {({ inputId, describedBy }) => (
            <CountrySelect
              id={inputId}
              describedBy={describedBy}
              value={value.countryCode}
              invalid={err('countryCode') !== undefined}
              onChange={(code) => {
                set({ countryCode: code });
              }}
            />
          )}
        </Field>
      </div>
    </fieldset>
  );
}
