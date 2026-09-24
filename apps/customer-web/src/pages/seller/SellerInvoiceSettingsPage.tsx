/**
 * Seller Hub -> Invoicing: how this seller's tax invoices are numbered and
 * signed.
 *
 * The invoice is the SELLER's legal document, issued in their name, so every
 * value here is theirs to state: the series, who signs, the Letter of
 * Undertaking for zero-rated exports. Nothing is defaulted into a tax number
 * they did not give. The GSTIN is shown, read-only, from the business profile,
 * because that is the one place it is kept - with the reason it would be
 * refused, when it would be.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  fetchInvoiceSettings,
  saveInvoiceSettings,
  type InvoiceJurisdiction,
  type InvoiceSettingsInput,
} from '@/lib/seller-documents';

const JURISDICTIONS: readonly InvoiceJurisdiction[] = ['IN_GST', 'EU_VAT', 'GENERIC'];

interface Draft {
  jurisdiction: InvoiceJurisdiction | '';
  invoiceSeries: string;
  creditNoteSeries: string;
  financialYearStartMonth: string;
  signatoryName: string;
  signatoryDesignation: string;
  lutReference: string;
  lutValidFrom: string;
  lutValidTo: string;
  footerNotes: string;
}

const EMPTY: Draft = {
  jurisdiction: '',
  invoiceSeries: 'INV',
  creditNoteSeries: 'CN',
  financialYearStartMonth: '4',
  signatoryName: '',
  signatoryDesignation: '',
  lutReference: '',
  lutValidFrom: '',
  lutValidTo: '',
  footerNotes: '',
};

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function SellerInvoiceSettingsPage(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['seller', 'invoice-settings'],
    queryFn: fetchInvoiceSettings,
  });
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    const settings = query.data?.settings;
    if (settings === undefined) return;
    setDraft(
      settings === null
        ? {
            ...EMPTY,
            jurisdiction: query.data?.identity.registrationCountry === 'IN' ? 'IN_GST' : '',
          }
        : {
            jurisdiction: settings.jurisdiction ?? '',
            invoiceSeries: settings.invoiceSeries,
            creditNoteSeries: settings.creditNoteSeries,
            financialYearStartMonth: String(settings.financialYearStartMonth),
            signatoryName: settings.signatoryName ?? '',
            signatoryDesignation: settings.signatoryDesignation ?? '',
            lutReference: settings.lutReference ?? '',
            lutValidFrom: settings.lutValidFrom ?? '',
            lutValidTo: settings.lutValidTo ?? '',
            footerNotes: settings.footerNotes ?? '',
          },
    );
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => {
      const input: InvoiceSettingsInput = {
        jurisdiction: draft.jurisdiction === '' ? null : draft.jurisdiction,
        invoiceSeries: draft.invoiceSeries.trim().toUpperCase(),
        creditNoteSeries: draft.creditNoteSeries.trim().toUpperCase(),
        financialYearStartMonth: Number(draft.financialYearStartMonth),
        signatoryName: blankToNull(draft.signatoryName),
        signatoryDesignation: blankToNull(draft.signatoryDesignation),
        lutReference: blankToNull(draft.lutReference),
        lutValidFrom: blankToNull(draft.lutValidFrom),
        lutValidTo: blankToNull(draft.lutValidTo),
        footerNotes: blankToNull(draft.footerNotes),
      };
      return saveInvoiceSettings(input);
    },
    onSuccess: (view) => {
      client.setQueryData(['seller', 'invoice-settings'], view);
      toast.success(t('invoiceSettings.saved'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (query.isPending) return <LoadingState label={t('invoiceSettings.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { identity } = query.data;
  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const months = Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1),
    label: new Date(Date.UTC(2026, index, 1)).toLocaleString(intlLocale, {
      month: 'long',
      timeZone: 'UTC',
    }),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={t('invoiceSettings.title')} description={t('invoiceSettings.intro')} />

      <Card title={t('invoiceSettings.identity')} bodyClassName="space-y-2 px-6 py-5">
        <p className="text-sm text-ink">{identity.legalName}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          {t('invoiceSettings.taxNumber')}:{' '}
          <span className="font-mono text-ink">
            {identity.taxRegistrationNumber ?? t('invoiceSettings.none')}
          </span>
          {identity.gstinProblem !== null && (
            <Badge tone="warning">
              {t(`invoiceSettings.gstin.${identity.gstinProblem}` as TranslationKey)}
            </Badge>
          )}
        </p>
        <p className="text-xs text-ink-muted">{t('invoiceSettings.identityHint')}</p>
      </Card>

      <Card
        title={t('invoiceSettings.numbering')}
        bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2"
      >
        <Field
          label={t('invoiceSettings.jurisdiction')}
          hint={t('invoiceSettings.jurisdictionHint')}
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={draft.jurisdiction}
              onChange={(event) => {
                set({ jurisdiction: event.currentTarget.value as Draft['jurisdiction'] });
              }}
            >
              <option value="">{t('invoiceSettings.jurisdiction.auto')}</option>
              {JURISDICTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`invoiceSettings.jurisdiction.${value}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('invoiceSettings.fyStart')} hint={t('invoiceSettings.fyStartHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={draft.financialYearStartMonth}
              onChange={(event) => {
                set({ financialYearStartMonth: event.currentTarget.value });
              }}
            >
              {months.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('invoiceSettings.invoiceSeries')}
          hint={t('invoiceSettings.invoiceSeriesHint')}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={6}
              value={draft.invoiceSeries}
              onChange={(event) => {
                set({ invoiceSeries: event.currentTarget.value.toUpperCase() });
              }}
            />
          )}
        </Field>
        <Field label={t('invoiceSettings.creditNoteSeries')} required>
          {({ inputId }) => (
            <Input
              id={inputId}
              maxLength={6}
              value={draft.creditNoteSeries}
              onChange={(event) => {
                set({ creditNoteSeries: event.currentTarget.value.toUpperCase() });
              }}
            />
          )}
        </Field>
      </Card>

      <Card
        title={t('invoiceSettings.signing')}
        bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2"
      >
        <Field label={t('invoiceSettings.signatoryName')} hint={t('invoiceSettings.signatoryHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={draft.signatoryName}
              onChange={(event) => {
                set({ signatoryName: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label={t('invoiceSettings.signatoryDesignation')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              value={draft.signatoryDesignation}
              onChange={(event) => {
                set({ signatoryDesignation: event.currentTarget.value });
              }}
            />
          )}
        </Field>
      </Card>

      <Card
        title={t('invoiceSettings.lut')}
        description={t('invoiceSettings.lutIntro')}
        bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-3"
      >
        <Field label={t('invoiceSettings.lutReference')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              value={draft.lutReference}
              onChange={(event) => {
                set({ lutReference: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label={t('invoiceSettings.lutValidFrom')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              type="date"
              value={draft.lutValidFrom}
              onChange={(event) => {
                set({ lutValidFrom: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label={t('invoiceSettings.lutValidTo')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              type="date"
              value={draft.lutValidTo}
              onChange={(event) => {
                set({ lutValidTo: event.currentTarget.value });
              }}
            />
          )}
        </Field>
      </Card>

      <Card title={t('invoiceSettings.footer')} bodyClassName="px-6 py-5">
        <Field label={t('invoiceSettings.footerNotes')} hint={t('invoiceSettings.footerHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={3}
              maxLength={1000}
              value={draft.footerNotes}
              onChange={(event) => {
                set({ footerNotes: event.currentTarget.value });
              }}
            />
          )}
        </Field>
      </Card>

      <div className="flex justify-end">
        <Button
          variant="primary"
          isLoading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('invoiceSettings.save')}
        </Button>
      </div>
    </div>
  );
}
