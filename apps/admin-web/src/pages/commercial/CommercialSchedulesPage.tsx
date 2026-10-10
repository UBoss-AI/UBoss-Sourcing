/**
 * Commercial schedules (Doc 07 / Doc 08).
 *
 * Every proposed number - commission, logistics charge, certification
 * recovery, security, insurance, payment plan, subscriptions, case windows -
 * is a versioned DRAFT. A second person approves it with the adoption
 * evidence, and a person activates it; the server refuses activation with each
 * missing item, and this screen lists them. Nothing activates by itself.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Button, Callout, Card, CheckboxField, DescriptionList, EmptyState, ErrorState, LoadingState, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { bpsToPercent, commercialApi, SCHEDULE_KINDS, SCHEDULE_STATUSES, type CommercialSchedule, type ScheduleDetail, type ScheduleKind } from '@/lib/commercial-policy';
import { formatDate, formatDateTime, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, dateInput, isoOrNull, money, splitCodes } from './format';
import { AreaField, CodeList, JsonBlock, RefusalCallout, StatusBadge, Tabs, TextActionDialog, TextField } from './shared';

const PROPOSAL_STATUSES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

function kindLabel(t: ReturnType<typeof useI18n>['t'], kind: string): string {
  return t(`commercial.kind.${kind}` as TranslationKey, { defaultValue: kind });
}

export function ProposalBanner({ status }: { status: string }): React.JSX.Element | null {
  const { t } = useI18n();
  if (!PROPOSAL_STATUSES.has(status)) return null;
  return (
    <Callout tone="warning" title={t('commercial.proposalTitle')}>
      {t('commercial.proposalBody')}
    </Callout>
  );
}

function ReferenceTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['commercial', 'reference'], queryFn: commercialApi.reference });
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const ref = query.data;
  const ex = ref.workedExample;
  return (
    <div className="space-y-6">
      <Card title={t('commercial.ref.commissionTitle')} description={t('commercial.ref.commissionBody')}>
        <DataTable
          caption={t('commercial.ref.commissionTitle')}
          rows={ref.commission}
          rowKey={(row) => row.department}
          columns={[
            { key: 'department', header: t('commercial.ref.department'), render: (row) => row.department },
            { key: 'b2b', header: t('commercial.ref.b2b'), align: 'right', render: (row) => bpsToPercent(row.b2bBps) },
            { key: 'b2c', header: t('commercial.ref.b2c'), align: 'right', render: (row) => bpsToPercent(row.b2cBps) },
            { key: 'consideration', header: t('commercial.ref.consideration'), secondary: true, render: (row) => row.consideration },
          ]}
          emptyTitle={t('commercial.empty')}
        />
      </Card>
      <Card title={t('commercial.ref.exampleTitle')} bodyClassName="px-5 py-4 space-y-3">
        <DescriptionList
          items={[
            { label: t('commercial.ref.netGoods'), value: money(ex.netGoodsMinor, 'INR') },
            { label: t('commercial.ref.commission'), value: money(ex.commissionMinor, 'INR') },
            { label: t('commercial.ref.externalFreight'), value: money(ex.externalCostMinor, 'INR') },
            { label: t('commercial.ref.coordination'), value: money(ex.coordinationMinor, 'INR') },
            { label: t('commercial.ref.chargesBeforeTax'), value: money(ex.platformChargesBeforeTaxMinor, 'INR') },
          ]}
        />
        <p className="text-sm text-ink-muted">
          {t('commercial.ref.exampleSum', { goods: money(ex.netGoodsMinor, 'INR'), commission: money(ex.commissionMinor, 'INR'), coordination: money(ex.coordinationMinor, 'INR'), total: money(ex.platformChargesBeforeTaxMinor, 'INR') })}
        </p>
      </Card>
      <Card title={t('commercial.ref.differencesTitle')} bodyClassName="px-5 py-4 space-y-3">
        <Callout tone="info">{t('commercial.ref.presenceNotApproval')}</Callout>
        {ref.catalogueDifferences.length === 0 ? (
          <p className="text-sm text-ink">{t('commercial.ref.noDifferences')}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {ref.catalogueDifferences.map((d) => (
              <li key={`${d.kind}-${d.department}-${d.name ?? ''}`}>
                {codeLabel(t, d.kind)}: {d.department}
                {d.name === undefined ? '' : ` / ${d.name}`}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function CommercialSchedulesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reference' ? 'reference' : 'schedules';
  const kind = params.get('kind') ?? '';
  const status = params.get('status') ?? '';
  const [newKind, setNewKind] = useState<ScheduleKind>('COMMISSION');
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const query = useQuery({ queryKey: ['commercial', 'schedules', kind, status], queryFn: () => commercialApi.schedules({ kind, status }), enabled: tab === 'schedules' });
  const draft = useMutation({
    mutationFn: () => commercialApi.draft(newKind),
    onSuccess: (created) => {
      toast.success(t('commercial.drafted'));
      void navigate(`/commercial/schedules/${created.id}`);
    },
  });

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const columns: Column<CommercialSchedule>[] = [
    { key: 'title', header: t('commercial.title'), render: (row) => <Link className="font-medium text-accent hover:underline" to={`/commercial/schedules/${row.id}`}>{row.title}</Link> },
    { key: 'kind', header: t('commercial.kindLabel'), render: (row) => kindLabel(t, row.kind) },
    { key: 'version', header: t('commercial.version'), align: 'right', render: (row) => `v${String(row.version)}` },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'effective', header: t('commercial.effectiveFrom'), secondary: true, render: (row) => formatDate(row.effectiveFrom) },
    { key: 'source', header: t('commercial.source'), tertiary: true, render: (row) => row.sourceDocument },
  ];

  return (
    <>
      <PageHeader title={t('commercial.schedulesTitle')} description={t('commercial.schedulesDescription')} />
      <Tabs
        label={t('commercial.schedulesTitle')}
        value={tab}
        onChange={(key) => { setParam('tab', key === 'schedules' ? '' : key); }}
        tabs={[
          { key: 'schedules', label: t('commercial.tab.schedules') },
          { key: 'reference', label: t('commercial.tab.reference') },
        ]}
      />
      {tab === 'reference' ? (
        <ReferenceTab />
      ) : (
        <Card>
          <Callout tone="info" className="m-4">{t('commercial.nothingActivates')}</Callout>
          <Toolbar>
            <ToolbarField label={t('commercial.kindLabel')}>
              <Select className="w-56" value={kind} onChange={(event) => { setParam('kind', event.target.value); }}>
                <option value="">{t('commercial.anyKind')}</option>
                {SCHEDULE_KINDS.map((k) => (
                  <option key={k} value={k}>{kindLabel(t, k)}</option>
                ))}
              </Select>
            </ToolbarField>
            <ToolbarField label={t('commercial.statusLabel')}>
              <Select className="w-48" value={status} onChange={(event) => { setParam('status', event.target.value); }}>
                <option value="">{t('commercial.anyStatus')}</option>
                {SCHEDULE_STATUSES.map((s) => (
                  <option key={s} value={s}>{t(`commercial.status.${s}` as TranslationKey)}</option>
                ))}
              </Select>
            </ToolbarField>
            {mayWrite && (
              <ToolbarField label={t('commercial.draftNewVersion')}>
                <div className="flex gap-2">
                  <Select aria-label={t('commercial.kindLabel')} className="w-56" value={newKind} onChange={(event) => { setNewKind(event.target.value as ScheduleKind); }}>
                    {SCHEDULE_KINDS.map((k) => (
                      <option key={k} value={k}>{kindLabel(t, k)}</option>
                    ))}
                  </Select>
                  <Button variant="primary" isLoading={draft.isPending} onClick={() => { draft.mutate(); }}>{t('commercial.draft')}</Button>
                </div>
              </ToolbarField>
            )}
          </Toolbar>
          {draft.error !== null && <div className="px-4"><RefusalCallout error={draft.error} /></div>}
          <DataTable
            caption={t('commercial.schedulesTitle')}
            columns={columns}
            rows={query.data?.schedules}
            rowKey={(row) => row.id}
            isLoading={query.isLoading}
            error={query.error}
            onRetry={() => { void query.refetch(); }}
            emptyTitle={t('commercial.empty')}
          />
        </Card>
      )}
    </>
  );
}

function EditDraftDialog({ schedule, onClose }: { schedule: ScheduleDetail; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(schedule.title);
  const [countries, setCountries] = useState((schedule.scopeJson?.countries ?? []).join(', '));
  const [b2b, setB2b] = useState((schedule.scopeJson?.channels ?? []).includes('B2B'));
  const [b2c, setB2c] = useState((schedule.scopeJson?.channels ?? []).includes('B2C'));
  const [from, setFrom] = useState(dateInput(schedule.effectiveFrom));
  const [until, setUntil] = useState(dateInput(schedule.effectiveUntil));
  const [reference, setReference] = useState(schedule.scheduleReference ?? '');
  const [note, setNote] = useState(schedule.note ?? '');
  const [body, setBody] = useState(JSON.stringify(schedule.bodyJson, null, 2));
  let parsed: unknown = null;
  let bodyError: string | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    bodyError = t('commercial.invalidJson');
  }
  const save = useMutation({
    mutationFn: () =>
      commercialApi.edit(schedule.id, {
        title: title.trim(),
        scope: { countries: splitCodes(countries), channels: [...(b2b ? ['B2B' as const] : []), ...(b2c ? ['B2C' as const] : [])] },
        body: parsed,
        effectiveFrom: isoOrNull(from),
        effectiveUntil: isoOrNull(until),
        scheduleReference: reference.trim() === '' ? null : reference.trim(),
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['commercial', 'schedule', schedule.id] });
      toast.success(t('commercial.saved'));
      onClose();
    },
  });
  return (
    <Modal
      isOpen
      size="lg"
      onClose={onClose}
      title={t('commercial.editDraft')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" isLoading={save.isPending} disabled={bodyError !== null || title.trim().length < 3} onClick={() => { save.mutate(); }}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <RefusalCallout error={save.error} />
        <TextField label={t('commercial.title')} value={title} onChange={setTitle} required />
        <TextField label={t('commercial.scopeCountries')} hint={t('commercial.scopeCountriesHint')} value={countries} onChange={setCountries} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">{t('commercial.scopeChannels')}</legend>
          <CheckboxField label="B2B" checked={b2b} onChange={(event) => { setB2b(event.target.checked); }} />
          <CheckboxField label="B2C" checked={b2c} onChange={(event) => { setB2c(event.target.checked); }} />
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField type="date" label={t('commercial.effectiveFrom')} value={from} onChange={setFrom} />
          <TextField type="date" label={t('commercial.effectiveUntil')} value={until} onChange={setUntil} />
        </div>
        <TextField label={t('commercial.scheduleReference')} hint={t('commercial.scheduleReferenceHint')} value={reference} onChange={setReference} />
        <AreaField label={t('commercial.note')} value={note} onChange={setNote} />
        <AreaField label={t('commercial.body')} hint={bodyError ?? t('commercial.bodyHint')} value={body} onChange={setBody} rows={14} />
      </div>
    </Modal>
  );
}

function PreviewPanel({ id }: { id: string }): React.JSX.Element {
  const { t } = useI18n();
  const [goods, setGoods] = useState('100000');
  const [freight, setFreight] = useState('8000');
  const [channel, setChannel] = useState<'B2B' | 'B2C'>('B2B');
  const goodsMinor = majorToMinor(goods);
  const freightMinor = majorToMinor(freight);
  const valid = goodsMinor !== null && freightMinor !== null;
  const query = useQuery({
    queryKey: ['commercial', 'preview', id, goodsMinor, freightMinor, channel],
    queryFn: () => commercialApi.preview(id, { goodsMinor: goodsMinor ?? '0', externalFreightMinor: freightMinor ?? '0', channel }),
    enabled: valid,
  });
  return (
    <Card title={t('commercial.previewTitle')} description={t('commercial.previewBody')} bodyClassName="space-y-4 px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label={t('commercial.previewGoods')} value={goods} onChange={setGoods} />
        <TextField label={t('commercial.previewFreight')} value={freight} onChange={setFreight} />
        <label className="block">
          <span className="text-sm font-medium text-ink">{t('commercial.channel')}</span>
          <Select className="mt-1.5" value={channel} onChange={(event) => { setChannel(event.target.value as 'B2B' | 'B2C'); }}>
            <option value="B2B">B2B</option>
            <option value="B2C">B2C</option>
          </Select>
        </label>
      </div>
      {!valid && <Callout tone="warning">{t('commercial.invalidAmount')}</Callout>}
      {query.isLoading && valid && <LoadingState />}
      {query.error !== null && <RefusalCallout error={query.error} />}
      {query.data !== undefined && <PreviewValue value={query.data} />}
    </Card>
  );
}

/** Any key ending in "Minor" is shown in major units next to the raw value. */
function PreviewValue({ value }: { value: unknown }): React.JSX.Element {
  const convert = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(convert);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, k.endsWith('Minor') && typeof v === 'string' && /^-?\d+$/.test(v) ? minorToMajor(v) : convert(v)]));
    }
    return input;
  };
  return <JsonBlock value={convert(value)} />;
}

