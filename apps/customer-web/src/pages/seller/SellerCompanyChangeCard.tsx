/**
 * Change control for the seller's verified company details (JOURNEY-027).
 *
 * After approval the legal name, the registration and tax numbers and the
 * registered address are what the marketplace checked. The seller proposes a
 * change here; staff approve or reject it. A change to the legal name, a
 * registration or tax number or the registered country is "material": once
 * approved, those facts are verified again.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { Badge, Button, ButtonLink, Card, ErrorState, Field, Input, LoadingState, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  COMPANY_FIELDS,
  fetchCompanyDetails,
  proposeCompanyChange,
  withdrawCompanyChange,
  type CompanyChange,
  type CompanyField,
  type CompanyValues,
} from '@/lib/seller';

const KEY = ['seller', 'company-details'] as const;

/** The fields whose change re-opens verification. Mirrors the server's list. */
const MATERIAL: ReadonlySet<CompanyField> = new Set([
  'legalName',
  'companyRegistrationNumber',
  'taxRegistrationNumber',
  'registeredCountry',
]);

function fieldLabel(field: CompanyField): TranslationKey {
  return `seller.companyChange.field.${field}` as TranslationKey;
}

function statusTone(status: CompanyChange['status']): 'warning' | 'success' | 'danger' | 'neutral' {
  if (status === 'PENDING') return 'warning';
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

function ChangeLines({ change }: { change: CompanyChange }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {(Object.keys(change.proposed) as CompanyField[]).map((field) => (
        <li key={field}>
          <span className="font-medium text-ink">{t(fieldLabel(field))}: </span>
          <span className="text-ink-muted line-through">{change.previous[field] ?? '—'}</span>{' '}
          <span className="text-ink">→ {change.proposed[field] ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
}

/** Opens the public supplier page in a new tab: what a buyer sees, nothing more. */
export function PreviewAsBuyerLink({ slug, isTrading }: { slug: string; isTrading: boolean }): React.JSX.Element {
  const { t } = useI18n();
  if (!isTrading) {
    return <p className="text-xs text-ink-muted">{t('seller.previewAsBuyer.notYet')}</p>;
  }
  return (
    <ButtonLink to={`/suppliers/${encodeURIComponent(slug)}`} target="_blank" rel="noopener" variant="secondary">
      {t('seller.previewAsBuyer.action')}
    </ButtonLink>
  );
}

export function SellerCompanyChangeCard({ canManage }: { canManage: boolean }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const details = useQuery({ queryKey: KEY, queryFn: fetchCompanyDetails });

  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawCompanyChange(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
      toast.success(t('seller.companyChange.withdrawn'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.companyChange.failed')));
    },
  });

  if (details.isPending) return <LoadingState label={t('seller.companyChange.loading')} />;
  if (details.isError) {
    return (
      <ErrorState
        error={details.error}
        onRetry={() => {
          void details.refetch();
        }}
      />
    );
  }
  // Before approval the application itself is edited; there is nothing to control yet.
  if (!details.data.changeControlled) return null;

  const { pending, history, current } = details.data;

  return (
    <Card
      title={t('seller.companyChange.title')}
      description={t('seller.companyChange.intro')}
      actions={
        canManage ? (
          <Button
            onClick={() => {
              setIsOpen(true);
            }}
          >
            {pending === null ? t('seller.companyChange.request') : t('seller.companyChange.replace')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4 px-6 py-5">
        {pending === null ? (
          <p className="text-sm text-ink-muted">{t('seller.companyChange.nonePending')}</p>
        ) : (
          <div className="rounded-md border border-border-subtle p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">{t('seller.companyChange.status.PENDING')}</Badge>
              {pending.material && <Badge tone="danger">{t('seller.companyChange.material')}</Badge>}
            </div>
            <ChangeLines change={pending} />
            {pending.material && <p className="mt-2 text-xs text-ink-muted">{t('seller.companyChange.materialHint')}</p>}
            {canManage && (
              <Button
                className="mt-3"
                variant="secondary"
                disabled={withdraw.isPending}
                onClick={() => {
                  withdraw.mutate(pending.id);
                }}
              >
                {t('seller.companyChange.withdraw')}
              </Button>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('seller.companyChange.history')}</h3>
            <ul className="mt-2 divide-y divide-border-subtle">
              {history.map((change) => (
                <li key={change.id} className="py-3">
                  <Badge tone={statusTone(change.status)}>{t(`seller.companyChange.status.${change.status}` as TranslationKey)}</Badge>
                  <ChangeLines change={change} />
                  {change.decisionReason !== null && change.status === 'REJECTED' && (
                    <p className="mt-1 text-xs text-ink-muted">{t('seller.companyChange.reason', { reason: change.decisionReason })}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {isOpen && (
        <ProposeDialog
          current={current}
          onClose={() => {
            setIsOpen(false);
          }}
        />
      )}
    </Card>
  );
}

function ProposeDialog({ current, onClose }: { current: CompanyValues; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [values, setValues] = useState<CompanyValues>(current);
  const [note, setNote] = useState('');

  const changed = COMPANY_FIELDS.filter((field) => (values[field] ?? '') !== (current[field] ?? ''));
  const material = changed.some((field) => MATERIAL.has(field));

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<CompanyValues> & { note?: string } = {};
      for (const field of changed) {
        const value = (values[field] ?? '').trim();
        body[field] = value === '' ? null : value;
      }
      if (note.trim() !== '') body.note = note.trim();
      return proposeCompanyChange(body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
      toast.success(t('seller.companyChange.sent'));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.companyChange.failed')));
    },
  });

  return (
    <Modal isOpen title={t('seller.companyChange.dialogTitle')} onClose={onClose} size="lg">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-sm text-ink-muted">{t('seller.companyChange.dialogIntro')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {COMPANY_FIELDS.map((field) => (
            <Field key={field} label={t(fieldLabel(field))}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values[field] ?? ''}
                  onChange={(event) => {
                    setValues({ ...values, [field]: event.target.value });
                  }}
                />
              )}
            </Field>
          ))}
        </div>
        <Field label={t('seller.companyChange.note')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>
        {material && <p className="text-sm text-warning">{t('seller.companyChange.materialHint')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('seller.companyChange.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={changed.length === 0 || save.isPending}>
            {t('seller.companyChange.send')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
