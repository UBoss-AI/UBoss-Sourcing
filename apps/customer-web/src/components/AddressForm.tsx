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
import { ApiError, NetworkError, api } from '@/lib/api';
import type { Address } from '@/lib/types';

const schema = z.object({
  label: z.string().trim().max(64),
  contactName: z.string().trim().min(1, 'Who should we ask for on delivery?').max(255),
  contactPhone: z.string().trim().min(1, 'A phone number helps the courier reach you.').max(32),
  line1: z.string().trim().min(1, 'Enter the street address.').max(255),
  line2: z.string().trim().max(255),
  city: z.string().trim().min(1, 'Enter the town or city.').max(128),
  state: z.string().trim().min(1, 'Enter the state.').max(128),
  postalCode: z.string().trim().min(1, 'Enter the postcode.').max(16),
  country: z
    .string()
    .trim()
    .length(2, 'Use the two-letter country code, e.g. IN.')
    .transform((value) => value.toUpperCase()),
  kind: z.enum(['BOTH', 'SHIPPING', 'BILLING']),
  isDefaultShipping: z.boolean(),
  isDefaultBilling: z.boolean(),
});

type FormValues = z.output<typeof schema>;

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
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
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
        setFormError(error.message);
        return;
      }

      if (error instanceof ApiError) {
        // Field-level details go onto the fields; whatever did not map stays
        // in the banner, so nothing the server said is silently dropped.
        const fieldErrors = error.fieldErrors();
        let matched = 0;

        for (const [field, message] of Object.entries(fieldErrors)) {
          if (!(FIELDS as readonly string[]).includes(field)) continue;
          setError(field as (typeof FIELDS)[number], { type: 'server', message });
          matched += 1;
        }

        setFormError(matched > 0 && matched === Object.keys(fieldErrors).length ? null : error.message);
        return;
      }

      setFormError('The address could not be saved.');
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
        label="Label"
        hint="Optional — “Head office”, “Site 2”. Helps you pick the right one later."
        error={errors.label?.message}
      >
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} {...register('label')} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact name" error={errors.contactName?.message} required>
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

        <Field label="Contact phone" error={errors.contactPhone?.message} required>
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

      <Field label="Address line 1" error={errors.line1?.message} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            autoComplete="address-line1"
            aria-describedby={describedBy}
            invalid={errors.line1 !== undefined}
            {...register('line1')}
          />
        )}
      </Field>

      <Field label="Address line 2" error={errors.line2?.message}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            autoComplete="address-line2"
            aria-describedby={describedBy}
            {...register('line2')}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Town or city" error={errors.city?.message} required>
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

        <Field label="State" error={errors.state?.message} required>
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

        <Field label="Postcode" error={errors.postalCode?.message} required>
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Country code"
          hint="Two letters, e.g. IN."
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

        <Field label="Use this address for">
          {({ inputId }) => (
            <Select id={inputId} {...register('kind')}>
              <option value="BOTH">Delivery and billing</option>
              <option value="SHIPPING">Delivery only</option>
              <option value="BILLING">Billing only</option>
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
          Use as my default delivery address
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border-strong text-brand"
            {...register('isDefaultBilling')}
          />
          Use as my default billing address
        </label>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" isLoading={isSubmitting || save.isPending}>
          {existing === undefined ? 'Save address' : 'Save changes'}
        </Button>
        {onCancel !== undefined && (
          <Button onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