export function CommercialScheduleDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const [dialog, setDialog] = useState<'edit' | 'approve' | 'return' | 'provider' | 'retire' | null>(null);
  const query = useQuery({ queryKey: ['commercial', 'schedule', id], queryFn: () => commercialApi.schedule(id) });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial'] });
  };
  const simple = useMutation({
    mutationFn: (action: 'submit' | 'activate') => (action === 'submit' ? commercialApi.submit(id) : commercialApi.activate(id)),
    onSuccess: async () => {
      toast.success(t('commercial.saved'));
      await refresh();
    },
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const s = query.data;
  const scope = s.scopeJson ?? {};

  return (
    <>
      <PageHeader
        title={s.title}
        description={`${kindLabel(t, s.kind)} · v${String(s.version)}`}
        back={{ to: '/commercial/schedules', label: t('commercial.schedulesTitle') }}
        meta={<StatusBadge status={s.status} />}
      />
      <ProposalBanner status={s.status} />
      {mayWrite && (
        <div className="my-4 flex flex-wrap gap-2">
          {s.status === 'DRAFT' && <Button onClick={() => { setDialog('edit'); }}>{t('commercial.editDraft')}</Button>}
          {s.status === 'DRAFT' && <Button variant="primary" isLoading={simple.isPending && simple.variables === 'submit'} onClick={() => { simple.mutate('submit'); }}>{t('commercial.submit')}</Button>}
          {s.status === 'PENDING_APPROVAL' && <Button variant="primary" onClick={() => { setDialog('approve'); }}>{t('commercial.approve')}</Button>}
          {s.status === 'PENDING_APPROVAL' && <Button onClick={() => { setDialog('return'); }}>{t('commercial.return')}</Button>}
          {(s.status === 'PENDING_APPROVAL' || s.status === 'APPROVED') && <Button onClick={() => { setDialog('provider'); }}>{t('commercial.providerConfirmation')}</Button>}
          {s.status === 'APPROVED' && <Button variant="primary" isLoading={simple.isPending && simple.variables === 'activate'} onClick={() => { simple.mutate('activate'); }}>{t('commercial.activate')}</Button>}
          {s.status !== 'RETIRED' && <Button variant="danger" onClick={() => { setDialog('retire'); }}>{t('commercial.retire')}</Button>}
        </div>
      )}
      {simple.error !== null && <RefusalCallout error={simple.error} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('commercial.detailsTitle')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={1}
            items={[
              { label: t('commercial.source'), value: s.sourceDocument },
              { label: t('commercial.scopeCountries'), value: (scope.countries ?? []).length === 0 ? t('commercial.allCountries') : (scope.countries ?? []).join(', ') },
              { label: t('commercial.scopeChannels'), value: (scope.channels ?? []).length === 0 ? t('commercial.allChannels') : (scope.channels ?? []).join(', ') },
              { label: t('commercial.effectiveFrom'), value: formatDate(s.effectiveFrom) },
              { label: t('commercial.effectiveUntil'), value: formatDate(s.effectiveUntil) },
              { label: t('commercial.scheduleReference'), value: s.scheduleReference ?? '—' },
              { label: t('commercial.approvalEvidence'), value: s.approvalEvidence ?? '—' },
              { label: t('commercial.providerConfirmation'), value: s.providerConfirmationRef ?? '—' },
              { label: t('commercial.note'), value: s.note ?? '—' },
            ]}
          />
        </Card>
        <Card title={t('commercial.activationProblemsTitle')} description={t('commercial.activationProblemsBody')} bodyClassName="px-5 py-4">
          <CodeList codes={s.activationProblems} empty={t('commercial.noActivationProblems')} />
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <PreviewPanel id={s.id} />
        <Card title={t('commercial.body')} bodyClassName="px-5 py-4">
          <JsonBlock value={s.bodyJson} />
        </Card>
      </div>
      <Card title={t('commercial.historyTitle')} className="mt-4" bodyClassName="px-5 py-4">
        {s.events.length === 0 ? (
          <EmptyState title={t('commercial.noHistory')} />
        ) : (
          <ol className="space-y-2 text-sm">
            {s.events.map((event) => (
              <li key={event.id}>
                <span className="text-ink-muted">{formatDateTime(event.createdAt)}</span> · <span className="font-medium text-ink">{codeLabel(t, event.kind)}</span>
                {event.note !== null && <span className="text-ink"> — {event.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {dialog === 'edit' && <EditDraftDialog schedule={s} onClose={() => { setDialog(null); }} />}
      {(dialog === 'approve' || dialog === 'return') && (
        <TextActionDialog
          title={dialog === 'approve' ? t('commercial.approve') : t('commercial.return')}
          description={t('commercial.secondPerson')}
          label={t('commercial.evidence')}
          minLength={5}
          confirmLabel={dialog === 'approve' ? t('commercial.approve') : t('commercial.return')}
          onClose={() => { setDialog(null); }}
          onSubmit={async (evidence) => {
            await commercialApi.decide(s.id, { approve: dialog === 'approve', evidence });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
      {dialog === 'provider' && (
        <TextActionDialog
          title={t('commercial.providerConfirmation')}
          label={t('commercial.reference')}
          minLength={3}
          confirmLabel={t('common.save')}
          onClose={() => { setDialog(null); }}
          onSubmit={async (reference) => {
            await commercialApi.providerConfirmation(s.id, reference);
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
      {dialog === 'retire' && (
        <TextActionDialog
          title={t('commercial.retire')}
          label={t('commercial.reason')}
          minLength={3}
          isDangerous
          confirmLabel={t('commercial.retire')}
          onClose={() => { setDialog(null); }}
          onSubmit={async (reason) => {
            await commercialApi.retire(s.id, reason);
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
    </>
  );
}
