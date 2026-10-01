/**
 * Trade compliance (JOURNEY-046 and JOURNEY-049): the operator's cargo
 * insurance settings, the destination and category trade rules, and the HS
 * code verification queue.
 *
 *  - Insurance: the premium rate and the most that may be insured, in basis
 *    points. A rate of 0 means sellers are not offered insurance.
 *  - Trade rules: per destination, category and HS prefix, goods may be
 *    restricted or prohibited, a document may be required from a named party,
 *    and the HS code may need verifying first. A prohibited match, a seller
 *    document not yet valid, or an unverified code holds the goods before
 *    dispatch; the override is on the order page.
 *  - HS codes: verify a seller's declared code (optionally correcting it) or
 *    reject it with a note. The seller is told either way.
 *
 * Every write is audited by the server. Each section is read-only without
 * its write permission.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

type Restriction = 'NONE' | 'RESTRICTED' | 'PROHIBITED';
type Party = 'SELLER' | 'BUYER' | 'FORWARDER' | 'OPERATOR';
const PARTIES: readonly Party[] = ['SELLER', 'BUYER', 'FORWARDER', 'OPERATOR'];
const RESTRICTIONS: readonly Restriction[] = ['NONE', 'RESTRICTED', 'PROHIBITED'];

export interface TradeRule {
  id: string;
  name: string;
  destinationCountry: string;
  category: { id: string; name: string } | null;
  hsPrefix: string;
  restriction: Restriction;
  requiredDocumentKind: string | null;
  requiredDocumentName: string | null;
  responsibleParty: Party;
  requiresHsVerification: boolean;
  documentBuyerVisible: boolean;
  note: string | null;
  isActive: boolean;
}

interface HsReview {
  offerId: string;
  sellerName: string;
  sellerSku: string;
  productName: string;
  declaredCode: string;
  countryOfOrigin: string | null;
  state: 'DECLARED' | 'VERIFIED' | 'REJECTED';
  verifiedCode: string | null;
  note: string | null;
  verifiedAt: string | null;
}

export function TradeCompliancePage(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('tradeCompliance.title')} description={t('tradeCompliance.description')} />
      <div className="space-y-5">
        <InsuranceSettingsCard />
        <TradeRulesCard />
        <HsQueueCard />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

function InsuranceSettingsCard(): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const canRead = can(Permission.LOGISTICS_READ);
  const canWrite = can(Permission.LOGISTICS_WRITE);
  const query = useQuery({
    queryKey: ['trade-settings'],
    queryFn: () =>
      api.get<{ settings: { insuranceBasisPoints: number; maxInsuredBasisPoints: number; insuranceOffered: boolean } }>(
        '/admin/logistics/trade-settings',
      ),
    enabled: canRead,
  });
  const [draft, setDraft] = useState<{ rate: string; cap: string } | null>(null);
  const settings = query.data?.settings;
  const rate = draft?.rate ?? (settings === undefined ? '' : String(settings.insuranceBasisPoints));
  const cap = draft?.cap ?? (settings === undefined ? '' : String(settings.maxInsuredBasisPoints));

  const save = useMutation({
    mutationFn: () =>
      api.put('/admin/logistics/trade-settings', {
        insuranceBasisPoints: Number.parseInt(rate, 10),
        maxInsuredBasisPoints: Number.parseInt(cap, 10),
      }),
    onSuccess: async () => {
      setDraft(null);
      toast.success(t('tradeCompliance.insurance.saved'));
      await client.invalidateQueries({ queryKey: ['trade-settings'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (!canRead) return null;
  const valid = /^\d{1,4}$/.test(rate) && /^\d{5}$/.test(cap);

  return (
    <Card title={t('tradeCompliance.insurance.title')} description={t('tradeCompliance.insurance.description')} bodyClassName="px-5 py-4">
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : (
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t('tradeCompliance.insurance.rate')} hint={t('tradeCompliance.insurance.rateHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} inputMode="numeric" value={rate} disabled={!canWrite}
                onChange={(event) => { setDraft({ rate: event.target.value, cap }); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.insurance.cap')} hint={t('tradeCompliance.insurance.capHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} inputMode="numeric" value={cap} disabled={!canWrite}
                onChange={(event) => { setDraft({ rate, cap: event.target.value }); }} />
            )}
          </Field>
          {canWrite && (
            <Button type="submit" disabled={!valid || save.isPending}>
              {t('tradeCompliance.save')}
            </Button>
          )}
          {settings !== undefined && !settings.insuranceOffered && (
            <p className="text-xs text-ink-muted sm:col-span-3">{t('tradeCompliance.insurance.off')}</p>
          )}
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trade rules
// ---------------------------------------------------------------------------

interface RuleDraft {
  name: string;
  destinationCountry: string;
  categoryId: string;
  hsPrefix: string;
  restriction: Restriction;
  requiredDocumentKind: string;
  requiredDocumentName: string;
  responsibleParty: Party;
  requiresHsVerification: boolean;
  documentBuyerVisible: boolean;
  note: string;
  isActive: boolean;
}

function ruleDraft(rule: TradeRule | null): RuleDraft {
  return {
    name: rule?.name ?? '',
    destinationCountry: rule?.destinationCountry ?? '',
    categoryId: rule?.category?.id ?? '',
    hsPrefix: rule?.hsPrefix ?? '',
    restriction: rule?.restriction ?? 'NONE',
    requiredDocumentKind: rule?.requiredDocumentKind ?? '',
    requiredDocumentName: rule?.requiredDocumentName ?? '',
    responsibleParty: rule?.responsibleParty ?? 'SELLER',
    requiresHsVerification: rule?.requiresHsVerification ?? false,
    documentBuyerVisible: rule?.documentBuyerVisible ?? true,
    note: rule?.note ?? '',
    isActive: rule?.isActive ?? true,
  };
}

function flatten(nodes: CategoryNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${' '.repeat(depth)}${node.name}` },
    ...flatten(node.children, depth + 1),
  ]);
}

function TradeRulesCard(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);
  const [editing, setEditing] = useState<TradeRule | 'new' | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(ruleDraft(null));
  const [error, setError] = useState<string | null>(null);

  const rules = useQuery({ queryKey: ['trade-rules'], queryFn: () => api.get<{ rules: TradeRule[] }>('/admin/trade-rules') });
  const categories = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
    enabled: editing !== null,
  });
  const categoryOptions = useMemo(() => flatten(categories.data?.categories ?? []), [categories.data]);

  const set = (patch: Partial<RuleDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const openEditor = (rule: TradeRule | 'new'): void => {
    setEditing(rule);
    setDraft(ruleDraft(rule === 'new' ? null : rule));
    setError(null);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        destinationCountry: draft.destinationCountry.trim(),
        categoryId: draft.categoryId === '' ? null : draft.categoryId,
        hsPrefix: draft.hsPrefix.trim(),
        restriction: draft.restriction,
        requiredDocumentKind: draft.requiredDocumentKind.trim() === '' ? null : draft.requiredDocumentKind.trim(),
        requiredDocumentName: draft.requiredDocumentName.trim() === '' ? null : draft.requiredDocumentName.trim(),
        responsibleParty: draft.responsibleParty,
        requiresHsVerification: draft.requiresHsVerification,
        documentBuyerVisible: draft.documentBuyerVisible,
        note: draft.note.trim() === '' ? null : draft.note.trim(),
        isActive: draft.isActive,
      };
      return editing === 'new' || editing === null
        ? api.post('/admin/trade-rules', body)
        : api.put(`/admin/trade-rules/${editing.id}`, body);
    },
    onSuccess: async () => {
      toast.success(t('tradeCompliance.rules.saved'));
      setEditing(null);
      await client.invalidateQueries({ queryKey: ['trade-rules'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/trade-rules/${id}`),
    onSuccess: async () => {
      toast.success(t('tradeCompliance.rules.deleted'));
      await client.invalidateQueries({ queryKey: ['trade-rules'] });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  const list = rules.data?.rules ?? [];

  return (
    <Card
      title={t('tradeCompliance.rules.title')}
      description={t('tradeCompliance.rules.description')}
      actions={canWrite ? <Button size="sm" onClick={() => { openEditor('new'); }}>{t('tradeCompliance.rules.add')}</Button> : undefined}
      bodyClassName="space-y-4 px-5 py-4"
    >
      {editing !== null && (
        <form
          className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2"
          aria-label={t('tradeCompliance.rules.add')}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {error !== null && (
            <div className="sm:col-span-2">
              <Callout tone="danger" role="alert">{error}</Callout>
            </div>
          )}
          <Field label={t('tradeCompliance.rules.name')} required>
            {({ inputId }) => (
              <Input id={inputId} value={draft.name} maxLength={160} required onChange={(event) => { set({ name: event.target.value }); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.destination')} hint={t('tradeCompliance.rules.destinationHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} value={draft.destinationCountry} maxLength={2}
                onChange={(event) => { set({ destinationCountry: event.target.value.toUpperCase() }); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.category')}>
            {({ inputId }) => (
              <Select id={inputId} value={draft.categoryId} onChange={(event) => { set({ categoryId: event.target.value }); }}>
                <option value="">{t('tradeCompliance.rules.everyCategory')}</option>
                {categoryOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.hsPrefix')} hint={t('tradeCompliance.rules.hsPrefixHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} value={draft.hsPrefix} maxLength={10} inputMode="numeric"
                onChange={(event) => { set({ hsPrefix: event.target.value }); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.restriction')}>
            {({ inputId }) => (
              <Select id={inputId} value={draft.restriction} onChange={(event) => { set({ restriction: event.target.value as Restriction }); }}>
                {RESTRICTIONS.map((value) => (
                  <option key={value} value={value}>{t(`tradeCompliance.restriction.${value}`)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.party')}>
            {({ inputId }) => (
              <Select id={inputId} value={draft.responsibleParty} onChange={(event) => { set({ responsibleParty: event.target.value as Party }); }}>
                {PARTIES.map((value) => (
                  <option key={value} value={value}>{t(`tradeCompliance.party.${value}`)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.documentKind')} hint={t('tradeCompliance.rules.documentKindHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} value={draft.requiredDocumentKind} maxLength={64}
                onChange={(event) => { set({ requiredDocumentKind: event.target.value.toUpperCase() }); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.rules.documentName')}>
            {({ inputId }) => (
              <Input id={inputId} value={draft.requiredDocumentName} maxLength={160}
                onChange={(event) => { set({ requiredDocumentName: event.target.value }); }} />
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('tradeCompliance.rules.note')}>
              {({ inputId }) => (
                <Textarea id={inputId} rows={2} maxLength={1000} value={draft.note} onChange={(event) => { set({ note: event.target.value }); }} />
              )}
            </Field>
          </div>
          <CheckboxField label={t('tradeCompliance.rules.requiresHs')} checked={draft.requiresHsVerification}
            onChange={(event) => { set({ requiresHsVerification: event.target.checked }); }} />
          <CheckboxField label={t('tradeCompliance.rules.buyerVisible')} checked={draft.documentBuyerVisible}
            onChange={(event) => { set({ documentBuyerVisible: event.target.checked }); }} />
          <CheckboxField label={t('tradeCompliance.rules.active')} checked={draft.isActive}
            onChange={(event) => { set({ isActive: event.target.checked }); }} />
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={save.isPending}>{t('tradeCompliance.save')}</Button>
            <Button type="button" variant="secondary" onClick={() => { setEditing(null); }}>{t('tradeCompliance.cancel')}</Button>
          </div>
        </form>
      )}

      {rules.isPending && <LoadingState />}
      {rules.isError && <ErrorState error={rules.error} onRetry={() => { void rules.refetch(); }} />}
      {rules.isSuccess && list.length === 0 && <EmptyState title={t('tradeCompliance.rules.empty')} />}
      {list.length > 0 && (
        <ul className="divide-y divide-line" aria-label={t('tradeCompliance.rules.title')}>
          {list.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  <span className="tabular">{rule.destinationCountry === '' ? t('tradeCompliance.rules.everywhere') : rule.destinationCountry}</span>
                  <span>{rule.name}</span>
                  {rule.restriction !== 'NONE' && (
                    <Badge tone={rule.restriction === 'PROHIBITED' ? 'danger' : 'warning'}>{t(`tradeCompliance.restriction.${rule.restriction}`)}</Badge>
                  )}
                  {rule.requiresHsVerification && <Badge tone="neutral">{t('tradeCompliance.rules.requiresHs')}</Badge>}
                  {!rule.isActive && <Badge tone="neutral">{t('tradeCompliance.rules.inactive')}</Badge>}
                </p>
                <p className="text-xs text-ink-muted">
                  {rule.category?.name ?? t('tradeCompliance.rules.everyCategory')}
                  {rule.hsPrefix !== '' && ` · HS ${rule.hsPrefix}`}
                  {rule.requiredDocumentKind !== null &&
                    ` · ${rule.requiredDocumentName ?? rule.requiredDocumentKind} · ${t(`tradeCompliance.party.${rule.responsibleParty}`)}`}
                </p>
                {rule.note !== null && <p className="text-xs text-ink-muted">{rule.note}</p>}
              </div>
              {canWrite && (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { openEditor(rule); }}>{t('tradeCompliance.edit')}</Button>
                  <Button size="sm" variant="danger" disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(t('tradeCompliance.rules.confirmDelete'))) remove.mutate(rule.id);
                    }}>
                    {t('tradeCompliance.delete')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// HS code verification queue
// ---------------------------------------------------------------------------

function HsQueueCard(): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const canRead = can(Permission.PRODUCT_READ);
  const [state, setState] = useState<HsReview['state']>('DECLARED');
  const query = useQuery({
    queryKey: ['hs-verifications', state],
    queryFn: () => api.get<{ reviews: HsReview[] }>(`/admin/hs-verifications?state=${state}`),
    enabled: canRead,
  });
  if (!canRead) return null;
  const rows = query.data?.reviews ?? [];

  return (
    <Card title={t('tradeCompliance.hs.title')} description={t('tradeCompliance.hs.description')} bodyClassName="space-y-3 px-5 py-4">
      <Field label={t('tradeCompliance.hs.filter')}>
        {({ inputId }) => (
          <Select id={inputId} className="max-w-[14rem]" value={state} onChange={(event) => { setState(event.target.value as HsReview['state']); }}>
            <option value="DECLARED">{t('tradeCompliance.hs.state.DECLARED')}</option>
            <option value="VERIFIED">{t('tradeCompliance.hs.state.VERIFIED')}</option>
            <option value="REJECTED">{t('tradeCompliance.hs.state.REJECTED')}</option>
          </Select>
        )}
      </Field>
      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />}
      {query.isSuccess && rows.length === 0 && <EmptyState title={t('tradeCompliance.hs.empty')} />}
      {rows.length > 0 && (
        <ul className="divide-y divide-line" aria-label={t('tradeCompliance.hs.title')}>
          {rows.map((row) => (
            <HsRow key={row.offerId} row={row} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function HsRow({ row }: { row: HsReview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const canDecide = can(Permission.PRODUCT_PUBLISH);
  const [corrected, setCorrected] = useState('');
  const [note, setNote] = useState('');

  const decide = useMutation({
    mutationFn: (decision: 'VERIFIED' | 'REJECTED') =>
      api.post(`/admin/hs-verifications/${row.offerId}/decision`, {
        decision,
        declaredCode: row.declaredCode,
        correctedCode: decision === 'VERIFIED' && corrected.trim() !== '' ? corrected.trim() : null,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      toast.success(t('tradeCompliance.hs.decided'));
      await client.invalidateQueries({ queryKey: ['hs-verifications'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <li className="space-y-2 py-3" data-testid={`hs-${row.offerId}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <span className="font-medium">{row.productName}</span>
        <span className="text-ink-muted">{row.sellerName} · {row.sellerSku}</span>
        <span className="tabular">HS {row.declaredCode}</span>
        {row.countryOfOrigin !== null && <span className="text-ink-muted">{row.countryOfOrigin}</span>}
        {row.verifiedCode !== null && <Badge tone="success">{t('tradeCompliance.hs.correctedTo', { code: row.verifiedCode })}</Badge>}
        {row.verifiedAt !== null && <span className="text-xs text-ink-muted">{formatDate(row.verifiedAt)}</span>}
      </p>
      {row.note !== null && <p className="text-xs text-ink-muted">{row.note}</p>}
      {canDecide && row.state === 'DECLARED' && (
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto_auto] sm:items-end">
          <Field label={t('tradeCompliance.hs.corrected')}>
            {({ inputId }) => (
              <Input id={inputId} inputMode="numeric" maxLength={10} value={corrected} onChange={(event) => { setCorrected(event.target.value); }} />
            )}
          </Field>
          <Field label={t('tradeCompliance.hs.note')} hint={t('tradeCompliance.hs.noteHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} maxLength={1000} value={note} onChange={(event) => { setNote(event.target.value); }} />
            )}
          </Field>
          <Button size="sm" disabled={decide.isPending || (corrected.trim() !== '' && !/^\d{4,10}$/.test(corrected.trim()))}
            onClick={() => { decide.mutate('VERIFIED'); }}>
            {t('tradeCompliance.hs.verify')}
          </Button>
          <Button size="sm" variant="danger" disabled={decide.isPending || note.trim() === ''}
            onClick={() => { decide.mutate('REJECTED'); }}>
            {t('tradeCompliance.hs.reject')}
          </Button>
        </div>
      )}
    </li>
  );
}
