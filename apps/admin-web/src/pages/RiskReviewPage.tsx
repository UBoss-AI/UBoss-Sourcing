/**
 * Risk review (checklist SEC-008).
 *
 * The queue of fraud and risk signals the worker raised, and the rules that
 * raise them. A reviewer decides each signal - confirmed or a false positive -
 * and always says why. Nothing on this page suspends, cancels or holds
 * anything: a confirmed signal is acted on through the existing, audited
 * controls. The Business Owner tunes the thresholds and marks them approved
 * for production; until then the screen says the values are placeholders.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Input, PageHeader, Select, Textarea, Toolbar, ToolbarField, type BadgeTone } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type SignalStatus = 'OPEN' | 'CONFIRMED' | 'FALSE_POSITIVE';

export interface RiskSignal {
  id: string;
  ruleCode: string;
  severity: Severity;
  subjectType: string;
  subjectId: string;
  observed: number;
  threshold: number;
  facts: Record<string, unknown>;
  status: SignalStatus;
  reviewReason: string | null;
  reviewedAt: string | null;
  detectedAt: string;
}

export interface RiskRule {
  code: string;
  enabled: boolean;
  severity: Severity;
  threshold: number;
  windowMinutes: number;
  thresholdMinor: string | null;
  currency: string | null;
  approvedForProduction: boolean;
  version: number;
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = { LOW: 'neutral', MEDIUM: 'warning', HIGH: 'danger', CRITICAL: 'danger' };
const STATUS_TONE: Record<SignalStatus, BadgeTone> = { OPEN: 'warning', CONFIRMED: 'danger', FALSE_POSITIVE: 'neutral' };

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

function DecisionDialog({ signal, onClose }: { signal: RiskSignal; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<'CONFIRMED' | 'FALSE_POSITIVE'>(signal.status === 'CONFIRMED' ? 'FALSE_POSITIVE' : 'CONFIRMED');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => api.post(`/admin/risk/signals/${signal.id}/decision`, { decision, reason: reason.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['risk', 'signals'] });
      toast.success(t('risk.decided'));
      onClose();
    },
    onError: (caught) => { setError(errorText(caught, t('risk.decisionFailed'))); },
  });
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('risk.decideTitle')}
      description={t(`risk.rule.${signal.ruleCode}` as 'risk.rule.LOGIN_FAILURES')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" isLoading={submit.isPending} disabled={reason.trim().length < 5} onClick={() => { submit.mutate(); }}>
            {t('risk.saveDecision')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && <Callout tone="danger">{error}</Callout>}
        {signal.status !== 'OPEN' && <Callout tone="warning">{t('risk.overrideNote')}</Callout>}
        <pre className="max-h-48 overflow-auto rounded-md bg-surface-sunken p-3 text-xxs text-ink">{JSON.stringify(signal.facts, null, 2)}</pre>
        <label className="block">
          <span className="text-xs font-medium text-ink">{t('risk.decision')}</span>
          <Select className="mt-1.5" value={decision} onChange={(event) => { setDecision(event.target.value as 'CONFIRMED' | 'FALSE_POSITIVE'); }}>
            <option value="CONFIRMED">{t('risk.status.CONFIRMED')}</option>
            <option value="FALSE_POSITIVE">{t('risk.status.FALSE_POSITIVE')}</option>
          </Select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink">{t('risk.reason')}</span>
          <Textarea className="mt-1.5" rows={4} maxLength={1024} value={reason} onChange={(event) => { setReason(event.target.value); }} />
        </label>
      </div>
    </Modal>
  );
}

function RuleDialog({ rule, onClose }: { rule: RiskRule; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [windowMinutes, setWindowMinutes] = useState(String(rule.windowMinutes));
  const [enabled, setEnabled] = useState(rule.enabled);
  const [approved, setApproved] = useState(rule.approvedForProduction);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d+$/.test(threshold) && Number(threshold) >= 1 && /^\d+$/.test(windowMinutes) && Number(windowMinutes) >= 1;
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/risk/rules/${rule.code}`, {
        expectedVersion: rule.version,
        enabled,
        threshold: Number(threshold),
        windowMinutes: Number(windowMinutes),
        approvedForProduction: approved,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['risk', 'rules'] });
      toast.success(t('risk.ruleSaved'));
      onClose();
    },
    onError: (caught) => { setError(errorText(caught, t('risk.ruleFailed'))); },
  });
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t(`risk.rule.${rule.code}` as 'risk.rule.LOGIN_FAILURES')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" isLoading={save.isPending} disabled={!valid} onClick={() => { save.mutate(); }}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && <Callout tone="danger">{error}</Callout>}
        <label className="block">
          <span className="text-xs font-medium text-ink">{t('risk.threshold')}</span>
          <Input className="mt-1.5" inputMode="numeric" value={threshold} onChange={(event) => { setThreshold(event.target.value); }} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink">{t('risk.windowMinutes')}</span>
          <Input className="mt-1.5" inputMode="numeric" value={windowMinutes} onChange={(event) => { setWindowMinutes(event.target.value); }} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); }} />
          {t('risk.enabled')}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={approved} onChange={(event) => { setApproved(event.target.checked); }} />
          {t('risk.approvedForProduction')}
        </label>
      </div>
    </Modal>
  );
}

export function RiskReviewPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'OPEN') as SignalStatus | '';
  const [deciding, setDeciding] = useState<RiskSignal | null>(null);
  const [editing, setEditing] = useState<RiskRule | null>(null);
  const mayReview = can(Permission.RISK_REVIEW);
  const mayEditRules = can(Permission.RISK_RULE_WRITE);

  const signals = useQuery({
    queryKey: ['risk', 'signals', status],
    queryFn: () => api.get<{ signals: RiskSignal[] }>(`/admin/risk/signals${status === '' ? '' : `?status=${status}`}`),
  });
  const rules = useQuery({ queryKey: ['risk', 'rules'], queryFn: () => api.get<{ rules: RiskRule[] }>('/admin/risk/rules') });
  const unapproved = (rules.data?.rules ?? []).filter((rule) => rule.enabled && !rule.approvedForProduction).length;

  const signalColumns: Column<RiskSignal>[] = [
    { key: 'rule', header: t('risk.ruleColumn'), render: (row) => t(`risk.rule.${row.ruleCode}` as 'risk.rule.LOGIN_FAILURES', { defaultValue: row.ruleCode }) },
    { key: 'severity', header: t('risk.severity'), render: (row) => <Badge tone={SEVERITY_TONE[row.severity]}>{t(`risk.severityValue.${row.severity}` as 'risk.severityValue.LOW')}</Badge> },
    { key: 'subject', header: t('risk.subject'), render: (row) => <span className="font-mono text-xxs">{row.subjectType} · {row.subjectId.slice(0, 12)}</span>, secondary: true },
    { key: 'observed', header: t('risk.observed'), align: 'right', render: (row) => `${String(row.observed)} / ${String(row.threshold)}` },
    { key: 'detected', header: t('risk.detected'), render: (row) => formatDateTime(row.detectedAt), secondary: true },
    { key: 'status', header: t('risk.statusColumn'), render: (row) => <Badge tone={STATUS_TONE[row.status]}>{t(`risk.status.${row.status}` as 'risk.status.OPEN')}</Badge> },
    {
      key: 'action',
      header: <span className="sr-only">{t('risk.decide')}</span>,
      align: 'right',
      render: (row) => (mayReview ? <Button size="sm" onClick={() => { setDeciding(row); }}>{row.status === 'OPEN' ? t('risk.decide') : t('risk.override')}</Button> : null),
    },
  ];

  const ruleColumns: Column<RiskRule>[] = [
    { key: 'code', header: t('risk.ruleColumn'), render: (row) => t(`risk.rule.${row.code}` as 'risk.rule.LOGIN_FAILURES', { defaultValue: row.code }) },
    { key: 'threshold', header: t('risk.threshold'), align: 'right', render: (row) => (row.thresholdMinor === null ? String(row.threshold) : `${row.thresholdMinor} ${row.currency ?? ''}`) },
    { key: 'window', header: t('risk.windowMinutes'), align: 'right', render: (row) => String(row.windowMinutes) },
    { key: 'state', header: t('risk.statusColumn'), render: (row) => <Badge tone={row.approvedForProduction ? 'success' : 'warning'}>{row.enabled ? (row.approvedForProduction ? t('risk.approved') : t('risk.placeholder')) : t('risk.disabled')}</Badge> },
    { key: 'edit', header: <span className="sr-only">{t('common.edit')}</span>, align: 'right', render: (row) => (mayEditRules ? <Button size="sm" onClick={() => { setEditing(row); }}>{t('common.edit')}</Button> : null) },
  ];

  return (
    <>
      <PageHeader title={t('risk.title')} description={t('risk.description')} />
      {unapproved > 0 && (
        <Callout tone="warning" title={t('risk.placeholderTitle')}>
          {t('risk.placeholderBody', { rules: String(unapproved) })}
        </Callout>
      )}
      <Card>
        <Toolbar>
          <ToolbarField label={t('risk.statusColumn')}>
            <Select
              className="w-48"
              value={status}
              onChange={(event) => { setParams(event.target.value === 'OPEN' ? {} : { status: event.target.value }); }}
            >
              {(['OPEN', 'CONFIRMED', 'FALSE_POSITIVE'] as const).map((value) => (
                <option key={value} value={value}>{t(`risk.status.${value}` as 'risk.status.OPEN')}</option>
              ))}
              <option value="">{t('risk.anyStatus')}</option>
            </Select>
          </ToolbarField>
        </Toolbar>
        <DataTable
          caption={t('risk.signalsCaption')}
          columns={signalColumns}
          rows={signals.data?.signals ?? []}
          rowKey={(row) => row.id}
          isLoading={signals.isLoading}
          error={signals.error}
          onRetry={() => { void signals.refetch(); }}
          isForbidden={signals.error instanceof ApiError && signals.error.status === 403}
          emptyTitle={t('risk.emptyTitle')}
          emptyDescription={t('risk.emptyBody')}
        />
      </Card>
      <Card className="mt-6">
        <h2 className="mb-3 text-title-xs text-ink">{t('risk.rulesHeading')}</h2>
        <DataTable
          caption={t('risk.rulesHeading')}
          columns={ruleColumns}
          rows={rules.data?.rules ?? []}
          rowKey={(row) => row.code}
          isLoading={rules.isLoading}
          error={rules.error}
          onRetry={() => { void rules.refetch(); }}
          emptyTitle={t('risk.rulesEmpty')}
        />
      </Card>
      {deciding !== null && <DecisionDialog signal={deciding} onClose={() => { setDeciding(null); }} />}
      {editing !== null && <RuleDialog rule={editing} onClose={() => { setEditing(null); }} />}
    </>
  );
}
