/**
 * Who commission invoices are issued by, and how they are numbered.
 *
 * Every legal detail is typed in by the business that runs this deployment.
 * Nothing is pre-filled with an example that could end up on a real tax
 * document, and the form says which of the required details are still
 * missing - until they are set, no draft can be issued.
 *
 * Saving is versioned: two people saving at once get a "reload" rather than
 * one silently replacing the other.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button, Callout, Card, CheckboxField, Field, Input, LoadingState, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { commissionApi, type CommissionSettings } from '@/lib/commission-invoices';

const KEY = ['admin', 'commission-settings'] as const;

type Draft = Omit<CommissionSettings, 'saved' | 'missing' | 'updatedAt' | 'version'>;

function toDraft(settings: CommissionSettings): Draft {
  const draft: Partial<CommissionSettings> = { ...settings };
  delete draft.saved;
  delete draft.missing;
  delete draft.updatedAt;
  delete draft.version;
  return draft as Draft;
}

export function CommissionSettingsForm(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const mayWrite = can(Permission.COMMISSION_INVOICE_SETTINGS_WRITE);
  const query = useQuery({ queryKey: KEY, queryFn: commissionApi.settings });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (query.data !== undefined) setDraft(toDraft(query.data));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (value: Draft) => commissionApi.saveSettings({ ...value, expectedVersion: query.data?.version ?? 0 }),
    onSuccess: (saved) => {
      client.setQueryData(KEY, saved);
      // Eligibility and the issues on every draft follow the settings.
      void client.invalidateQueries({ queryKey: ['admin', 'commission-candidates'] });
      void client.invalidateQueries({ queryKey: ['admin', 'commission-invoices'] });
      void client.invalidateQueries({ queryKey: ['admin', 'commission-invoice'] });
      void client.invalidateQueries({ queryKey: ['admin', 'order-commission'] });
      toast.success(t('commission.settings.saved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (query.data === undefined || draft === null) return <LoadingState />;
  const missing = query.data.missing;

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  }
  const text = (key: keyof Draft) => ({
    value: (draft[key] as string | null) ?? '',
    disabled: !mayWrite,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      set(key, (event.target.value === '' ? null : event.target.value) as never);
    },
  });
  const label = (key: string) => t(`commission.settings.field.${key}` as TranslationKey);

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      {missing.length > 0 ? (
        <Callout tone="warning" title={t('commission.settings.incompleteTitle')}>
          {t('commission.settings.incomplete', { fields: missing.map((field) => label(field.replace('settings.', ''))).join(', ') })}
        </Callout>
      ) : (
        <Callout tone="success">{t('commission.settings.complete')}</Callout>
      )}
      <Callout tone="neutral">{t('commission.settings.taxAdvice')}</Callout>

      <Card title={t('commission.settings.entity')} description={t('commission.settings.entityHint')}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={label('legalName')} required>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('legalName')} maxLength={255} />}
          </Field>
          <Field label={label('tradeName')} hint={t('commission.settings.tradeNameHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('tradeName')} maxLength={255} />}
          </Field>
          <Field label={label('addressLine1')} required>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('addressLine1')} maxLength={255} />}
          </Field>
          <Field label={label('addressLine2')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('addressLine2')} maxLength={255} />}
          </Field>
          <Field label={label('city')} required>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('city')} maxLength={120} />}
          </Field>
          <Field label={label('region')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('region')} maxLength={120} />}
          </Field>
          <Field label={label('postcode')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('postcode')} maxLength={24} />}
          </Field>
          <Field label={label('country')} required hint={t('commission.settings.countryHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('country')} maxLength={2} className="uppercase" />}
          </Field>
          <Field label={label('businessEmail')} required>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('businessEmail')} type="email" maxLength={320} />}
          </Field>
          <Field label={label('supportContact')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('supportContact')} maxLength={160} />}
          </Field>
          <Field label={label('legalEntityCode')} hint={t('commission.settings.entityCodeHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.legalEntityCode}
                disabled={!mayWrite}
                maxLength={16}
                className="uppercase"
                onChange={(event) => {
                  set('legalEntityCode', event.target.value.toUpperCase());
                }}
              />
            )}
          </Field>
          <Field label={label('jurisdictionNote')} hint={t('commission.settings.jurisdictionHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('jurisdictionNote')} maxLength={255} />}
          </Field>
        </div>
      </Card>

      <Card title={t('commission.settings.tax')} description={t('commission.settings.taxHint')}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={label('taxRegime')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy}
                value={draft.taxRegime}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('taxRegime', event.target.value as Draft['taxRegime']);
                }}
              >
                {(['IN_GST', 'VAT', 'OTHER', 'NONE'] as const).map((regime) => (
                  <option key={regime} value={regime}>
                    {t(`commission.settings.regime.${regime}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={label('stateCode')} hint={t('commission.settings.stateCodeHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('stateCode')} maxLength={4} />}
          </Field>
          <Field label={label('taxRegistrationLabel')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.taxRegistrationLabel}
                disabled={!mayWrite}
                maxLength={32}
                onChange={(event) => {
                  set('taxRegistrationLabel', event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={label('taxRegistrationNumber')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('taxRegistrationNumber')} maxLength={32} className="uppercase" />}
          </Field>
          <Field label={label('businessIdentifierLabel')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.businessIdentifierLabel}
                disabled={!mayWrite}
                maxLength={32}
                onChange={(event) => {
                  set('businessIdentifierLabel', event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={label('businessIdentifier')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('businessIdentifier')} maxLength={32} className="uppercase" />}
          </Field>
          <Field label={label('serviceCodeLabel')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.serviceCodeLabel}
                disabled={!mayWrite}
                maxLength={16}
                onChange={(event) => {
                  set('serviceCodeLabel', event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={label('serviceCode')} hint={t('commission.settings.serviceCodeHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('serviceCode')} maxLength={16} />}
          </Field>
          <Field label={label('exportLutReference')} hint={t('commission.settings.lutHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...text('exportLutReference')} maxLength={64} />}
          </Field>
          <Field label={label('zeroTaxDocumentType')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy}
                value={draft.zeroTaxDocumentType}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('zeroTaxDocumentType', event.target.value as Draft['zeroTaxDocumentType']);
                }}
              >
                <option value="INVOICE">{t('commission.documentType.INVOICE')}</option>
                <option value="BILL_OF_SUPPLY">{t('commission.documentType.BILL_OF_SUPPLY')}</option>
              </Select>
            )}
          </Field>
          <div className="sm:col-span-2">
            <CheckboxField
              label={label('requireSellerTaxId')}
              checked={draft.requireSellerTaxId}
              disabled={!mayWrite}
              onChange={(event) => {
                set('requireSellerTaxId', event.target.checked);
              }}
            />
          </div>
        </div>
      </Card>

      <Card title={t('commission.settings.numbering')} description={t('commission.settings.numberingHint')}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={label('invoicePrefix')} hint={t('commission.settings.prefixHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.invoicePrefix}
                disabled={!mayWrite}
                maxLength={16}
                className="uppercase"
                onChange={(event) => {
                  set('invoicePrefix', event.target.value.toUpperCase());
                }}
              />
            )}
          </Field>
          <Field label={label('creditNotePrefix')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.creditNotePrefix}
                disabled={!mayWrite}
                maxLength={16}
                className="uppercase"
                onChange={(event) => {
                  set('creditNotePrefix', event.target.value.toUpperCase());
                }}
              />
            )}
          </Field>
          <Field label={label('sequencePadding')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                type="number"
                min={3}
                max={9}
                value={draft.sequencePadding}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('sequencePadding', Number(event.target.value));
                }}
              />
            )}
          </Field>
          <Field label={label('financialYearStartMonth')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                type="number"
                min={1}
                max={12}
                value={draft.financialYearStartMonth}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('financialYearStartMonth', Number(event.target.value));
                }}
              />
            )}
          </Field>
          <p className="text-sm text-ink-muted sm:col-span-2">
            {t('commission.settings.example', { number: `${draft.invoicePrefix}/2026-27/${'1'.padStart(draft.sequencePadding, '0')}` })}
          </p>
        </div>
      </Card>

      <Card title={t('commission.settings.rules')}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={label('eligibleStage')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy}
                value={draft.eligibleStage}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('eligibleStage', event.target.value as Draft['eligibleStage']);
                }}
              >
                {(['CONFIRMED', 'SHIPPED', 'DELIVERED'] as const).map((stage) => (
                  <option key={stage} value={stage}>
                    {t(`commission.settings.stage.${stage}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={label('paymentTermsDays')} hint={t('commission.settings.termsHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                type="number"
                min={0}
                max={365}
                value={draft.paymentTermsDays ?? ''}
                disabled={!mayWrite}
                onChange={(event) => {
                  set('paymentTermsDays', event.target.value === '' ? null : Number(event.target.value));
                }}
              />
            )}
          </Field>
          <Field label={label('serviceDescription')} hint={t('commission.settings.descriptionHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy}
                value={draft.serviceDescription}
                disabled={!mayWrite}
                maxLength={255}
                onChange={(event) => {
                  set('serviceDescription', event.target.value);
                }}
              />
            )}
          </Field>
          <div className="space-y-2">
            <CheckboxField
              label={label('roundGrandTotal')}
              checked={draft.roundGrandTotal}
              disabled={!mayWrite}
              onChange={(event) => {
                set('roundGrandTotal', event.target.checked);
              }}
            />
            <CheckboxField
              label={label('allowVoidAfterIssue')}
              checked={draft.allowVoidAfterIssue}
              disabled={!mayWrite}
              onChange={(event) => {
                set('allowVoidAfterIssue', event.target.checked);
              }}
            />
          </div>
          <div className="sm:col-span-2">
            <Field label={label('footerNote')}>
              {({ inputId, describedBy }) => <Textarea id={inputId} aria-describedby={describedBy} {...text('footerNote')} rows={3} maxLength={1000} />}
            </Field>
          </div>
        </div>
      </Card>

      {mayWrite && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" isLoading={save.isPending}>
            {t('commission.settings.save')}
          </Button>
        </div>
      )}
    </form>
  );
}
