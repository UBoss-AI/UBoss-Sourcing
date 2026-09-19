/**
 * Add or edit a delivery address.
 *
 * Used at checkout and from the account pages, so it takes an existing address
 * or none and reports back rather than deciding what happens next itself.
 *
 * The country field is a two-letter ISO code because that is what the backend
 * stores. It is labelled as such rather than being a free-text box that
 * rejects "India" after the fact.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Select } from '@/components/ui';
import { AddressSuggest } from '@/components/AddressSuggest';
import { ApiError, NetworkError, api } from '@/lib/api';
import type { Address } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

// A function of `t`: a schema built at import time would report every
// validation failure in whichever language happened to load first.
function buildSchema(t: Translate) {
  return z.object({
  label: z.string().trim().max(64),
  contactName: z.string().trim().min(1, t('addressForm.whoShouldWeAskFor')).max(255),
  contactPhone: z.string().trim().min(1, t('addressForm.phoneHelpsCourier')).max(32),
  line1: z.string().trim().min(1, t('addressForm.enterTheStreetAddress')).max(255),
  line2: z.string().trim().max(255),
  city: z.string().trim().min(1, t('addressForm.enterTheTownOrCity')).max(128),
  state: z.string().trim().min(1, t('addressForm.enterTheState')).max(128),
  postalCode: z.string().trim().min(1, t('addressForm.enterThePostcode')).max(16),
  country: z
    .string()
    .trim()
    .length(2, t('addressForm.useTheTwoLetterCode'))
    .transform((value) => value.toUpperCase()),
  kind: z.enum(['BOTH', 'SHIPPING', 'BILLING']),
  isDefaultShipping: z.boolean(),
  isDefaultBilling: z.boolean(),
  });
}

type FormValues = z.output<ReturnType<typeof buildSchema>>;

const FIELDS = [
  'label',
  'contactName',
  'contactPhone',
  'line1',
  'line2',
  'city',
  'state',
  'postalCode',
  'country',
] as const;

export function AddressForm({
  existing,
  onSaved,
  onCancel,
}: {
  existing?: Address;
  /**
   * Called with the saved address's id.
   *
   * An id rather than the address, because the API answers a create with
   * `{ addressId }` and an edit with `{ updated: true }` — it never returns
   * the record. Callers that need the whole thing read it back from the
   * address list, which this form has just invalidated.
   */
  onSaved: (addressId: string) => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: {
      label: existing?.label ?? '',
      contactName: existing?.contactName ?? '',
      contactPhone: existing?.contactPhone ?? '',
      line1: existing?.line1 ?? '',
      line2: existing?.line2 ?? '',
      city: existing?.city ?? '',
      state: existing?.state ?? '',
      postalCode: existing?.postalCode ?? '',
      country: existing?.country ?? 'IN',
      kind: existing?.kind ?? 'BOTH',
      isDefaultShipping: existing?.isDefaultShipping ?? false,
      isDefaultBilling: existing?.isDefaultBilling ?? false,
    },
  });

  /*
   * The three fields the address suggestions read.
   *
   * `line1` is the search itself; the other two narrow it, so a street typed
   * from a form that already says Antwerp and BE is not answered with one in
   * Poland. Watched rather than read from a ref because the combobox is
   * controlled - it has to re-render as the text changes.
   */
  const line1 = watch('line1');
  const city = watch('city');
  const country = watch('country');

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const body = {
        ...values,
        label: values.label === '' ? null : values.label,
        line2: values.line2 === '' ? null : values.line2,
      };

      return existing === undefined
        ? api.post<{ addressId: string }>('/account/addresses', body)
        : api
            .patch<{ updated: boolean }>(`/account/addresses/${existing.id}`, body)
            // An edit does not return an id, so the one being edited is reused.
            .then(() => ({ addressId: existing.id }));
    },
    onSuccess: async (result) => {
      // Invalidated first, so a caller that immediately looks the address up
      // in the list finds it rather than a stale cache.
      await queryClient.invalidateQueries({ queryKey: ['addresses'] });
      onSaved(result.addressId);
    },
    onError: (error) => {
      if (error instanceof NetworkError) {
        setFormError(errorMessage(t, error));
        return;
      }

      if (error instanceof ApiError) {
        // Field-level details go onto the fields; whatever did not map stays
        // in the banner, so nothing the server said is silently dropped.
        const fieldErrors = error.fieldErrors();
        let matched = 0;

        for (const [field, message] of Object.entries(fieldErrors)) {
          if (!(FIELDS as readonly string[]).includes(field)) continue;
          setError(field as (typeof FIELDS)[number], {
            type: 'server',
            message,
          });
          matched += 1;
        }

        setFormError(
          matched > 0 && matched === Object.keys(fieldErrors).length ? null : error.message,
        );
        return;
      }

      setFormError(t('addressForm.couldNotBeSaved'));
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit((values) => save.mutateAsync(values))();
      }}
    >
      {formError !== null && (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          {formError}
        </div>
      )}

      <Field
        label={t('addressForm.label')}
        hint={t('addressForm.optionalHeadOfficeSite2')}
        error={errors.label?.message}
      >
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} {...register('label')} />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('addressForm.contactName')} error={errors.contactName?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              autoComplete="name"
              aria-describedby={describedBy}
              invalid={errors.contactName !== undefined}
              {...register('contactName')}
            />
          )}
        </Field>

        <Field label={t('addressForm.contactPhone')} error={errors.contactPhone?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="tel"
              autoComplete="tel"
              aria-describedby={describedBy}
              invalid={errors.contactPhone !== undefined}
              {...register('contactPhone')}
            />
          )}
        </Field>
      </div>

      {/*
       * The street, with the real addresses matching it offered underneath.
       *
       * Why this field and not a button beside the form: a delivery address is
       * geocoded when it is saved - that is what puts a distance on each
       * fulfilment option at checkout - and it is geocoded from whatever was
       * typed. A mistyped street is a confident pin in the wrong place that
       * nobody is ever shown. Choosing from the list makes the address and its
       * position the same decision.
       *
       * Registered through `setValue` rather than `register` because this is a
       * controlled combobox: it has to read the current text to search on it.
       * `shouldValidate` so choosing a suggestion clears the error the empty
       * field was showing, the way typing into it would.
       */}
      <AddressSuggest
        endpoint="/account/addresses/geocode/suggest"
        label={t('addressForm.addressLine1')}
        hint={t('addressSuggest.hint')}
        error={errors.line1?.message}
        required
        maxLength={255}
        value={line1}
        context={[city, country].filter((part) => part.trim().length > 0).join(', ')}
        onChange={(next) => {
          setValue('line1', next, { shouldValidate: true, shouldDirty: true });
        }}
        onPick={(suggestion) => {
          /*
           * A field the geocoder did not name is left exactly as it is.
           *
           * Not cleared: a geocoder that knows the street but not the postcode
           * must not wipe a postcode somebody typed off the envelope in front
           * of them. The country is the exception that is checked rather than
           * trusted - the schema takes a two-letter code, and a suggestion
           * from a geocoder that answered with something else would fail
           * validation on submit rather than here.
           */
          const fill = (
            field: 'line1' | 'city' | 'state' | 'postalCode' | 'country',
            value: string | null,
          ): void => {
            if (value === null) return;
            setValue(field, value, { shouldValidate: true, shouldDirty: true });
          };

          fill('line1', suggestion.line1);
          fill('city', suggestion.city);
          fill('state', suggestion.region);
          fill('postalCode', suggestion.postalCode);
          fill(
            'country',
            suggestion.countryCode !== null && suggestion.countryCode.length === 2
              ? suggestion.countryCode
              : null,
          );
        }}
      />

      <Field label={t('addressForm.addressLine2')} error={errors.line2?.message}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            autoComplete="address-line2"
            aria-describedby={describedBy}
            {...register('line2')}
          />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t('addressForm.townOrCity')} error={errors.city?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              autoComplete="address-level2"
              aria-describedby={describedBy}
              invalid={errors.city !== undefined}
              {...register('city')}
            />
          )}
        </Field>

        <Field label={t('addressForm.state')} error={errors.state?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              autoComplete="address-level1"
              aria-describedby={describedBy}
              invalid={errors.state !== undefined}
              {...register('state')}
            />
          )}
        </Field>

        <Field label={t('addressForm.postcode')} error={errors.postalCode?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              autoComplete="postal-code"
              aria-describedby={describedBy}
              invalid={errors.postalCode !== undefined}
              {...register('postalCode')}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t('addressForm.countryCode')}
          hint={t('addressForm.twoLettersEGIn')}
          error={errors.country?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              autoComplete="country"
              maxLength={2}
              className="uppercase"
              aria-describedby={describedBy}
              invalid={errors.country !== undefined}
              {...register('country')}
            />
          )}
        </Field>

        <Field label={t('addressForm.useThisAddressFor')}>
          {({ inputId }) => (
            <Select id={inputId} {...register('kind')}>
              <option value="BOTH">{t('addressForm.deliveryAndBilling')}</option>
              <option value="SHIPPING">{t('addressForm.deliveryOnly')}</option>
              <option value="BILLING">{t('addressForm.billingOnly')}</option>
            </Select>
          )}
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border-strong text-brand"
            {...register('isDefaultShipping')}
          />
          {t('addressForm.useAsMyDefaultDelivery')}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border-strong text-brand"
            {...register('isDefaultBilling')}
          />
          {t('addressForm.useAsMyDefaultBilling')}
        </label>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" isLoading={isSubmitting || save.isPending}>
          {existing === undefined ? t('addressForm.saveAddress') : t('common.saveChanges')}
        </Button>
        {onCancel !== undefined && (
          <Button onClick={onCancel} disabled={save.isPending}>
            {t('addressForm.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
