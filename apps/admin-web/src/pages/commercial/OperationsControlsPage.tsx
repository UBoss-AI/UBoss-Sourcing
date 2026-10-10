/**
 * Operations controls (Doc 07 s4-8, Doc 08 s9): import routes with their
 * importer and local actors, logistics provider screening, and the handling
 * requirements dispatch is checked against.
 *
 * A saved route or review goes back to review; a different person approves
 * it. A provider review never connects a carrier: a live integration still
 * needs that provider's credentials, which the badge says.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, CheckboxField, Input, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { commercialApi, HANDLING_KINDS, IMPORTER_PARTIES, REVIEW_ITEM_STATUSES, type HandlingRequirement, type ImportRoute, type LocalActor, type ProviderReview } from '@/lib/commercial-policy';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, dateInput, isoOrNull } from './format';
import { AreaField, FormDialog, RefusalCallout, SelectField, StatusBadge, Tabs, TextActionDialog, TextField } from './shared';

type OpsTab = 'routes' | 'providers' | 'handling';

interface RouteForm {
  countryCode: string;
  categoryId: string;
  channel: 'B2B' | 'B2C';
  importerParty: string;
  importerName: string;
  regulatedCategory: boolean;
  evidence: string;
  validUntil: string;
  note: string;
  localActors: LocalActor[];
}

const EMPTY_ROUTE: RouteForm = { countryCode: '', categoryId: '', channel: 'B2B', importerParty: 'BUYER', importerName: '', regulatedCategory: true, evidence: '', validUntil: '', note: '', localActors: [] };

function ImportRoutesTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [country, setCountry] = useState('');
  const filter = country.trim().length === 2 ? country.trim().toUpperCase() : undefined;
  const query = useQuery({ queryKey: ['commercial', 'import-routes', filter ?? ''], queryFn: () => commercialApi.importRoutes(filter) });
  const [form, setForm] = useState<RouteForm | null>(null);
  const [deciding, setDeciding] = useState<{ route: ImportRoute; approve: boolean } | null>(null);
  const mayWrite = can(Permission.SETTINGS_WRITE);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial', 'import-routes'] });
  };
  const edit = (r: ImportRoute): void => {
    setForm({ countryCode: r.countryCode, categoryId: r.categoryId ?? '', channel: r.channel, importerParty: r.importerParty, importerName: r.importerName ?? '', regulatedCategory: r.regulatedCategory, evidence: r.evidence ?? '', validUntil: dateInput(r.validUntil), note: r.note ?? '', localActors: r.localActorsJson });
  };
  const setActor = (index: number, patch: Partial<LocalActor>): void => {
    if (form === null) return;
    setForm({ ...form, localActors: form.localActors.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  };
  return (
    <Card title={t('commercial.ops.routes')} description={t('commercial.ops.routesBody')} actions={mayWrite ? <Button variant="primary" onClick={() => { setForm({ ...EMPTY_ROUTE }); }}>{t('commercial.ops.addRoute')}</Button> : undefined}>
      <Toolbar>
        <ToolbarField label={t('commercial.launch.country')}>
          <Input className="w-28" maxLength={2} placeholder="DE" value={country} onChange={(event) => { setCountry(event.target.value); }} />
        </ToolbarField>
      </Toolbar>
      <DataTable
        caption={t('commercial.ops.routes')}
        rows={query.data?.routes}
        rowKey={(row) => row.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => { void query.refetch(); }}
        emptyTitle={t('commercial.empty')}
        columns={[
          { key: 'country', header: t('commercial.launch.country'), render: (row) => `${row.countryCode} · ${row.channel}` },
          { key: 'category', header: t('commercial.ops.category'), secondary: true, render: (row) => row.categoryId ?? t('commercial.ops.allCategories') },
          { key: 'importer', header: t('commercial.ops.importer'), render: (row) => `${codeLabel(t, row.importerParty)}${row.importerName ? ` · ${row.importerName}` : ''}` },
          { key: 'actors', header: t('commercial.ops.localActors'), tertiary: true, render: (row) => t('commercial.ops.actorsVerified', { verified: String(row.localActorsJson.filter((a) => a.verified).length), total: String(row.localActorsJson.length) }) },
          { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
          {
            key: 'act',
            header: <span className="sr-only">{t('commercial.actions')}</span>,
            align: 'right',
            render: (row) =>
              mayWrite ? (
                <div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => { edit(row); }}>{t('common.edit')}</Button>
                  {row.status !== 'APPROVED' && <Button size="sm" onClick={() => { setDeciding({ route: row, approve: true }); }}>{t('commercial.approve')}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => { setDeciding({ route: row, approve: false }); }}>{t('commercial.reject')}</Button>
                </div>
              ) : null,
          },
        ]}
      />
      {form !== null && (
        <FormDialog
          title={t('commercial.ops.routeForm')}
          onClose={() => { setForm(null); }}
          canSave={form.countryCode.trim().length === 2 && (form.categoryId.trim() === '' || form.categoryId.trim().length === 26) && form.localActors.every((a) => a.role.trim().length >= 2 && a.name.trim().length >= 2)}
          onSave={async () => {
            await commercialApi.saveImportRoute({
              countryCode: form.countryCode.trim().toUpperCase(),
              categoryId: form.categoryId.trim() === '' ? null : form.categoryId.trim(),
              channel: form.channel,
              importerParty: form.importerParty,
              importerName: form.importerName.trim() === '' ? null : form.importerName.trim(),
              localActors: form.localActors.map((a) => ({ role: a.role.trim(), name: a.name.trim(), evidence: a.evidence.trim(), verified: a.verified })),
              regulatedCategory: form.regulatedCategory,
              evidence: form.evidence.trim() === '' ? null : form.evidence.trim(),
              validUntil: isoOrNull(form.validUntil),
              note: form.note.trim() === '' ? null : form.note.trim(),
            });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label={t('commercial.launch.country')} value={form.countryCode} onChange={(x) => { setForm({ ...form, countryCode: x }); }} required />
            <SelectField label={t('commercial.channel')} value={form.channel} onChange={(x) => { setForm({ ...form, channel: x as 'B2B' | 'B2C' }); }} options={[{ value: 'B2B', label: 'B2B' }, { value: 'B2C', label: 'B2C' }]} />
            <TextField label={t('commercial.ops.categoryId')} hint={t('commercial.ops.categoryIdHint')} value={form.categoryId} onChange={(x) => { setForm({ ...form, categoryId: x }); }} />
            <SelectField label={t('commercial.ops.importer')} value={form.importerParty} onChange={(x) => { setForm({ ...form, importerParty: x }); }} options={IMPORTER_PARTIES.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
            <TextField label={t('commercial.ops.importerName')} value={form.importerName} onChange={(x) => { setForm({ ...form, importerName: x }); }} />
            <TextField type="date" label={t('commercial.ops.validUntil')} value={form.validUntil} onChange={(x) => { setForm({ ...form, validUntil: x }); }} />
          </div>
          <CheckboxField label={t('commercial.ops.regulatedCategory')} checked={form.regulatedCategory} onChange={(event) => { setForm({ ...form, regulatedCategory: event.target.checked }); }} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">{t('commercial.ops.localActors')}</legend>
            {form.localActors.map((actor, index) => (
              <div key={index} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
                <TextField label={t('commercial.ops.actorRole')} value={actor.role} onChange={(x) => { setActor(index, { role: x }); }} required />
                <TextField label={t('commercial.ops.actorName')} value={actor.name} onChange={(x) => { setActor(index, { name: x }); }} required />
                <TextField label={t('commercial.evidence')} value={actor.evidence} onChange={(x) => { setActor(index, { evidence: x }); }} />
                <div className="flex items-end justify-between gap-2">
                  <CheckboxField label={t('commercial.ops.verified')} checked={actor.verified} onChange={(event) => { setActor(index, { verified: event.target.checked }); }} />
                  <Button size="sm" variant="ghost" onClick={() => { setForm({ ...form, localActors: form.localActors.filter((_, i) => i !== index) }); }}>{t('commercial.remove')}</Button>
                </div>
              </div>
            ))}
            <Button size="sm" onClick={() => { setForm({ ...form, localActors: [...form.localActors, { role: '', name: '', evidence: '', verified: false }] }); }}>{t('commercial.ops.addActor')}</Button>
          </fieldset>
          <AreaField label={t('commercial.evidence')} value={form.evidence} onChange={(x) => { setForm({ ...form, evidence: x }); }} />
          <AreaField label={t('commercial.note')} value={form.note} onChange={(x) => { setForm({ ...form, note: x }); }} />
        </FormDialog>
      )}
      {deciding !== null && (
        <TextActionDialog
          title={deciding.approve ? t('commercial.approve') : t('commercial.reject')}
          description={t('commercial.secondPerson')}
          label={t('commercial.note')}
          minLength={3}
          isDangerous={!deciding.approve}
          confirmLabel={deciding.approve ? t('commercial.approve') : t('commercial.reject')}
          onClose={() => { setDeciding(null); }}
          onSubmit={async (note) => {
            await commercialApi.decideImportRoute(deciding.route.id, { approve: deciding.approve, note });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
    </Card>
  );
}

interface ReviewForm {
  id?: string;
  providerName: string;
  items: Record<string, { status: string; evidence: string }>;
}

function ProviderReviewsTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'provider-reviews'], queryFn: commercialApi.providerReviews });
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mayWrite = can(Permission.LOGISTICS_WRITE);
  const items = query.data?.items ?? [];
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial', 'provider-reviews'] });
  };
  const open = (r: ProviderReview | null): void => {
    setForm({
      ...(r === null ? {} : { id: r.id }),
      providerName: r?.providerName ?? '',
      items: Object.fromEntries(items.map((key) => [key, { status: r?.itemsJson[key]?.status ?? 'PENDING', evidence: r?.itemsJson[key]?.evidence ?? '' }])),
    });
  };
  const decide = async (id: string, approve: boolean): Promise<void> => {
    setError(null);
    try {
      await commercialApi.decideProviderReview(id, approve);
      toast.success(t('commercial.saved'));
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <Card title={t('commercial.ops.providers')} description={t('commercial.ops.providersBody')} actions={mayWrite ? <Button variant="primary" onClick={() => { open(null); }}>{t('commercial.ops.recordReview')}</Button> : undefined}>
      {error !== null && <div className="px-4 pt-4"><RefusalCallout error={error} /></div>}
      <DataTable
        caption={t('commercial.ops.providers')}
        rows={query.data?.reviews}
        rowKey={(row) => row.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => { void query.refetch(); }}
        emptyTitle={t('commercial.empty')}
        columns={[
          { key: 'name', header: t('commercial.ops.provider'), render: (row) => row.providerName },
          { key: 'items', header: t('commercial.ops.itemsVerified'), align: 'right', render: (row) => `${String(Object.values(row.itemsJson).filter((i) => i.status === 'VERIFIED' || i.status === 'NOT_APPLICABLE').length)} / ${String(items.length)}` },
          { key: 'integration', header: t('commercial.ops.integration'), render: (row) => (row.integrationStatus === 'CREDENTIALS_REQUIRED' ? <Badge tone="warning">{t('commercial.ops.credentialsRequired')}</Badge> : codeLabel(t, row.integrationStatus)) },
          { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
          { key: 'next', header: t('commercial.ops.nextReview'), tertiary: true, render: (row) => formatDate(row.nextReviewAt) },
          {
            key: 'act',
            header: <span className="sr-only">{t('commercial.actions')}</span>,
            align: 'right',
            render: (row) =>
              mayWrite ? (
                <div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => { open(row); }}>{t('common.edit')}</Button>
                  <Button size="sm" onClick={() => { void decide(row.id, true); }}>{t('commercial.approve')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { void decide(row.id, false); }}>{t('commercial.reject')}</Button>
                </div>
              ) : null,
          },
        ]}
      />
      {form !== null && (
        <FormDialog
          title={t('commercial.ops.recordReview')}
          onClose={() => { setForm(null); }}
          canSave={form.providerName.trim().length >= 2}
          onSave={async () => {
            await commercialApi.saveProviderReview({
              ...(form.id === undefined ? {} : { id: form.id }),
              providerName: form.providerName.trim(),
              items: Object.fromEntries(Object.entries(form.items).map(([k, v]) => [k, { status: v.status, evidence: v.evidence.trim() === '' ? null : v.evidence.trim() }])),
            });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <TextField label={t('commercial.ops.provider')} value={form.providerName} onChange={(x) => { setForm({ ...form, providerName: x }); }} required />
          {Object.entries(form.items).map(([key, value]) => (
            <div key={key} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[12rem_1fr]">
              <label className="block">
                <span className="text-sm font-medium text-ink">{codeLabel(t, key)}</span>
                <Select className="mt-1.5" value={value.status} onChange={(event) => { setForm({ ...form, items: { ...form.items, [key]: { ...value, status: event.target.value } } }); }}>
                  {REVIEW_ITEM_STATUSES.map((s) => (
                    <option key={s} value={s}>{codeLabel(t, s)}</option>
                  ))}
                </Select>
              </label>
              <TextField label={t('commercial.evidence')} value={value.evidence} onChange={(x) => { setForm({ ...form, items: { ...form.items, [key]: { ...value, evidence: x } } }); }} />
            </div>
          ))}
        </FormDialog>
      )}
    </Card>
  );
}

function HandlingTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'handling'], queryFn: commercialApi.handling });
  const [form, setForm] = useState<{ id?: string; kind: string; categoryId: string; destinationCountry: string; requiredEvidence: string; isActive: boolean } | null>(null);
  const open = (r: HandlingRequirement | null): void => {
    setForm({ ...(r === null ? {} : { id: r.id }), kind: r?.kind ?? 'DANGEROUS_GOODS', categoryId: r?.categoryId ?? '', destinationCountry: r?.destinationCountry ?? '', requiredEvidence: r?.requiredEvidence ?? '', isActive: r?.isActive ?? true });
  };
  return (
    <Card title={t('commercial.ops.handling')} description={t('commercial.ops.handlingBody')} actions={can(Permission.LOGISTICS_WRITE) ? <Button variant="primary" onClick={() => { open(null); }}>{t('commercial.ops.addRequirement')}</Button> : undefined}>
      <DataTable
        caption={t('commercial.ops.handling')}
        rows={query.data?.requirements}
        rowKey={(row) => row.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => { void query.refetch(); }}
        emptyTitle={t('commercial.empty')}
        columns={[
          { key: 'kind', header: t('commercial.kindLabel'), render: (row) => codeLabel(t, row.kind) },
          { key: 'country', header: t('commercial.launch.country'), render: (row) => row.destinationCountry ?? t('commercial.allCountries') },
          { key: 'evidence', header: t('commercial.ops.requiredEvidence'), secondary: true, render: (row) => row.requiredEvidence },
          { key: 'active', header: t('commercial.statusLabel'), render: (row) => <Badge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? t('commercial.ops.active') : t('commercial.ops.inactive')}</Badge> },
          { key: 'act', header: <span className="sr-only">{t('commercial.actions')}</span>, align: 'right', render: (row) => (can(Permission.LOGISTICS_WRITE) ? <Button size="sm" onClick={() => { open(row); }}>{t('common.edit')}</Button> : null) },
        ]}
      />
      {form !== null && (
        <FormDialog
          title={t('commercial.ops.requirementForm')}
          onClose={() => { setForm(null); }}
          canSave={form.requiredEvidence.trim().length >= 3 && (form.destinationCountry.trim() === '' || form.destinationCountry.trim().length === 2) && (form.categoryId.trim() === '' || form.categoryId.trim().length === 26)}
          onSave={async () => {
            await commercialApi.saveHandling({
              ...(form.id === undefined ? {} : { id: form.id }),
              kind: form.kind,
              categoryId: form.categoryId.trim() === '' ? null : form.categoryId.trim(),
              destinationCountry: form.destinationCountry.trim() === '' ? null : form.destinationCountry.trim().toUpperCase(),
              requiredEvidence: form.requiredEvidence.trim(),
              isActive: form.isActive,
            });
            toast.success(t('commercial.saved'));
            await queryClient.invalidateQueries({ queryKey: ['commercial', 'handling'] });
          }}
        >
          <SelectField label={t('commercial.kindLabel')} value={form.kind} onChange={(x) => { setForm({ ...form, kind: x }); }} options={HANDLING_KINDS.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
          <TextField label={t('commercial.launch.country')} hint={t('commercial.ops.blankAll')} value={form.destinationCountry} onChange={(x) => { setForm({ ...form, destinationCountry: x }); }} />
          <TextField label={t('commercial.ops.categoryId')} hint={t('commercial.ops.categoryIdHint')} value={form.categoryId} onChange={(x) => { setForm({ ...form, categoryId: x }); }} />
          <AreaField label={t('commercial.ops.requiredEvidence')} value={form.requiredEvidence} onChange={(x) => { setForm({ ...form, requiredEvidence: x }); }} required />
          <CheckboxField label={t('commercial.ops.active')} checked={form.isActive} onChange={(event) => { setForm({ ...form, isActive: event.target.checked }); }} />
        </FormDialog>
      )}
    </Card>
  );
}

export function OperationsControlsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: 'routes' as const, label: t('commercial.ops.routes'), show: can(Permission.SETTINGS_READ) },
    { key: 'providers' as const, label: t('commercial.ops.providers'), show: can(Permission.LOGISTICS_READ) },
    { key: 'handling' as const, label: t('commercial.ops.handling'), show: can(Permission.LOGISTICS_READ) },
  ].filter((x) => x.show);
  const requested = params.get('tab') as OpsTab | null;
  const tab: OpsTab = tabs.find((x) => x.key === requested)?.key ?? tabs[0]?.key ?? 'routes';
  return (
    <>
      <PageHeader title={t('commercial.ops.title')} description={t('commercial.ops.description')} />
      <Tabs label={t('commercial.ops.title')} value={tab} onChange={(key) => { setParams({ tab: key }); }} tabs={tabs} />
      {tab === 'routes' && <ImportRoutesTab />}
      {tab === 'providers' && <ProviderReviewsTab />}
      {tab === 'handling' && <HandlingTab />}
    </>
  );
}
