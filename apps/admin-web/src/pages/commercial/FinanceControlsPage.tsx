/**
 * Finance controls (Doc 08 s4-6): certification-recovery programmes, seller
 * security, the insurance register and commission reversals.
 *
 * The proposed figures (5% / 90 days, 10% / 180 days, the three insurance
 * groups) come from the server, which takes them from the documents. Every
 * verification and activation is refused when the same person prepared it.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, DescriptionList, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import {
  bpsToPercent,
  commercialApi,
  COST_KINDS,
  REVIEW_OUTCOMES,
  RISK_GROUPS,
  SECURITY_FORMS,
  type CommissionAdjustment,
  type InsurancePolicy,
  type Programme,
  type SecurityReview,
  type SecuritySchedule,
} from '@/lib/commercial-policy';
import { formatDate, majorToMinor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, isoOrNull, money } from './format';
import { AreaField, FormDialog, RefusalCallout, SelectField, StatusBadge, Tabs, TextActionDialog, TextField } from './shared';

type FinanceTab = 'programmes' | 'security' | 'insurance' | 'adjustments';


function ProgrammeDetail({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'programme', id], queryFn: () => commercialApi.programme(id) });
  const [costOpen, setCostOpen] = useState(false);
  const [kind, setKind] = useState<string>('COST');
  const [ref, setRef] = useState('');
  const [supplier, setSupplier] = useState('');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial'] });
  };
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await fn();
      toast.success(t('commercial.saved'));
      await refresh();
    } catch (caught) {
      setActionError(caught);
    }
  };
  const p = query.data;
  return (
    <Modal isOpen size="xl" onClose={onClose} title={p?.title ?? t('commercial.finance.programme')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error !== null || p === undefined ? (
        <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : (
        <div className="space-y-4">
          <RefusalCallout error={actionError} />
          <Callout tone="info">{t('commercial.finance.costRecoveryNote')}</Callout>
          <DescriptionList
            items={[
              { label: t('commercial.reference'), value: p.reference },
              { label: t('commercial.statusLabel'), value: <StatusBadge status={p.status} /> },
              { label: t('commercial.finance.cap'), value: bpsToPercent(p.capBps) },
              { label: t('commercial.finance.period'), value: `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}` },
              { label: t('commercial.finance.eligibleCost'), value: money(p.eligibleCostMinor, p.currency) },
              { label: t('commercial.finance.confirmed'), value: money(p.confirmedMinor, p.currency) },
              { label: t('commercial.finance.reserved'), value: money(p.reservedMinor, p.currency) },
              { label: t('commercial.finance.unrecovered'), value: money(p.unrecoveredMinor, p.currency) },
            ]}
          />
          {can(Permission.FINANCE_POLICY_WRITE) && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => { setCostOpen(true); }}>{t('commercial.finance.recordCost')}</Button>
              {(['ACTIVE', 'PAUSED', 'CLOSED'] as const).map((s) => (
                <Button key={s} size="sm" variant="ghost" onClick={() => { void act(() => commercialApi.programmeStatus(p.id, s)); }}>{t('commercial.finance.setStatus', { status: t(`commercial.status.${s}` as TranslationKey) })}</Button>
              ))}
            </div>
          )}
          <h3 className="text-title-xs text-ink">{t('commercial.finance.costs')}</h3>
          <DataTable
            caption={t('commercial.finance.costs')}
            rows={p.costs}
            rowKey={(row) => row.id}
            emptyTitle={t('commercial.empty')}
            columns={[
              { key: 'ref', header: t('commercial.reference'), render: (row) => row.externalReference },
              { key: 'kind', header: t('commercial.kindLabel'), render: (row) => codeLabel(t, row.kind) },
              { key: 'supplier', header: t('commercial.finance.supplier'), secondary: true, render: (row) => row.supplierName },
              { key: 'amount', header: t('commercial.amount'), align: 'right', render: (row) => money(row.amountMinor, row.currency) },
              { key: 'eligible', header: t('commercial.finance.eligible'), render: (row) => (row.verifiedAt === null ? <Badge tone="warning">{t('commercial.status.PENDING')}</Badge> : <Badge tone={row.eligible ? 'success' : 'danger'}>{row.eligible ? t('commercial.yes') : t('commercial.no')}</Badge>) },
              {
                key: 'verify',
                header: <span className="sr-only">{t('commercial.actions')}</span>,
                align: 'right',
                render: (row) =>
                  can(Permission.FINANCE_TAX_VERIFY) && row.verifiedAt === null ? (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => { void act(() => commercialApi.verifyCost(row.id, true)); }}>{t('commercial.finance.verifyEligible')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => { void act(() => commercialApi.verifyCost(row.id, false)); }}>{t('commercial.finance.verifyIneligible')}</Button>
                    </div>
                  ) : null,
              },
            ]}
          />
          <h3 className="text-title-xs text-ink">{t('commercial.finance.allocations')}</h3>
          <DataTable
            caption={t('commercial.finance.allocations')}
            rows={p.allocations}
            rowKey={(row) => row.id}
            emptyTitle={t('commercial.empty')}
            columns={[
              { key: 'order', header: t('commercial.orderLabel'), render: (row) => row.orderId ?? '—' },
              { key: 'net', header: t('commercial.finance.netGoods'), align: 'right', secondary: true, render: (row) => money(row.netGoodsMinor, row.currency) },
              { key: 'amount', header: t('commercial.amount'), align: 'right', render: (row) => money(row.amountMinor, row.currency) },
              { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
            ]}
          />
        </div>
      )}
      {costOpen && p !== undefined && (
        <FormDialog
          title={t('commercial.finance.recordCost')}
          onClose={() => { setCostOpen(false); }}
          canSave={majorToMinor(amount) !== null && ref.trim().length >= 2 && supplier.trim().length >= 2 && evidence.trim().length >= 3}
          onSave={async () => {
            await commercialApi.recordCost(p.id, { kind, externalReference: ref.trim(), supplierName: supplier.trim(), amountMinor: majorToMinor(amount), currency: p.currency, evidence: evidence.trim() });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <SelectField label={t('commercial.kindLabel')} value={kind} onChange={setKind} options={COST_KINDS.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
          <TextField label={t('commercial.reference')} value={ref} onChange={setRef} required />
          <TextField label={t('commercial.finance.supplier')} value={supplier} onChange={setSupplier} required />
          <TextField label={t('commercial.amountMajor', { currency: p.currency })} value={amount} onChange={setAmount} required />
          <AreaField label={t('commercial.evidence')} value={evidence} onChange={setEvidence} required />
        </FormDialog>
      )}
    </Modal>
  );
}

function ProgrammesTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'programmes'], queryFn: commercialApi.programmes });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seller, setSeller] = useState('');
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const columns: Column<Programme>[] = [
    { key: 'title', header: t('commercial.title'), render: (row) => <button type="button" className="font-medium text-accent hover:underline" onClick={() => { setOpen(row.id); }}>{row.title}</button> },
    { key: 'ref', header: t('commercial.reference'), secondary: true, render: (row) => row.reference },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'unrecovered', header: t('commercial.finance.unrecovered'), align: 'right', render: (row) => money(row.unrecoveredMinor, row.currency) },
  ];
  return (
    <Card actions={can(Permission.FINANCE_POLICY_WRITE) ? <Button variant="primary" onClick={() => { setCreating(true); }}>{t('commercial.finance.createProgramme')}</Button> : undefined} title={t('commercial.finance.programmes')}>
      <DataTable caption={t('commercial.finance.programmes')} columns={columns} rows={query.data?.programmes} rowKey={(row) => row.id} isLoading={query.isLoading} error={query.error} onRetry={() => { void query.refetch(); }} emptyTitle={t('commercial.empty')} />
      {open !== null && <ProgrammeDetail id={open} onClose={() => { setOpen(null); }} />}
      {creating && (
        <FormDialog
          title={t('commercial.finance.createProgramme')}
          onClose={() => { setCreating(false); }}
          canSave={seller.trim().length === 26 && title.trim().length >= 3 && currency.trim().length === 3 && start !== '' && end !== ''}
          onSave={async () => {
            await commercialApi.createProgramme({ sellerAccountId: seller.trim(), title: title.trim(), currency: currency.trim().toUpperCase(), periodStart: isoOrNull(start), periodEnd: isoOrNull(end) });
            toast.success(t('commercial.saved'));
            await queryClient.invalidateQueries({ queryKey: ['commercial', 'programmes'] });
          }}
        >
          <TextField label={t('commercial.sellerAccountId')} value={seller} onChange={setSeller} required />
          <TextField label={t('commercial.title')} value={title} onChange={setTitle} required />
          <TextField label={t('commercial.currency')} value={currency} onChange={setCurrency} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField type="date" label={t('commercial.finance.periodStart')} value={start} onChange={setStart} required />
            <TextField type="date" label={t('commercial.finance.periodEnd')} value={end} onChange={setEnd} required />
          </div>
        </FormDialog>
      )}
    </Card>
  );
}

function SecurityTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'security'], queryFn: commercialApi.security });
  const [proposing, setProposing] = useState(false);
  const [activating, setActivating] = useState<SecuritySchedule | null>(null);
  const [reviewing, setReviewing] = useState<SecurityReview | null>(null);
  const [form, setForm] = useState({ sellerAccountId: '', tier: 'STANDARD', form: 'RESERVE', currency: 'INR', exposureBasis: '', permittedUses: '', exposure: '' });
  const [review, setReview] = useState({ exposure: '', outcome: 'NO_CHANGE', note: '' });
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial', 'security'] });
  };
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const v = query.data;
  return (
    <div className="space-y-4">
      <Card title={t('commercial.finance.proposals')} description={t('commercial.finance.proposalsBody')} bodyClassName="px-5 py-4">
        <DescriptionList
          items={Object.entries(v.proposals).map(([tier, p]) => ({
            label: codeLabel(t, tier),
            value: t('commercial.finance.proposalValue', { percent: bpsToPercent(p.reserveBps), days: String(p.holdDays) }),
          }))}
        />
      </Card>
      <Card title={t('commercial.finance.securitySchedules')} actions={mayWrite ? <Button variant="primary" onClick={() => { setProposing(true); }}>{t('commercial.finance.proposeSecurity')}</Button> : undefined}>
        <DataTable
          caption={t('commercial.finance.securitySchedules')}
          rows={v.schedules}
          rowKey={(row) => row.id}
          emptyTitle={t('commercial.empty')}
          columns={[
            { key: 'seller', header: t('commercial.sellerAccountId'), render: (row) => <span className="font-mono text-xxs">{row.sellerAccountId}</span> },
            { key: 'tier', header: t('commercial.finance.tier'), render: (row) => codeLabel(t, row.tier) },
            { key: 'reserve', header: t('commercial.finance.reserve'), align: 'right', render: (row) => t('commercial.finance.proposalValue', { percent: bpsToPercent(row.reserveBps), days: String(row.holdDays) }) },
            { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
            { key: 'act', header: <span className="sr-only">{t('commercial.actions')}</span>, align: 'right', render: (row) => (mayWrite && row.status === 'PROPOSED' ? <Button size="sm" onClick={() => { setActivating(row); }}>{t('commercial.activate')}</Button> : null) },
          ]}
        />
      </Card>
      <Card title={t('commercial.finance.reviews')}>
        <DataTable
          caption={t('commercial.finance.reviews')}
          rows={v.reviews}
          rowKey={(row) => row.id}
          emptyTitle={t('commercial.empty')}
          columns={[
            { key: 'kind', header: t('commercial.kindLabel'), render: (row) => codeLabel(t, row.kind) },
            { key: 'period', header: t('commercial.finance.period'), render: (row) => row.periodKey },
            { key: 'due', header: t('commercial.due'), nowrap: true, render: (row) => formatDate(row.dueAt) },
            { key: 'outcome', header: t('commercial.finance.outcome'), render: (row) => codeLabel(t, row.outcome) },
            { key: 'act', header: <span className="sr-only">{t('commercial.actions')}</span>, align: 'right', render: (row) => (mayWrite && row.reviewedAt === null ? <Button size="sm" onClick={() => { setReviewing(row); }}>{t('commercial.finance.completeReview')}</Button> : null) },
          ]}
        />
      </Card>
      {proposing && (
        <FormDialog
          title={t('commercial.finance.proposeSecurity')}
          onClose={() => { setProposing(false); }}
          canSave={form.sellerAccountId.trim().length === 26 && form.exposureBasis.trim().length >= 10 && form.permittedUses.trim().length >= 2 && (form.exposure.trim() === '' || majorToMinor(form.exposure) !== null)}
          onSave={async () => {
            await commercialApi.proposeSecurity({
              sellerAccountId: form.sellerAccountId.trim(),
              tier: form.tier,
              form: form.form,
              currency: form.currency.trim().toUpperCase(),
              exposureBasis: form.exposureBasis.trim(),
              documentedExposureMinor: form.exposure.trim() === '' ? null : majorToMinor(form.exposure),
              permittedUses: form.permittedUses.split(',').map((s) => s.trim()).filter((s) => s.length >= 2),
            });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <Callout tone="info">{t('commercial.finance.noStacking')}</Callout>
          <TextField label={t('commercial.sellerAccountId')} value={form.sellerAccountId} onChange={(x) => { setForm({ ...form, sellerAccountId: x }); }} required />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField label={t('commercial.finance.tier')} value={form.tier} onChange={(x) => { setForm({ ...form, tier: x }); }} options={['STANDARD', 'HIGH_RISK'].map((k) => ({ value: k, label: codeLabel(t, k) }))} />
            <SelectField label={t('commercial.finance.form')} value={form.form} onChange={(x) => { setForm({ ...form, form: x }); }} options={SECURITY_FORMS.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
            <TextField label={t('commercial.currency')} value={form.currency} onChange={(x) => { setForm({ ...form, currency: x }); }} />
          </div>
          <AreaField label={t('commercial.finance.exposureBasis')} value={form.exposureBasis} onChange={(x) => { setForm({ ...form, exposureBasis: x }); }} required />
          <TextField label={t('commercial.finance.documentedExposure', { currency: form.currency })} value={form.exposure} onChange={(x) => { setForm({ ...form, exposure: x }); }} />
          <TextField label={t('commercial.finance.permittedUses')} hint={t('commercial.commaSeparated')} value={form.permittedUses} onChange={(x) => { setForm({ ...form, permittedUses: x }); }} required />
        </FormDialog>
      )}
      {activating !== null && (
        <TextActionDialog
          title={t('commercial.activate')}
          description={t('commercial.secondPerson')}
          label={t('commercial.finance.providerPermissionRef')}
          minLength={3}
          confirmLabel={t('commercial.activate')}
          onClose={() => { setActivating(null); }}
          onSubmit={async (refText) => {
            await commercialApi.activateSecurity(activating.id, refText);
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
      {reviewing !== null && (
        <FormDialog
          title={t('commercial.finance.completeReview')}
          onClose={() => { setReviewing(null); }}
          canSave={majorToMinor(review.exposure) !== null && review.note.trim().length >= 5}
          onSave={async () => {
            await commercialApi.completeReview(reviewing.id, { exposureMinor: majorToMinor(review.exposure) ?? '0', outcome: review.outcome, note: review.note.trim() });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <TextField label={t('commercial.finance.exposureMajor')} value={review.exposure} onChange={(x) => { setReview({ ...review, exposure: x }); }} required />
          <SelectField label={t('commercial.finance.outcome')} value={review.outcome} onChange={(x) => { setReview({ ...review, outcome: x }); }} options={REVIEW_OUTCOMES.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
          <AreaField label={t('commercial.note')} value={review.note} onChange={(x) => { setReview({ ...review, note: x }); }} required />
        </FormDialog>
      )}
    </div>
  );
}

const EMPTY_POLICY = { id: '', holderType: 'SELLER', sellerAccountId: '', coverType: 'PRODUCT_LIABILITY', riskGroup: '', insurer: '', policyNumber: '', insuredEntity: '', currency: 'USD', perOccurrence: '', aggregate: '', effectiveFrom: '', expiresAt: '', brokerName: '' };

function InsuranceTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'insurance'], queryFn: commercialApi.insurance });
  const [editing, setEditing] = useState<typeof EMPTY_POLICY | null>(null);
  const [verifying, setVerifying] = useState<InsurancePolicy | null>(null);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial', 'insurance'] });
  };
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const v = query.data;
  const edit = (p: InsurancePolicy): void => {
    setEditing({ id: p.id, holderType: p.holderType, sellerAccountId: p.sellerAccountId ?? '', coverType: p.coverType, riskGroup: p.riskGroup ?? '', insurer: p.insurer, policyNumber: p.policyNumber, insuredEntity: p.insuredEntity, currency: p.currency, perOccurrence: '', aggregate: '', effectiveFrom: p.effectiveFrom.slice(0, 10), expiresAt: p.expiresAt.slice(0, 10), brokerName: p.brokerName ?? '' });
  };
  const amountOk = (x: string): boolean => x.trim() === '' || majorToMinor(x) !== null;
  return (
    <div className="space-y-4">
      <Card title={t('commercial.finance.riskGroups')} bodyClassName="space-y-3 px-5 py-4">
        <Callout tone="info">{v.notice}</Callout>
        <DataTable
          caption={t('commercial.finance.riskGroups')}
          rows={v.groups}
          rowKey={(row) => row.code}
          emptyTitle={t('commercial.empty')}
          columns={[
            { key: 'code', header: t('commercial.finance.group'), render: (row) => codeLabel(t, row.code) },
            { key: 'desc', header: t('commercial.description'), secondary: true, render: (row) => row.description },
            { key: 'per', header: t('commercial.finance.perOccurrence'), align: 'right', render: (row) => money(row.productLiabilityPerOccurrenceMinor, 'USD') },
            { key: 'agg', header: t('commercial.finance.aggregate'), align: 'right', render: (row) => money(row.productLiabilityAggregateMinor, 'USD') },
            { key: 'recall', header: t('commercial.finance.recall'), align: 'right', tertiary: true, render: (row) => money(row.recallLimitMinor, 'USD') },
          ]}
        />
      </Card>
      <Card title={t('commercial.finance.policies')} actions={can(Permission.FINANCE_POLICY_WRITE) ? <Button variant="primary" onClick={() => { setEditing({ ...EMPTY_POLICY }); }}>{t('commercial.finance.recordPolicy')}</Button> : undefined}>
        <DataTable
          caption={t('commercial.finance.policies')}
          rows={v.policies}
          rowKey={(row) => row.id}
          emptyTitle={t('commercial.empty')}
          columns={[
            { key: 'insurer', header: t('commercial.finance.insurer'), render: (row) => `${row.insurer} · ${row.policyNumber}` },
            { key: 'cover', header: t('commercial.finance.cover'), secondary: true, render: (row) => codeLabel(t, row.coverType) },
            { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.verificationStatus} /> },
            { key: 'expiry', header: t('commercial.finance.daysToExpiry'), align: 'right', render: (row) => <Badge tone={row.daysToExpiry <= 30 ? 'danger' : row.daysToExpiry <= 90 ? 'warning' : 'neutral'}>{t('commercial.days', { days: String(row.daysToExpiry) })}</Badge> },
            { key: 'gaps', header: t('commercial.gaps'), render: (row) => (row.gaps.length === 0 ? <Badge tone="success">{t('commercial.noGaps')}</Badge> : <div className="flex flex-wrap gap-1">{row.gaps.map((g) => <Badge key={g} tone="warning">{codeLabel(t, g)}</Badge>)}</div>) },
            {
              key: 'act',
              header: <span className="sr-only">{t('commercial.actions')}</span>,
              align: 'right',
              render: (row) => (
                <div className="flex justify-end gap-1">
                  {can(Permission.FINANCE_POLICY_WRITE) && <Button size="sm" onClick={() => { edit(row); }}>{t('common.edit')}</Button>}
                  {can(Permission.FINANCE_TAX_VERIFY) && row.verificationStatus !== 'VERIFIED' && <Button size="sm" onClick={() => { setVerifying(row); }}>{t('commercial.verify')}</Button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing !== null && (
        <FormDialog
          title={t('commercial.finance.recordPolicy')}
          onClose={() => { setEditing(null); }}
          canSave={editing.insurer.trim().length >= 2 && editing.policyNumber.trim() !== '' && editing.insuredEntity.trim().length >= 2 && editing.effectiveFrom !== '' && editing.expiresAt !== '' && amountOk(editing.perOccurrence) && amountOk(editing.aggregate)}
          onSave={async () => {
            const e = editing;
            await commercialApi.saveInsurance({
              ...(e.id === '' ? {} : { id: e.id }),
              holderType: e.holderType,
              sellerAccountId: e.sellerAccountId.trim() === '' ? null : e.sellerAccountId.trim(),
              coverType: e.coverType.trim(),
              riskGroup: e.riskGroup === '' ? null : e.riskGroup,
              insurer: e.insurer.trim(),
              policyNumber: e.policyNumber.trim(),
              insuredEntity: e.insuredEntity.trim(),
              sites: [],
              products: [],
              territories: [],
              currency: e.currency.trim().toUpperCase(),
              perOccurrenceMinor: e.perOccurrence.trim() === '' ? null : majorToMinor(e.perOccurrence),
              aggregateMinor: e.aggregate.trim() === '' ? null : majorToMinor(e.aggregate),
              effectiveFrom: isoOrNull(e.effectiveFrom),
              expiresAt: isoOrNull(e.expiresAt),
              brokerName: e.brokerName.trim() === '' ? null : e.brokerName.trim(),
            });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        >
          <Callout tone="info">{t('commercial.finance.policyBackToPending')}</Callout>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label={t('commercial.finance.holder')} value={editing.holderType} onChange={(x) => { setEditing({ ...editing, holderType: x }); }} options={['SELLER', 'PLATFORM'].map((k) => ({ value: k, label: codeLabel(t, k) }))} />
            <TextField label={t('commercial.sellerAccountId')} value={editing.sellerAccountId} onChange={(x) => { setEditing({ ...editing, sellerAccountId: x }); }} />
            <TextField label={t('commercial.finance.cover')} value={editing.coverType} onChange={(x) => { setEditing({ ...editing, coverType: x }); }} required />
            <SelectField label={t('commercial.finance.group')} value={editing.riskGroup} onChange={(x) => { setEditing({ ...editing, riskGroup: x }); }} options={[{ value: '', label: '—' }, ...RISK_GROUPS.map((k) => ({ value: k, label: codeLabel(t, k) }))]} />
            <TextField label={t('commercial.finance.insurer')} value={editing.insurer} onChange={(x) => { setEditing({ ...editing, insurer: x }); }} required />
            <TextField label={t('commercial.finance.policyNumber')} value={editing.policyNumber} onChange={(x) => { setEditing({ ...editing, policyNumber: x }); }} required />
            <TextField label={t('commercial.finance.insuredEntity')} value={editing.insuredEntity} onChange={(x) => { setEditing({ ...editing, insuredEntity: x }); }} required />
            <TextField label={t('commercial.currency')} value={editing.currency} onChange={(x) => { setEditing({ ...editing, currency: x }); }} />
            <TextField label={t('commercial.finance.perOccurrenceMajor')} value={editing.perOccurrence} onChange={(x) => { setEditing({ ...editing, perOccurrence: x }); }} />
            <TextField label={t('commercial.finance.aggregateMajor')} value={editing.aggregate} onChange={(x) => { setEditing({ ...editing, aggregate: x }); }} />
            <TextField type="date" label={t('commercial.effectiveFrom')} value={editing.effectiveFrom} onChange={(x) => { setEditing({ ...editing, effectiveFrom: x }); }} required />
            <TextField type="date" label={t('commercial.finance.expiresAt')} value={editing.expiresAt} onChange={(x) => { setEditing({ ...editing, expiresAt: x }); }} required />
            <TextField label={t('commercial.finance.broker')} value={editing.brokerName} onChange={(x) => { setEditing({ ...editing, brokerName: x }); }} />
          </div>
        </FormDialog>
      )}
      {verifying !== null && (
        <TextActionDialog
          title={t('commercial.verify')}
          description={t('commercial.secondPerson')}
          label={t('commercial.finance.verificationMethod')}
          minLength={3}
          confirmLabel={t('commercial.verify')}
          onClose={() => { setVerifying(null); }}
          onSubmit={async (method) => {
            await commercialApi.verifyInsurance(verifying.id, { verified: true, method });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function AdjustmentsTab(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['commercial', 'adjustments'], queryFn: commercialApi.adjustments });
  const [applying, setApplying] = useState<CommissionAdjustment | null>(null);
  return (
    <Card title={t('commercial.finance.adjustments')} description={t('commercial.finance.adjustmentsBody')}>
      <DataTable
        caption={t('commercial.finance.adjustments')}
        rows={query.data?.adjustments}
        rowKey={(row) => row.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => { void query.refetch(); }}
        emptyTitle={t('commercial.empty')}
        columns={[
          { key: 'refund', header: t('commercial.finance.refund'), render: (row) => <span className="font-mono text-xxs">{row.refundId}</span> },
          { key: 'refunded', header: t('commercial.finance.refundedGoods'), align: 'right', secondary: true, render: (row) => money(row.refundedGoodsMinor, row.currency) },
          { key: 'reversed', header: t('commercial.finance.reversed'), align: 'right', render: (row) => money(row.reversedMinor, row.currency) },
          { key: 'basis', header: t('commercial.finance.basis'), tertiary: true, render: (row) => `${codeLabel(t, row.basis)} · ${codeLabel(t, row.fault)}` },
          { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
          { key: 'act', header: <span className="sr-only">{t('commercial.actions')}</span>, align: 'right', render: (row) => (can(Permission.COMMISSION_CREDIT_NOTE_CREATE) && row.status === 'PROPOSED' ? <Button size="sm" onClick={() => { setApplying(row); }}>{t('commercial.finance.apply')}</Button> : null) },
        ]}
      />
      {applying !== null && (
        <TextActionDialog
          title={t('commercial.finance.apply')}
          label={t('commercial.finance.creditNoteReference')}
          minLength={3}
          confirmLabel={t('commercial.finance.apply')}
          onClose={() => { setApplying(null); }}
          onSubmit={async (reference) => {
            await commercialApi.applyAdjustment(applying.id, reference);
            toast.success(t('commercial.saved'));
            await queryClient.invalidateQueries({ queryKey: ['commercial', 'adjustments'] });
          }}
        />
      )}
    </Card>
  );
}

export function FinanceControlsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const all: { key: FinanceTab; label: string; show: boolean }[] = [
    { key: 'programmes', label: t('commercial.finance.programmes'), show: can(Permission.FINANCE_POLICY_READ) },
    { key: 'security', label: t('commercial.finance.security'), show: can(Permission.FINANCE_POLICY_READ) },
    { key: 'insurance', label: t('commercial.finance.insurance'), show: can(Permission.FINANCE_POLICY_READ) },
    { key: 'adjustments', label: t('commercial.finance.adjustments'), show: can(Permission.COMMISSION_INVOICE_VIEW) },
  ];
  const tabs = all.filter((x) => x.show);
  const requested = params.get('tab') as FinanceTab | null;
  const tab = tabs.find((x) => x.key === requested)?.key ?? tabs[0]?.key ?? 'adjustments';
  return (
    <>
      <PageHeader title={t('commercial.finance.title')} description={t('commercial.finance.description')} />
      <Tabs label={t('commercial.finance.title')} value={tab} onChange={(key) => { setParams({ tab: key }); }} tabs={tabs} />
      {tab === 'programmes' && <ProgrammesTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'insurance' && <InsuranceTab />}
      {tab === 'adjustments' && <AdjustmentsTab />}
    </>
  );
}
