/**
 * Country launch readiness (Doc 08 s10-11).
 *
 * Every country starts disabled. Each launch decision has an owner, evidence,
 * and - where it lapses - an expiry; a different person reviews it, and only
 * when nothing is open will the server enable the country. The evidence is
 * internal and confidential.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { commercialApi, LAUNCH_EDIT_STATUSES, type LaunchCountry, type LaunchDecision } from '@/lib/commercial-policy';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, dateInput, isoOrNull } from './format';
import { AreaField, RefusalCallout, StatusBadge, TextActionDialog, TextField } from './shared';

function LaunchNotice(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Callout tone="warning" title={t('commercial.launch.noticeTitle')}>
      {t('commercial.launch.noticeBody')}
    </Callout>
  );
}

export function LaunchReadinessPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['commercial', 'launch'], queryFn: commercialApi.launches });
  const columns: Column<LaunchCountry>[] = [
    { key: 'country', header: t('commercial.launch.country'), render: (row) => <Link className="font-medium text-accent hover:underline" to={`/commercial/launch/${row.code}`}>{row.name} ({row.code})</Link> },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'open', header: t('commercial.launch.openDecisions'), align: 'right', render: (row) => `${String(row.open)} / ${String(row.required)}` },
    { key: 'eu', header: t('commercial.launch.euVat'), secondary: true, render: (row) => (row.isEuVat ? t('commercial.yes') : t('commercial.no')) },
  ];
  return (
    <>
      <PageHeader title={t('commercial.launch.title')} description={t('commercial.launch.description')} />
      <LaunchNotice />
      <Card className="mt-4">
        <DataTable caption={t('commercial.launch.title')} columns={columns} rows={query.data?.countries} rowKey={(row) => row.code} isLoading={query.isLoading} error={query.error} onRetry={() => { void query.refetch(); }} emptyTitle={t('commercial.empty')} />
      </Card>
    </>
  );
}

function EditDecisionDialog({ countryCode, decision, onClose }: { countryCode: string; decision: LaunchDecision; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const item = decision.item;
  const [status, setStatus] = useState<string>(item !== null && (LAUNCH_EDIT_STATUSES as readonly string[]).includes(item.status) ? item.status : 'IN_PROGRESS');
  const [owner, setOwner] = useState(item?.ownerName ?? '');
  const [scope, setScope] = useState(item?.scope ?? '');
  const [evidence, setEvidence] = useState(item?.evidence ?? '');
  const [expires, setExpires] = useState(dateInput(item?.expiresAt));
  const [checked, setChecked] = useState(dateInput(item?.sourceCheckedOn));
  const [sourceNote, setSourceNote] = useState(item?.sourceNote ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const blank = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await commercialApi.saveLaunchItem(countryCode, decision.key, { status, ownerName: blank(owner), scope: blank(scope), evidence: blank(evidence), expiresAt: isoOrNull(expires), sourceCheckedOn: isoOrNull(checked), sourceNote: blank(sourceNote) });
      await queryClient.invalidateQueries({ queryKey: ['commercial', 'launch'] });
      toast.success(t('commercial.saved'));
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen size="lg" onClose={onClose} title={decision.title} description={decision.source} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" isLoading={busy} onClick={() => { void save(); }}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <RefusalCallout error={error} />
        <label className="block">
          <span className="text-sm font-medium text-ink">{t('commercial.statusLabel')}</span>
          <Select className="mt-1.5" value={status} onChange={(event) => { setStatus(event.target.value); }}>
            {LAUNCH_EDIT_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`commercial.status.${s}` as TranslationKey)}</option>
            ))}
          </Select>
        </label>
        <TextField label={t('commercial.launch.ownerName')} value={owner} onChange={setOwner} />
        <AreaField label={t('commercial.launch.scope')} value={scope} onChange={setScope} />
        <AreaField label={t('commercial.evidence')} hint={t('commercial.launch.evidenceHint')} value={evidence} onChange={setEvidence} rows={5} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField type="date" label={t('commercial.launch.expiry')} value={expires} onChange={setExpires} />
          <TextField type="date" label={t('commercial.launch.sourceCheckedOn')} value={checked} onChange={setChecked} />
        </div>
        <AreaField label={t('commercial.launch.sourceNote')} value={sourceNote} onChange={setSourceNote} />
      </div>
    </Modal>
  );
}

export function LaunchCountryPage(): React.JSX.Element {
  const { countryCode = '' } = useParams();
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mayEdit = can(Permission.SETTINGS_WRITE);
  const mayReview = can(Permission.FEATURE_FLAG_WRITE);
  const [editing, setEditing] = useState<LaunchDecision | null>(null);
  const [reviewing, setReviewing] = useState<{ decision: LaunchDecision; approve: boolean } | null>(null);
  const [toggle, setToggle] = useState<boolean | null>(null);
  const query = useQuery({ queryKey: ['commercial', 'launch', countryCode], queryFn: () => commercialApi.launch(countryCode) });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['commercial', 'launch'] });
  };
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data;
  const enabled = d.launch.status === 'ENABLED';

  const columns: Column<LaunchDecision>[] = [
    {
      key: 'title',
      header: t('commercial.title'),
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.title}</p>
          {row.citedSources.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {row.citedSources.map((url) => (
                <li key={url}>
                  <a className="break-all text-xxs text-accent hover:underline" href={url} target="_blank" rel="noreferrer noopener">{url}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    { key: 'source', header: t('commercial.source'), secondary: true, render: (row) => row.source },
    { key: 'owner', header: t('commercial.launch.owner'), secondary: true, render: (row) => row.item?.ownerName ?? row.owner },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.item?.status ?? 'NOT_STARTED'} /> },
    { key: 'evidence', header: t('commercial.evidence'), tertiary: true, render: (row) => (row.item?.evidence ? <span className="line-clamp-3">{row.item.evidence}</span> : '—') },
    { key: 'expiry', header: t('commercial.launch.expiry'), tertiary: true, nowrap: true, render: (row) => (row.expires ? formatDate(row.item?.expiresAt) : t('commercial.launch.noExpiry')) },
    { key: 'blocker', header: t('commercial.launch.blocker'), render: (row) => (row.blocker === null ? <Badge tone="success">{t('commercial.launch.clear')}</Badge> : <Badge tone="warning">{codeLabel(t, row.blocker)}</Badge>) },
    {
      key: 'actions',
      header: <span className="sr-only">{t('commercial.actions')}</span>,
      align: 'right',
      render: (row) => (
        <div className="flex flex-wrap justify-end gap-1">
          {mayEdit && <Button size="sm" onClick={() => { setEditing(row); }}>{t('common.edit')}</Button>}
          {mayReview && row.item !== null && <Button size="sm" onClick={() => { setReviewing({ decision: row, approve: true }); }}>{t('commercial.approve')}</Button>}
          {mayReview && row.item !== null && <Button size="sm" variant="ghost" onClick={() => { setReviewing({ decision: row, approve: false }); }}>{t('commercial.reject')}</Button>}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={`${d.country.name} (${d.country.code})`}
        description={t('commercial.launch.countryDescription')}
        back={{ to: '/commercial/launch', label: t('commercial.launch.title') }}
        meta={<StatusBadge status={d.launch.status} />}
        actions={mayReview ? <Button variant={enabled ? 'danger' : 'primary'} onClick={() => { setToggle(!enabled); }}>{enabled ? t('commercial.launch.disable') : t('commercial.launch.enable')}</Button> : undefined}
      />
      <LaunchNotice />
      <Callout tone="info" className="mt-3">{d.notice}</Callout>
      <Card className="mt-4">
        <DataTable caption={t('commercial.launch.decisions')} columns={columns} rows={d.decisions} rowKey={(row) => row.key} emptyTitle={t('commercial.empty')} />
      </Card>
      {editing !== null && <EditDecisionDialog countryCode={d.country.code} decision={editing} onClose={() => { setEditing(null); }} />}
      {reviewing !== null && (
        <TextActionDialog
          title={reviewing.approve ? t('commercial.approve') : t('commercial.reject')}
          description={`${reviewing.decision.title} — ${t('commercial.secondPerson')}`}
          label={t('commercial.note')}
          minLength={3}
          isDangerous={!reviewing.approve}
          confirmLabel={reviewing.approve ? t('commercial.approve') : t('commercial.reject')}
          onClose={() => { setReviewing(null); }}
          onSubmit={async (note) => {
            await commercialApi.reviewLaunchItem(d.country.code, reviewing.decision.key, { approve: reviewing.approve, note });
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
      {toggle !== null && (
        <TextActionDialog
          title={toggle ? t('commercial.launch.enable') : t('commercial.launch.disable')}
          description={toggle ? t('commercial.launch.enableBody') : undefined}
          label={t('commercial.note')}
          minLength={3}
          isDangerous={!toggle}
          confirmLabel={toggle ? t('commercial.launch.enable') : t('commercial.launch.disable')}
          onClose={() => { setToggle(null); }}
          onSubmit={async (note) => {
            await commercialApi.setCountry(d.country.code, toggle, note);
            toast.success(t('commercial.saved'));
            await refresh();
          }}
        />
      )}
    </>
  );
}
