/**
 * A dispute's case controls (Doc 07 s9-10): category, urgency, late intake,
 * the administrative clocks, evidence requests, independent testing, the
 * reasoned decision with its remedies, the appeal reviewer and loss
 * recoveries. The platform administers the case; it is not a tribunal, and
 * the legal notice says so on every case.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, CheckboxField, DescriptionList, Input, LoadingState, ErrorState, Select } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { commercialApi, DECISION_PARTIES, RECOVERY_SOURCES, REMEDY_KINDS, TESTING_PAYERS, type CaseControls } from '@/lib/commercial-policy';
import { formatDateTime, majorToMinor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, isoOrNull, money } from '@/pages/commercial/format';
import { AreaField, FormDialog, RefusalCallout, SelectField, TextActionDialog, TextField } from '@/pages/commercial/shared';

type Dialog = 'sufficient' | 'request' | 'testing' | 'decision' | 'reviewer' | 'recovery' | { remedyId: string } | null;

interface RemedyRow {
  kind: string;
  amount: string;
  payer: string;
  quantity: string;
}

function partyOptions(t: ReturnType<typeof useI18n>['t'], parties: readonly string[]): { value: string; label: string }[] {
  return parties.map((p) => ({ value: p, label: codeLabel(t, p) }));
}

function DecisionForm({ c, onClose, onDone }: { c: CaseControls; onClose: () => void; onDone: () => Promise<void> }): React.JSX.Element {
  const { t } = useI18n();
  const [reasoning, setReasoning] = useState('');
  const [rows, setRows] = useState<RemedyRow[]>([{ kind: 'REFUND', amount: '', payer: 'SELLER', quantity: '' }]);
  const [freightPayer, setFreightPayer] = useState('');
  const [completion, setCompletion] = useState('');
  const set = (i: number, patch: Partial<RemedyRow>): void => {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const rowsValid = rows.every((r) => (r.amount.trim() === '' || majorToMinor(r.amount) !== null) && (r.quantity.trim() === '' || /^\d+$/.test(r.quantity.trim())));
  return (
    <FormDialog
      title={t('commercial.case.decision')}
      onClose={onClose}
      canSave={reasoning.trim().length > 0 && rowsValid}
      onSave={async () => {
        await commercialApi.caseAction(
          c.dispute.id,
          'decision',
          {
            reasoning: reasoning.trim(),
            remedies: rows.map((r) => ({
              kind: r.kind,
              amountMinor: r.amount.trim() === '' ? null : majorToMinor(r.amount),
              currency: r.amount.trim() === '' ? null : c.dispute.currency,
              payer: r.payer,
              quantity: r.quantity.trim() === '' ? null : Number(r.quantity.trim()),
            })),
            returnFreightPayer: freightPayer === '' ? null : freightPayer,
            expectedCompletionAt: isoOrNull(completion),
          },
          'put',
        );
        await onDone();
      }}
    >
      <AreaField label={t('commercial.case.reasoning')} value={reasoning} onChange={setReasoning} rows={6} required />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">{t('commercial.case.remedies')}</legend>
        {rows.map((row, i) => (
          <div key={`remedy-${String(i)}`} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
            <SelectField label={t('commercial.kindLabel')} value={row.kind} onChange={(x) => { set(i, { kind: x }); }} options={REMEDY_KINDS.map((k) => ({ value: k, label: codeLabel(t, k) }))} />
            <SelectField label={t('commercial.case.payer')} value={row.payer} onChange={(x) => { set(i, { payer: x }); }} options={partyOptions(t, DECISION_PARTIES)} />
            <TextField label={t('commercial.amountMajor', { currency: c.dispute.currency })} value={row.amount} onChange={(x) => { set(i, { amount: x }); }} />
            <TextField label={t('commercial.case.quantity')} value={row.quantity} onChange={(x) => { set(i, { quantity: x }); }} />
            <div className="sm:col-span-2">
              <Button size="sm" variant="ghost" onClick={() => { setRows(rows.filter((_, j) => j !== i)); }}>{t('commercial.remove')}</Button>
            </div>
          </div>
        ))}
        {rows.length < 10 && <Button size="sm" onClick={() => { setRows([...rows, { kind: 'REPAIR', amount: '', payer: 'SELLER', quantity: '' }]); }}>{t('commercial.case.addRemedy')}</Button>}
      </fieldset>
      <SelectField label={t('commercial.case.returnFreightPayer')} value={freightPayer} onChange={setFreightPayer} options={[{ value: '', label: '—' }, ...partyOptions(t, DECISION_PARTIES)]} />
      <TextField type="date" label={t('commercial.case.expectedCompletion')} value={completion} onChange={setCompletion} />
    </FormDialog>
  );
}

export function CaseControlsCard({ disputeId }: { disputeId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mayManage = can(Permission.DISPUTE_MANAGE);
  const mayApprove = can(Permission.DISPUTE_APPROVE);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [request, setRequest] = useState({ requestedFrom: 'SELLER', purpose: 'EVIDENCE', description: '', proportionalityNote: '' });
  const [testing, setTesting] = useState({ laboratory: '', protocol: '', agreedByBuyer: false, agreedBySeller: false, interimPayer: 'PLATFORM', cost: '', resultSummary: '', finalPayer: '' });
  const [reviewer, setReviewer] = useState('');
  const [recovery, setRecovery] = useState({ lossKey: '', loss: '', source: 'CARRIER', sourceReference: '', amount: '' });
  const key = ['admin', 'dispute', disputeId, 'case-controls'];
  const query = useQuery({ queryKey: key, queryFn: () => commercialApi.caseControls(disputeId) });
  const assignees = useQuery({
    queryKey: ['admin', 'disputes', 'assignees'],
    queryFn: () => commercialApi.caseAssignees(),
    enabled: mayApprove,
    retry: false,
  });
  const done = async (): Promise<void> => {
    toast.success(t('commercial.saved'));
    await queryClient.invalidateQueries({ queryKey: key });
  };
  const close = (): void => {
    setDialog(null);
  };

  if (query.isLoading) return <Card title={t('commercial.case.title')}><LoadingState /></Card>;
  if (query.error !== null || query.data === undefined) return <Card title={t('commercial.case.title')}><ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /></Card>;
  const c = query.data;
  // A profile is created on first read; a response without one has nothing to show.
  if (c.profile === null || typeof c.profile !== 'object') return null;
  const p = c.profile;
  const acknowledge = async (): Promise<void> => {
    setActionError(null);
    try {
      await commercialApi.caseAction(disputeId, 'acknowledge');
      await done();
    } catch (caught) {
      setActionError(caught);
    }
  };
  const reviewerOptions = assignees.data?.assignees ?? [];

  return (
    <Card title={t('commercial.case.title')} className="mt-4" bodyClassName="space-y-4 px-5 py-4 text-sm">
      <Callout tone="info">{t('commercial.case.legalNotice')}</Callout>
      <RefusalCallout error={actionError} />
      <DescriptionList
        columns={3}
        items={[
          { label: t('commercial.case.category'), value: codeLabel(t, p.category) },
          { label: t('commercial.case.urgency'), value: codeLabel(t, p.urgency) },
          { label: t('commercial.case.lateIntake'), value: p.lateIntake ? <Badge tone="warning">{p.lateIntakeReason === null ? t('commercial.yes') : codeLabel(t, p.lateIntakeReason)}</Badge> : t('commercial.no') },
          { label: t('commercial.case.ackDue'), value: formatDateTime(p.acknowledgementDueAt) },
          { label: t('commercial.case.acknowledged'), value: p.acknowledgedAt === null ? t('commercial.case.notYet') : formatDateTime(p.acknowledgedAt) },
          { label: t('commercial.case.evidenceSufficient'), value: p.evidenceSufficientAt === null ? t('commercial.case.notYet') : `${formatDateTime(p.evidenceSufficientAt)}${p.evidenceSufficientReason ? ` — ${p.evidenceSufficientReason}` : ''}` },
          { label: t('commercial.case.decisionDue'), value: formatDateTime(p.initialDecisionDueAt) },
          { label: t('commercial.case.appealDue'), value: formatDateTime(p.appealReviewDueAt) },
          { label: t('commercial.case.appealReviewer'), value: p.appealReviewerId === null ? '—' : (reviewerOptions.find((a) => a.id === p.appealReviewerId)?.email ?? p.appealReviewerId) },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        {mayManage && p.acknowledgedAt === null && <Button onClick={() => { void acknowledge(); }}>{t('commercial.case.acknowledge')}</Button>}
        {mayManage && p.evidenceSufficientAt === null && <Button onClick={() => { setDialog('sufficient'); }}>{t('commercial.case.markSufficient')}</Button>}
        {mayManage && <Button onClick={() => { setDialog('request'); }}>{t('commercial.case.requestEvidence')}</Button>}
        {mayManage && <Button onClick={() => { setDialog('testing'); }}>{t('commercial.case.testing')}</Button>}
        {mayManage && <Button variant="primary" onClick={() => { setDialog('decision'); }}>{t('commercial.case.decision')}</Button>}
        {mayApprove && <Button onClick={() => { setDialog('reviewer'); }}>{t('commercial.case.assignReviewer')}</Button>}
        {can(Permission.REFUND_CREATE) && <Button onClick={() => { setDialog('recovery'); }}>{t('commercial.case.recordRecovery')}</Button>}
      </div>

      {c.requests.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-ink">{t('commercial.case.requests')}</h3>
          <ul className="space-y-1">
            {c.requests.map((r) => (
              <li key={r.id}>{codeLabel(t, r.requestedFrom)} · {codeLabel(t, r.purpose)} · {r.description} · {t('commercial.due')}: {formatDateTime(r.dueAt)} · {codeLabel(t, r.status)}</li>
            ))}
          </ul>
        </section>
      )}
      {c.testing.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-ink">{t('commercial.case.testing')}</h3>
          <ul className="space-y-1">
            {c.testing.map((r) => (
              <li key={r.id}>{r.laboratory} · {money(r.costMinor, r.currency)} · {codeLabel(t, r.interimPayer)}{r.finalPayer === null ? '' : ` → ${codeLabel(t, r.finalPayer)}`} · {codeLabel(t, r.status)}</li>
            ))}
          </ul>
        </section>
      )}
      {c.remedies.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-ink">{t('commercial.case.remedies')}</h3>
          <ul className="space-y-1">
            {c.remedies.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span>{codeLabel(t, r.kind)} · {money(r.amountMinor, r.currency)} · {codeLabel(t, r.payer)} · {t('commercial.case.expectedBy', { date: formatDateTime(r.expectedCompletionAt) })}</span>
                <Badge tone={r.status === 'COMPLETED' ? 'success' : 'warning'}>{codeLabel(t, r.status)}</Badge>
                {mayManage && r.completedAt === null && <Button size="sm" onClick={() => { setDialog({ remedyId: r.id }); }}>{t('commercial.case.completeRemedy')}</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {c.recoveries.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-ink">{t('commercial.case.recoveries')}</h3>
          <ul className="space-y-1">
            {c.recoveries.map((r) => (
              <li key={r.id}>{codeLabel(t, r.source)} · {r.sourceReference} · {money(r.amountMinor, r.currency)}{r.overlapNote === null ? '' : ` · ${t('commercial.case.overlap')}: ${r.overlapNote}`}</li>
            ))}
          </ul>
        </section>
      )}

      {dialog === 'sufficient' && (
        <TextActionDialog title={t('commercial.case.markSufficient')} description={t('commercial.case.sufficientBody')} label={t('commercial.reason')} minLength={10} confirmLabel={t('common.save')} onClose={close} onSubmit={async (reason) => { await commercialApi.caseAction(disputeId, 'evidence-sufficient', { reason }); await done(); }} />
      )}
      {dialog === 'request' && (
        <FormDialog
          title={t('commercial.case.requestEvidence')}
          onClose={close}
          canSave={request.description.trim().length >= 5 && request.proportionalityNote.trim().length >= 5}
          onSave={async () => {
            await commercialApi.caseAction(disputeId, 'evidence-requests', { ...request, description: request.description.trim(), proportionalityNote: request.proportionalityNote.trim() });
            await done();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label={t('commercial.case.requestedFrom')} value={request.requestedFrom} onChange={(x) => { setRequest({ ...request, requestedFrom: x }); }} options={partyOptions(t, ['BUYER', 'SELLER', 'PROVIDER'])} />
            <SelectField label={t('commercial.case.purpose')} value={request.purpose} onChange={(x) => { setRequest({ ...request, purpose: x }); }} options={partyOptions(t, ['EVIDENCE', 'MATERIAL_CONTRARY_EVIDENCE', 'SELLER_RESPONSE'])} />
          </div>
          <AreaField label={t('commercial.description')} value={request.description} onChange={(x) => { setRequest({ ...request, description: x }); }} required />
          <AreaField label={t('commercial.case.proportionality')} value={request.proportionalityNote} onChange={(x) => { setRequest({ ...request, proportionalityNote: x }); }} required />
        </FormDialog>
      )}
      {dialog === 'testing' && (
        <FormDialog
          title={t('commercial.case.testing')}
          onClose={close}
          canSave={testing.laboratory.trim().length >= 2 && testing.protocol.trim().length >= 5 && majorToMinor(testing.cost) !== null}
          onSave={async () => {
            await commercialApi.caseAction(
              disputeId,
              'testing',
              {
                laboratory: testing.laboratory.trim(),
                protocol: testing.protocol.trim(),
                agreedByBuyer: testing.agreedByBuyer,
                agreedBySeller: testing.agreedBySeller,
                interimPayer: testing.interimPayer,
                costMinor: majorToMinor(testing.cost),
                currency: c.dispute.currency,
                resultSummary: testing.resultSummary.trim() === '' ? null : testing.resultSummary.trim(),
                finalPayer: testing.finalPayer === '' ? null : testing.finalPayer,
              },
              'put',
            );
            await done();
          }}
        >
          <TextField label={t('commercial.case.laboratory')} value={testing.laboratory} onChange={(x) => { setTesting({ ...testing, laboratory: x }); }} required />
          <AreaField label={t('commercial.case.protocol')} value={testing.protocol} onChange={(x) => { setTesting({ ...testing, protocol: x }); }} required />
          <CheckboxField label={t('commercial.case.agreedByBuyer')} checked={testing.agreedByBuyer} onChange={(event) => { setTesting({ ...testing, agreedByBuyer: event.target.checked }); }} />
          <CheckboxField label={t('commercial.case.agreedBySeller')} checked={testing.agreedBySeller} onChange={(event) => { setTesting({ ...testing, agreedBySeller: event.target.checked }); }} />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField label={t('commercial.case.interimPayer')} value={testing.interimPayer} onChange={(x) => { setTesting({ ...testing, interimPayer: x }); }} options={partyOptions(t, TESTING_PAYERS)} />
            <SelectField label={t('commercial.case.finalPayer')} value={testing.finalPayer} onChange={(x) => { setTesting({ ...testing, finalPayer: x }); }} options={[{ value: '', label: '—' }, ...partyOptions(t, TESTING_PAYERS)]} />
            <TextField label={t('commercial.amountMajor', { currency: c.dispute.currency })} value={testing.cost} onChange={(x) => { setTesting({ ...testing, cost: x }); }} required />
          </div>
          <AreaField label={t('commercial.case.resultSummary')} value={testing.resultSummary} onChange={(x) => { setTesting({ ...testing, resultSummary: x }); }} />
        </FormDialog>
      )}
      {dialog === 'decision' && <DecisionForm c={c} onClose={close} onDone={done} />}
      {dialog === 'reviewer' && (
        <FormDialog title={t('commercial.case.assignReviewer')} onClose={close} canSave={reviewer.trim().length === 26} onSave={async () => { await commercialApi.caseAction(disputeId, 'appeal-reviewer', { reviewerUserId: reviewer.trim() }); await done(); }}>
          <Callout tone="info">{t('commercial.case.reviewerIndependent')}</Callout>
          {reviewerOptions.length > 0 ? (
            <label className="block">
              <span className="text-sm font-medium text-ink">{t('commercial.case.appealReviewer')}</span>
              <Select className="mt-1.5" value={reviewer} onChange={(event) => { setReviewer(event.target.value); }}>
                <option value="">—</option>
                {reviewerOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.email}</option>
                ))}
              </Select>
            </label>
          ) : (
            <label className="block">
              <span className="text-sm font-medium text-ink">{t('commercial.case.reviewerUserId')}</span>
              <Input className="mt-1.5" value={reviewer} onChange={(event) => { setReviewer(event.target.value); }} />
            </label>
          )}
        </FormDialog>
      )}
      {dialog === 'recovery' && (
        <FormDialog
          title={t('commercial.case.recordRecovery')}
          onClose={close}
          canSave={recovery.lossKey.trim() !== '' && recovery.sourceReference.trim() !== '' && majorToMinor(recovery.loss) !== null && majorToMinor(recovery.amount) !== null}
          onSave={async () => {
            await commercialApi.lossRecovery(c.dispute.orderId, {
              disputeId,
              lossKey: recovery.lossKey.trim(),
              lossMinor: majorToMinor(recovery.loss),
              source: recovery.source,
              sourceReference: recovery.sourceReference.trim(),
              amountMinor: majorToMinor(recovery.amount),
              currency: c.dispute.currency,
            });
            await done();
          }}
        >
          <Callout tone="info">{t('commercial.case.overlapNote')}</Callout>
          <TextField label={t('commercial.case.lossKey')} hint={t('commercial.case.lossKeyHint')} value={recovery.lossKey} onChange={(x) => { setRecovery({ ...recovery, lossKey: x }); }} required />
          <TextField label={t('commercial.case.lossAmount', { currency: c.dispute.currency })} value={recovery.loss} onChange={(x) => { setRecovery({ ...recovery, loss: x }); }} required />
          <SelectField label={t('commercial.source')} value={recovery.source} onChange={(x) => { setRecovery({ ...recovery, source: x }); }} options={partyOptions(t, RECOVERY_SOURCES)} />
          <TextField label={t('commercial.reference')} value={recovery.sourceReference} onChange={(x) => { setRecovery({ ...recovery, sourceReference: x }); }} required />
          <TextField label={t('commercial.amountMajor', { currency: c.dispute.currency })} value={recovery.amount} onChange={(x) => { setRecovery({ ...recovery, amount: x }); }} required />
        </FormDialog>
      )}
      {dialog !== null && typeof dialog === 'object' && (
        <TextActionDialog
          title={t('commercial.case.completeRemedy')}
          label={t('commercial.note')}
          minLength={0}
          confirmLabel={t('commercial.case.completeRemedy')}
          onClose={close}
          onSubmit={async (note) => {
            await commercialApi.completeRemedy(dialog.remedyId, { note: note === '' ? null : note });
            await done();
          }}
        />
      )}
    </Card>
  );
}
