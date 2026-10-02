/**
 * Country / compliance rules (checklist Master row 69).
 *
 * Per destination country: what may not be sent there (BLOCK) and what may be
 * sent only to a buyer holding named documents (DOCUMENTS_REQUIRED), for a
 * category (and everything under it) or one product. A rule may carry a value
 * threshold, so it bites only on orders at or above an amount. Checkout and
 * requests for quotation refuse what a rule blocks; the storefront hides it.
 *
 * LABEL_REQUIRED (JOURNEY-064) never blocks: it states the labelling goods
 * must carry in that country, shown on the product page and at checkout.
 * Every save and delete is kept as a version; History shows them.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, CheckboxField, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDate, formatDateTime, majorToMinor, minorToMajor } from '@/lib/format';
import { Modal } from '@/components/Modal';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

export interface CountryRule {
  id: string;
  scope: 'PRODUCT' | 'CATEGORY';
  countryCode: string;
  effect: 'BLOCK' | 'DOCUMENTS_REQUIRED' | 'LABEL_REQUIRED';
  product: { id: string; slug: string; name: string } | null;
  category: { id: string; slug: string; name: string } | null;
  reason: string;
  requiredDocuments: string[];
  labelText: string | null;
  minOrderValueMinor: string | null;
  thresholdCurrency: string | null;
  source: string;
  version: string;
  ownerName: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  isActive: boolean;
}

interface Draft {
  scope: 'PRODUCT' | 'CATEGORY';
  countryCode: string;
  effect: 'BLOCK' | 'DOCUMENTS_REQUIRED' | 'LABEL_REQUIRED';
  categoryId: string;
  productSlug: string;
  reason: string;
  documents: string;
  labelText: string;
  threshold: string;
  thresholdCurrency: string;
  source: string;
  version: string;
  ownerName: string;
  effectiveFrom: string;
  effectiveUntil: string;
  isActive: boolean;
}

const today = (): string => new Date().toISOString().slice(0, 10);

function draftFrom(rule: CountryRule | null): Draft {
  const currency = rule?.thresholdCurrency ?? '';
  return {
    scope: rule?.scope ?? 'CATEGORY',
    countryCode: rule?.countryCode ?? '',
    effect: rule?.effect ?? 'BLOCK',
    categoryId: rule?.category?.id ?? '',
    productSlug: rule?.product?.slug ?? '',
    reason: rule?.reason ?? '',
    documents: (rule?.requiredDocuments ?? []).join('\n'),
    labelText: rule?.labelText ?? '',
    threshold:
      rule?.minOrderValueMinor == null ? '' : minorToMajor(rule.minOrderValueMinor, currencyExponent(currency)),
    thresholdCurrency: currency,
    source: rule?.source ?? '',
    version: rule?.version ?? '',
    ownerName: rule?.ownerName ?? '',
    effectiveFrom: (rule?.effectiveFrom ?? '').slice(0, 10) || today(),
    effectiveUntil: (rule?.effectiveUntil ?? '').slice(0, 10),
    isActive: rule?.isActive ?? true,
  };
}

function flatten(nodes: CategoryNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${' '.repeat(depth)}${node.name}` },
    ...flatten(node.children, depth + 1),
  ]);
}

export function CountryRulesPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

  const [country, setCountry] = useState('');
  const [editing, setEditing] = useState<CountryRule | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<CountryRule | null>(null);

  const rules = useQuery({
    queryKey: ['market-rules'],
    queryFn: () => api.get<{ rules: CountryRule[] }>('/admin/market-rules'),
  });
  const categories = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
    enabled: editing !== null,
  });
  const categoryOptions = useMemo(() => flatten(categories.data?.categories ?? []), [categories.data]);

  const filter = country.trim().toUpperCase();
  const shown = (rules.data?.rules ?? []).filter((rule) => filter === '' || rule.countryCode === filter);

  const open = (rule: CountryRule | 'new'): void => {
    setEditing(rule);
    setDraft(draftFrom(rule === 'new' ? null : rule));
    setError(null);
  };
  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new' || editing === null
        ? api.post('/admin/market-rules', body)
        : api.put(`/admin/market-rules/${editing.id}`, body),
    onSuccess: async () => {
      toast.success(t('countryRules.saved'));
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['market-rules'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('countryRules.saveFailed')));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/market-rules/${id}`),
    onSuccess: async () => {
      toast.success(t('countryRules.deleted'));
      await queryClient.invalidateQueries({ queryKey: ['market-rules'] });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure, t('countryRules.saveFailed')));
    },
  });

  const submit = (): void => {
    let minor: string | null = null;
    if (draft.threshold.trim() !== '') {
      minor = majorToMinor(draft.threshold, currencyExponent(draft.thresholdCurrency.trim().toUpperCase()));
      if (minor === null || draft.thresholdCurrency.trim().length !== 3) {
        setError(t('countryRules.thresholdInvalid'));
        return;
      }
    }
    setError(null);
    save.mutate({
      scope: draft.scope,
      countryCode: draft.countryCode.trim(),
      effect: draft.effect,
      categoryId: draft.scope === 'CATEGORY' ? draft.categoryId || null : null,
      productSlug: draft.scope === 'PRODUCT' ? draft.productSlug.trim() || null : null,
      reason: draft.reason.trim(),
      requiredDocuments: draft.documents
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      labelText: draft.effect === 'LABEL_REQUIRED' ? draft.labelText.trim() : null,
      minOrderValueMinor: minor,
      thresholdCurrency: minor === null ? null : draft.thresholdCurrency.trim(),
      source: draft.source.trim(),
      version: draft.version.trim(),
      ownerName: draft.ownerName.trim(),
      effectiveFrom: new Date(`${draft.effectiveFrom}T00:00:00Z`).toISOString(),
      effectiveUntil: draft.effectiveUntil === '' ? null : new Date(`${draft.effectiveUntil}T00:00:00Z`).toISOString(),
      isActive: draft.isActive,
    });
  };

  return (
    <>
      <PageHeader
        title={t('countryRules.title')}
        description={t('countryRules.description')}
        actions={
          canWrite ? (
            <Button
              onClick={() => {
                open('new');
              }}
            >
              {t('countryRules.add')}
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-5">
        {editing !== null && (
          <Card title={editing === 'new' ? t('countryRules.add') : t('countryRules.edit')} bodyClassName="space-y-4 px-5 py-4">
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {error !== null && (
                <div className="sm:col-span-2">
                  <Callout tone="danger" role="alert">
                    {error}
                  </Callout>
                </div>
              )}
              <Field label={t('countryRules.country')} hint={t('countryRules.countryHint')} required>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.countryCode} maxLength={2} required
                    onChange={(event) => { set({ countryCode: event.target.value.toUpperCase() }); }} />
                )}
              </Field>
              <Field label={t('countryRules.effect')}>
                {({ inputId }) => (
                  <Select id={inputId} value={draft.effect}
                    onChange={(event) => { set({ effect: event.target.value as Draft['effect'] }); }}>
                    <option value="BLOCK">{t('countryRules.effectBlock')}</option>
                    <option value="DOCUMENTS_REQUIRED">{t('countryRules.effectDocuments')}</option>
                    <option value="LABEL_REQUIRED">{t('countryRules.effectLabel')}</option>
                  </Select>
                )}
              </Field>
              <Field label={t('countryRules.scope')}>
                {({ inputId }) => (
                  <Select id={inputId} value={draft.scope}
                    onChange={(event) => { set({ scope: event.target.value as Draft['scope'] }); }}>
                    <option value="CATEGORY">{t('countryRules.scopeCategory')}</option>
                    <option value="PRODUCT">{t('countryRules.scopeProduct')}</option>
                  </Select>
                )}
              </Field>
              {draft.scope === 'CATEGORY' ? (
                <Field label={t('countryRules.category')} required>
                  {({ inputId }) => (
                    <Select id={inputId} value={draft.categoryId} required
                      onChange={(event) => { set({ categoryId: event.target.value }); }}>
                      <option value="">{t('countryRules.chooseCategory')}</option>
                      {categoryOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <Field label={t('countryRules.productSlug')} hint={t('countryRules.productSlugHint')} required>
                  {({ inputId, describedBy }) => (
                    <Input id={inputId} aria-describedby={describedBy} value={draft.productSlug} required
                      onChange={(event) => { set({ productSlug: event.target.value }); }} />
                  )}
                </Field>
              )}
              <div className="sm:col-span-2">
                <Field label={t('countryRules.reason')} hint={t('countryRules.reasonHint')} required>
                  {({ inputId, describedBy }) => (
                    <Textarea id={inputId} aria-describedby={describedBy} rows={2} maxLength={512} value={draft.reason} required
                      onChange={(event) => { set({ reason: event.target.value }); }} />
                  )}
                </Field>
              </div>
              {draft.effect === 'DOCUMENTS_REQUIRED' && (
                <div className="sm:col-span-2">
                  <Field label={t('countryRules.documents')} hint={t('countryRules.documentsHint')}>
                    {({ inputId, describedBy }) => (
                      <Textarea id={inputId} aria-describedby={describedBy} rows={3} value={draft.documents}
                        onChange={(event) => { set({ documents: event.target.value }); }} />
                    )}
                  </Field>
                </div>
              )}
              {draft.effect === 'LABEL_REQUIRED' && (
                <div className="sm:col-span-2">
                  <Field label={t('countryRules.labelText')} hint={t('countryRules.labelTextHint')} required>
                    {({ inputId, describedBy }) => (
                      <Textarea id={inputId} aria-describedby={describedBy} rows={3} maxLength={4000} value={draft.labelText} required
                        onChange={(event) => { set({ labelText: event.target.value }); }} />
                    )}
                  </Field>
                </div>
              )}
              <Field label={t('countryRules.threshold')} hint={t('countryRules.thresholdHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={draft.threshold}
                    onChange={(event) => { set({ threshold: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('countryRules.thresholdCurrency')}>
                {({ inputId }) => (
                  <Input id={inputId} value={draft.thresholdCurrency} maxLength={3}
                    onChange={(event) => { set({ thresholdCurrency: event.target.value.toUpperCase() }); }} />
                )}
              </Field>
              <Field label={t('countryRules.source')} hint={t('countryRules.sourceHint')} required>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.source} maxLength={255} required
                    onChange={(event) => { set({ source: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('countryRules.version')} required>
                {({ inputId }) => (
                  <Input id={inputId} value={draft.version} maxLength={32} required
                    onChange={(event) => { set({ version: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('countryRules.owner')} required>
                {({ inputId }) => (
                  <Input id={inputId} value={draft.ownerName} maxLength={160} required
                    onChange={(event) => { set({ ownerName: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('countryRules.from')} required>
                {({ inputId }) => (
                  <Input id={inputId} type="date" value={draft.effectiveFrom} required
                    onChange={(event) => { set({ effectiveFrom: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('countryRules.until')}>
                {({ inputId }) => (
                  <Input id={inputId} type="date" value={draft.effectiveUntil}
                    onChange={(event) => { set({ effectiveUntil: event.target.value }); }} />
                )}
              </Field>
              <div className="sm:col-span-2">
                <CheckboxField label={t('countryRules.active')} checked={draft.isActive}
                  onChange={(event) => { set({ isActive: event.target.checked }); }} />
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={save.isPending}>{t('countryRules.save')}</Button>
                <Button type="button" variant="secondary"
                  onClick={() => { setEditing(null); }}>
                  {t('countryRules.cancel')}
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card title={t('countryRules.listTitle')} bodyClassName="space-y-3 px-5 py-4">
          <Field label={t('countryRules.filterCountry')}>
            {({ inputId }) => (
              <Input id={inputId} className="max-w-[8rem]" value={country} maxLength={2}
                onChange={(event) => { setCountry(event.target.value); }} />
            )}
          </Field>
          {rules.isPending && <LoadingState label={t('countryRules.loading')} />}
          {rules.isError && (
            <ErrorState error={rules.error} onRetry={() => { void rules.refetch(); }} />
          )}
          {rules.isSuccess && shown.length === 0 && <EmptyState title={t('countryRules.empty')} />}
          {shown.length > 0 && (
            <ul className="divide-y divide-line" aria-label={t('countryRules.listTitle')}>
              {shown.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      <span className="tabular">{rule.countryCode}</span>
                      <Badge tone={rule.effect === 'BLOCK' ? 'danger' : rule.effect === 'LABEL_REQUIRED' ? 'accent' : 'warning'}>
                        {rule.effect === 'BLOCK'
                          ? t('countryRules.effectBlock')
                          : rule.effect === 'LABEL_REQUIRED'
                            ? t('countryRules.effectLabel')
                            : t('countryRules.effectDocuments')}
                      </Badge>
                      <span>{rule.category?.name ?? rule.product?.name ?? ''}</span>
                      {!rule.isActive && <Badge tone="neutral">{t('countryRules.inactive')}</Badge>}
                    </p>
                    <p className="text-sm text-ink-muted">{rule.reason}</p>
                    {rule.minOrderValueMinor !== null && rule.thresholdCurrency !== null && (
                      <p className="text-xs text-ink-muted">
                        {t('countryRules.thresholdShown', {
                          amount: minorToMajor(rule.minOrderValueMinor, currencyExponent(rule.thresholdCurrency)),
                          currency: rule.thresholdCurrency,
                        })}
                      </p>
                    )}
                    {rule.labelText !== null && rule.labelText !== '' && (
                      <p className="whitespace-pre-wrap text-xs text-ink-muted">{rule.labelText}</p>
                    )}
                    {rule.requiredDocuments.length > 0 && (
                      <p className="text-xs text-ink-muted">{rule.requiredDocuments.join(', ')}</p>
                    )}
                    <p className="text-xs text-ink-muted">
                      {rule.source} · {rule.version} · {rule.ownerName} · {formatDate(rule.effectiveFrom)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => { setHistoryFor(rule); }}>
                      {t('countryRules.history')}
                    </Button>
                  {canWrite && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => { open(rule); }}>
                        {t('countryRules.edit')}
                      </Button>
                      <Button size="sm" variant="danger" disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('countryRules.confirmDelete'))) remove.mutate(rule.id);
                        }}>
                        {t('countryRules.delete')}
                      </Button>
                    </div>
                  )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {historyFor !== null && (
        <RuleHistoryDialog
          rule={historyFor}
          onClose={() => {
            setHistoryFor(null);
          }}
        />
      )}
    </>
  );
}

interface RuleVersion {
  revision: number;
  changeKind: 'CREATED' | 'UPDATED' | 'DELETED';
  snapshot: { effect?: string; reason?: string; source?: string; version?: string; ownerName?: string; isActive?: boolean; labelText?: string | null };
  changedByEmail: string | null;
  changedAt: string;
}

/** Every saved version of one rule, newest first, with who changed it (JOURNEY-064). */
function RuleHistoryDialog({ rule, onClose }: { rule: CountryRule; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const history = useQuery({
    queryKey: ['market-rule-versions', rule.id],
    queryFn: () => api.get<{ versions: RuleVersion[] }>(`/admin/market-rules/${rule.id}/versions`),
  });
  return (
    <Modal isOpen onClose={onClose} title={t('countryRules.historyTitle', { country: rule.countryCode })} size="lg">
      {history.isPending && <LoadingState />}
      {history.isError && <ErrorState error={history.error} onRetry={() => { void history.refetch(); }} />}
      {history.isSuccess && history.data.versions.length === 0 && <EmptyState title={t('countryRules.historyEmpty')} />}
      {history.isSuccess && history.data.versions.length > 0 && (
        <ol className="divide-y divide-line">
          {history.data.versions.map((version) => (
            <li key={version.revision} className="space-y-1 py-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={version.changeKind === 'DELETED' ? 'danger' : 'neutral'}>
                  {t(`countryRules.change.${version.changeKind}` as TranslationKey)}
                </Badge>
                <span className="text-xs text-ink-muted">
                  {formatDateTime(version.changedAt)} · {version.changedByEmail ?? '—'}
                </span>
              </p>
              <p className="text-ink">{version.snapshot.reason}</p>
              <p className="text-xs text-ink-muted">
                {version.snapshot.source} · {version.snapshot.version} · {version.snapshot.ownerName}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
