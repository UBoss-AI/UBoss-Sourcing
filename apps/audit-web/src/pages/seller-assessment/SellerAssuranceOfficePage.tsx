/**
 * Seller assurance, across every seller: policy versions and their adoption,
 * who holds which assessment capability, what enforcing the purchase gate
 * would block, legacy reassessment, the notice / appeal / change / incident /
 * bank-change registers, held orders, surveillance tasks and retention.
 *
 * Adoption records the reference to the real decision; the software never
 * supplies a name, a signature or an approval of its own.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MutationError, QueryBoundary, Tabs } from '@/components/console';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  CAPABILITIES,
  assessmentKeys,
  fetchCapabilities,
  fetchDispositions,
  fetchImpact,
  fetchPolicies,
  fetchRegisters,
  fetchRetention,
  fetchTasks,
  post,
  put,
  type Policy,
} from '@/lib/seller-assessment';
import { useConsoleMutation } from '@/lib/use-console-mutation';

type Tab = 'policy' | 'capabilities' | 'impact' | 'registers' | 'dispositions' | 'surveillance' | 'retention';
const TABS: Tab[] = ['policy', 'capabilities', 'impact', 'registers', 'dispositions', 'surveillance', 'retention'];
const tk = (key: string) => key as TranslationKey;
const ALL = [assessmentKeys.all] as const;

export function SellerAssuranceOfficePage(): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('policy');
  return (
    <>
      <PageHeader title={t('sa.assurance.title')} description={t('sa.assurance.description')} back={{ to: '/seller-assessments', label: t('sa.title') }} />
      <Tabs label={t('sa.assurance.title')} tabs={TABS.map((key) => ({ key, label: t(tk(`sa.assurance.tab.${key}`)) }))} selected={tab} onSelect={setTab}>
        {tab === 'policy' && <PolicyTab />}
        {tab === 'capabilities' && <CapabilitiesTab />}
        {tab === 'impact' && <ImpactTab />}
        {tab === 'registers' && <RegistersTab />}
        {tab === 'dispositions' && <DispositionsTab />}
        {tab === 'surveillance' && <SurveillanceTab />}
        {tab === 'retention' && <RetentionTab />}
      </Tabs>
    </>
  );
}

function PolicyTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.policies(), queryFn: fetchPolicies });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <div className="space-y-4">
          <Callout tone={data.inForce.status === 'ADOPTED' ? 'success' : 'warning'}>{t(data.inForce.status === 'ADOPTED' ? 'sa.policy.inForce' : 'sa.policy.draftOnly', { version: data.inForce.version })}</Callout>
          <Callout tone="info">{t('sa.policy.gateMode', { mode: data.gateMode })}</Callout>
          {data.versions.map((p) => <PolicyCard key={p.id} p={p} />)}
        </div>
      )}
    </QueryBoundary>
  );
}

function PolicyCard({ p }: { p: Policy }): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState({ adoptionReference: '', effectiveFrom: '', disclosureReference: '', disclosedAt: '' });
  const iso = (d: string) => (d === '' ? null : new Date(`${d}T00:00:00Z`).toISOString());
  const adopt = useConsoleMutation({ mutationFn: (_v, key) => post(`/policies/${p.id}/adopt`, { adoptionReference: form.adoptionReference, effectiveFrom: iso(form.effectiveFrom), disclosureReference: form.disclosureReference === '' ? null : form.disclosureReference, disclosedAt: iso(form.disclosedAt) }, key), invalidate: ALL, successMessage: t('sa.saved') });
  const disclose = useConsoleMutation({ mutationFn: (_v, key) => post(`/policies/${p.id}/disclose`, { disclosureReference: form.disclosureReference, disclosedAt: iso(form.disclosedAt) }, key), invalidate: ALL, successMessage: t('sa.saved') });
  return (
    <Card title={t('sa.policy.version', { version: p.version })} actions={<Badge tone={p.status === 'ADOPTED' ? 'success' : 'warning'}>{t(tk(`sa.policyStatus.${p.status}`))}</Badge>} bodyClassName="space-y-3 px-5 py-4">
      <p className="text-sm">{p.sourceDocument}</p>
      {p.note !== null && <p className="text-xs text-ink-muted">{p.note}</p>}
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        {Object.entries(p.configJson).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-muted">{t(tk(`sa.config.${k}`))}</dt>
            <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v as string | number)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink-muted">{t('sa.policy.commercialVsMandatory')}</p>
      <p className="text-sm">{t('sa.policy.adoption', { reference: p.adoptionReference ?? '—', from: formatDate(p.effectiveFrom), disclosed: p.disclosureReference ?? '—' })}</p>
      {p.status !== 'RETIRED' && (
        <div className="grid gap-3 sm:grid-cols-4">
          {(Object.keys(form) as (keyof typeof form)[]).map((f) => (
            <Field key={f} label={t(tk(`sa.policy.${f}`))}>
              {({ inputId }) => <Input id={inputId} type={f === 'effectiveFrom' || f === 'disclosedAt' ? 'date' : 'text'} value={form[f]} onChange={(e) => { setForm({ ...form, [f]: e.target.value }); }} />}
            </Field>
          ))}
          <div className="flex flex-wrap gap-2 sm:col-span-4">
            {p.status === 'DRAFT' && <Button variant="primary" disabled={form.adoptionReference.trim().length < 3 || form.effectiveFrom === '' || adopt.isPending} onClick={() => { adopt.mutate(); }}>{t('sa.policy.recordAdoption')}</Button>}
            {p.status === 'ADOPTED' && <Button variant="secondary" disabled={form.disclosureReference.trim().length < 3 || form.disclosedAt === '' || disclose.isPending} onClick={() => { disclose.mutate(); }}>{t('sa.policy.recordDisclosure')}</Button>}
          </div>
          <div className="sm:col-span-4"><MutationError error={adopt.error ?? disclose.error} /></div>
        </div>
      )}
    </Card>
  );
}

function CapabilitiesTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.capabilities(), queryFn: fetchCapabilities });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <Card title={t('sa.capabilities.title')} description={t('sa.capabilities.description')} bodyClassName="divide-y divide-border-subtle">
          {data.staff.map((s) => <CapabilityRow key={s.userId} s={s} />)}
        </Card>
      )}
    </QueryBoundary>
  );
}

function CapabilityRow({ s }: { s: { userId: string; fullName: string; role: string; capabilities: string[] } }): React.JSX.Element {
  const { t } = useI18n();
  const [caps, setCaps] = useState<string[]>(s.capabilities);
  const save = useConsoleMutation({ mutationFn: (_v, key) => put(`/capabilities/${s.userId}`, { capabilities: caps }, key), invalidate: [assessmentKeys.capabilities()], successMessage: t('sa.saved') });
  return (
    <fieldset className="space-y-2 px-5 py-3">
      <legend className="text-sm font-medium">{s.fullName} · {s.role}</legend>
      <div className="flex flex-wrap gap-3">
        {CAPABILITIES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={caps.includes(c)} onChange={(e) => { setCaps(e.target.checked ? [...caps, c] : caps.filter((x) => x !== c)); }} />
            {t(tk(`sa.capability.${c}`))}
          </label>
        ))}
      </div>
      <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => { save.mutate(); }}>{t('sa.capabilities.save')}</Button>
      <MutationError error={save.error} />
    </fieldset>
  );
}

function ImpactTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.impact(), queryFn: fetchImpact });
  const legacy = useConsoleMutation({ mutationFn: (_v, key) => post('/legacy-reassessments', {}, key), invalidate: ALL, successMessage: (r: unknown) => t('sa.impact.legacyOpened', { opened: String((r as { opened: number }).opened) }) });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <div className="space-y-4">
          <Callout tone="warning">{t('sa.impact.summary', { mode: data.gateMode, offers: String(data.activeOffers), blocked: String(data.offersThatWouldBlock), sellers: String(data.sellers) })}</Callout>
          <p className="text-xs text-ink-muted">{t('sa.impact.note')}</p>
          <Card title={t('sa.impact.legacy')} description={t('sa.impact.legacyHint')} bodyClassName="px-5 py-4">
            <Button variant="secondary" disabled={legacy.isPending} onClick={() => { legacy.mutate(); }}>{t('sa.impact.openLegacy')}</Button>
            <MutationError error={legacy.error} />
          </Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">{t('sa.impact.caption')}</caption>
              <thead><tr className="text-left text-xs text-ink-muted"><th className="px-3 py-2">{t('sa.queue.seller')}</th><th className="px-3 py-2">{t('sa.impact.offers')}</th><th className="px-3 py-2">{t('sa.impact.covered')}</th><th className="px-3 py-2">{t('sa.impact.wouldBlock')}</th><th className="px-3 py-2">{t('sa.impact.approval')}</th></tr></thead>
              <tbody className="divide-y divide-border-subtle">
                {data.rows.map((r) => (
                  <tr key={r.sellerAccountId}><td className="px-3 py-2">{r.seller}</td><td className="px-3 py-2">{r.offers}</td><td className="px-3 py-2">{r.covered}</td><td className="px-3 py-2">{r.wouldBlock}</td><td className="px-3 py-2">{r.hasApproval ? t('sa.yes') : t('sa.no')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

function Decide({ path, options, label }: { path: string; options: string[]; label: string }): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState(options[0] ?? '');
  const [reason, setReason] = useState('');
  const m = useConsoleMutation({ mutationFn: (_v, key) => post(path, path.includes('/appeals/') ? { status, outcomeReason: reason } : path.includes('/incidents/') || path.includes('/dispositions/') ? { status, note: reason } : { status, reason }, key), invalidate: ALL, successMessage: t('sa.saved') });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select aria-label={label} value={status} onChange={(e) => { setStatus(e.target.value); }}>
        {options.map((o) => <option key={o} value={o}>{t(tk(`sa.choice.${o}`))}</option>)}
      </Select>
      <Input aria-label={t('sa.reason')} placeholder={t('sa.reason')} value={reason} onChange={(e) => { setReason(e.target.value); }} />
      <Button size="sm" variant="secondary" disabled={reason.trim().length < 5 || m.isPending} onClick={() => { m.mutate(); }}>{label}</Button>
      <MutationError error={m.error} />
    </div>
  );
}

function RegistersTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.registers(), queryFn: fetchRegisters });
  return (
    <QueryBoundary query={query}>
      {(r) => (
        <div className="space-y-4">
          <Card title={t('sa.registers.notices')} bodyClassName="divide-y divide-border-subtle">
            {r.notices.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
            {r.notices.map((n) => (
              <div key={n.id} className="px-5 py-2 text-sm">
                <p className="font-medium">{n.number} · {n.seller} · {t(tk(`sa.noticeKind.${n.kind}`))}{n.hardStop !== null ? ` · ${t(tk(`sa.hardStop.${n.hardStop}`))}` : ''}</p>
                <p>{n.reason}</p>
                <p className="text-xs text-ink-muted">{formatDateTime(n.issuedAt)} · {t('sa.registers.appealBy', { date: formatDate(n.appealDeadline) })} · {t('sa.registers.orders', { orders: String(n.affectedOrders.length) })}</p>
              </div>
            ))}
          </Card>
          <Card title={t('sa.registers.appeals')} description={t('sa.registers.appealsHint')} bodyClassName="divide-y divide-border-subtle">
            {r.appeals.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
            {r.appeals.map((a) => (
              <div key={a.id} className="space-y-2 px-5 py-2 text-sm">
                <p className="font-medium">{a.notice} · {a.seller} · <Badge tone={a.overdue ? 'danger' : 'neutral'}>{t(tk(`sa.appealStatus.${a.status}`))}</Badge></p>
                <p>{a.grounds}</p>
                <p className="text-xs text-ink-muted">{t('sa.registers.target', { date: formatDate(a.targetBy) })}</p>
                {['SUBMITTED', 'UNDER_REVIEW'].includes(a.status) && <Decide path={`/appeals/${a.id}/decision`} options={['UPHELD', 'PARTIALLY_UPHELD', 'OVERTURNED']} label={t('sa.registers.decideAppeal')} />}
              </div>
            ))}
          </Card>
          <Card title={t('sa.registers.changes')} bodyClassName="divide-y divide-border-subtle">
            {r.changes.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
            {r.changes.map((c) => (
              <div key={c.id} className="space-y-2 px-5 py-2 text-sm">
                <p className="font-medium">{c.seller} · {t(tk(`sa.change.${c.kind}`))} · {t(tk(`sa.changeStatus.${c.status}`))}{c.undisclosed ? ` · ${t('sa.registers.undisclosed')}` : ''}</p>
                <p>{c.description}</p>
                {c.status === 'SUBMITTED' && <Decide path={`/changes/${c.id}/decision`} options={['APPROVED', 'NEEDS_REASSESSMENT', 'REJECTED']} label={t('sa.registers.decideChange')} />}
              </div>
            ))}
          </Card>
          <Card title={t('sa.registers.incidents')} bodyClassName="divide-y divide-border-subtle">
            {r.incidents.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
            {r.incidents.map((i) => (
              <div key={i.id} className="space-y-2 px-5 py-2 text-sm">
                <p className="font-medium">{i.seller} · {t(tk(`sa.severity.${i.severity}`))} · {i.late ? <Badge tone="danger">{t('sa.registers.late', { hours: String(i.deadlineHours) })}</Badge> : <Badge tone="success">{t('sa.registers.onTime')}</Badge>}</p>
                <p>{i.description}</p>
                {i.status !== 'CLOSED' && <Decide path={`/incidents/${i.id}/review`} options={['UNDER_REVIEW', 'CLOSED']} label={t('sa.registers.reviewIncident')} />}
              </div>
            ))}
          </Card>
          <Card title={t('sa.registers.bank')} description={t('sa.registers.bankHint')} bodyClassName="divide-y divide-border-subtle">
            {r.bankChanges.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
            {r.bankChanges.map((b) => <BankRow key={b.id} b={b} />)}
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}

function BankRow({ b }: { b: { id: string; seller: string; beneficiaryName: string; accountLast4: string; status: string; version: number } }): React.JSX.Element {
  const { t } = useI18n();
  const [contact, setContact] = useState({ knownContactName: '', knownContactSource: '' });
  const [reason, setReason] = useState('');
  const step = useConsoleMutation<string>({ mutationFn: (s, key) => post(`/bank-changes/${b.id}`, { step: s, reason, expectedVersion: b.version, ...(s === 'CONFIRM_CONTACT' ? contact : {}) }, key), invalidate: ALL, successMessage: t('sa.saved') });
  const open = !['APPROVED', 'REJECTED'].includes(b.status);
  return (
    <div className="space-y-2 px-5 py-2 text-sm">
      <p className="font-medium">{b.seller} · {b.beneficiaryName} · ••••{b.accountLast4} · {t(tk(`sa.bankStatus.${b.status}`))}</p>
      {open && (
        <div className="grid gap-2 sm:grid-cols-4">
          <Input aria-label={t('sa.registers.knownContact')} placeholder={t('sa.registers.knownContact')} value={contact.knownContactName} onChange={(e) => { setContact({ ...contact, knownContactName: e.target.value }); }} />
          <Input aria-label={t('sa.registers.contactSource')} placeholder={t('sa.registers.contactSource')} value={contact.knownContactSource} onChange={(e) => { setContact({ ...contact, knownContactSource: e.target.value }); }} />
          <Input aria-label={t('sa.reason')} placeholder={t('sa.reason')} value={reason} onChange={(e) => { setReason(e.target.value); }} />
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" disabled={reason.trim().length < 5 || step.isPending} onClick={() => { step.mutate('CONFIRM_CONTACT'); }}>{t('sa.registers.confirmContact')}</Button>
            <Button size="sm" variant="primary" disabled={reason.trim().length < 5 || step.isPending} onClick={() => { step.mutate('APPROVE'); }}>{t('sa.registers.approve')}</Button>
            <Button size="sm" variant="ghost" disabled={reason.trim().length < 5 || step.isPending} onClick={() => { step.mutate('REJECT'); }}>{t('sa.registers.reject')}</Button>
          </div>
          <div className="sm:col-span-4"><MutationError error={step.error} /></div>
        </div>
      )}
    </div>
  );
}

function DispositionsTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.dispositions(), queryFn: fetchDispositions });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <Card title={t('sa.dispositions.title')} description={t('sa.dispositions.description')} bodyClassName="divide-y divide-border-subtle">
          {data.dispositions.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
          {data.dispositions.map((d) => (
            <div key={d.id} className="space-y-2 px-5 py-2 text-sm">
              <p className="font-medium">{d.sellerOrderNumber ?? d.orderId} · {d.seller ?? ''} · {t(tk(`sa.dispositionStatus.${d.status}`))}</p>
              <p>{d.reason}</p>
              <Decide path={`/dispositions/${d.id}`} options={['HOLD', 'RELEASE_APPROVED', 'CANCEL_RECOMMENDED', 'RECALL']} label={t('sa.dispositions.record')} />
            </div>
          ))}
        </Card>
      )}
    </QueryBoundary>
  );
}

function SurveillanceTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.tasks(), queryFn: fetchTasks });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <Card title={t('sa.surveillance.title')} description={t('sa.surveillance.description')} bodyClassName="divide-y divide-border-subtle">
          {data.tasks.length === 0 && <p className="px-5 py-3 text-sm text-ink-muted">{t('sa.registers.none')}</p>}
          {data.tasks.map((task) => <TaskRow key={task.id} task={task} />)}
        </Card>
      )}
    </QueryBoundary>
  );
}

function TaskRow({ task }: { task: { id: string; kind: string; subjectRef: string | null; dueAt: string; status: string; note: string | null } }): React.JSX.Element {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState('SATISFACTORY');
  const done = useConsoleMutation({ mutationFn: (_v, key) => post(`/tasks/${task.id}/complete`, { outcome, note }, key), invalidate: [assessmentKeys.tasks()], successMessage: t('sa.saved') });
  return (
    <div className="space-y-2 px-5 py-2 text-sm">
      <p className="font-medium">{t(tk(`sa.task.${task.kind}`))} {task.subjectRef ?? ''} · {formatDate(task.dueAt)} · <Badge tone={task.status === 'OVERDUE' ? 'danger' : 'neutral'}>{t(tk(`sa.taskStatus.${task.status}`))}</Badge></p>
      {task.note !== null && <p className="text-xs text-ink-muted">{task.note}</p>}
      {task.kind !== 'EXPIRY_REMINDER' && (
        <div className="flex flex-wrap items-end gap-2">
          <Select aria-label={t('sa.surveillance.outcome')} value={outcome} onChange={(e) => { setOutcome(e.target.value); }}>
            <option value="SATISFACTORY">{t('sa.choice.SATISFACTORY')}</option>
            <option value="ISSUE_FOUND">{t('sa.choice.ISSUE_FOUND')}</option>
          </Select>
          <Textarea aria-label={t('sa.surveillance.note')} placeholder={t('sa.surveillance.note')} value={note} onChange={(e) => { setNote(e.target.value); }} />
          <Button size="sm" variant="secondary" disabled={note.trim().length < 5 || done.isPending} onClick={() => { done.mutate(); }}>{t('sa.surveillance.complete')}</Button>
          <MutationError error={done.error} />
        </div>
      )}
    </div>
  );
}

function RetentionTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.retention(), queryFn: fetchRetention });
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <Card title={t('sa.retention.title')} description={t('sa.retention.description')} bodyClassName="divide-y divide-border-subtle">
          {data.categories.map((c) => (
            <div key={c.category} className="px-5 py-2 text-sm">
              <p className="font-medium">{t(tk(`sa.retentionCategory.${c.category}`))} · {c.years === null ? <Badge tone="warning">{t('sa.retention.notConfigured')}</Badge> : t('sa.retention.years', { years: String(c.years) })}</p>
              <p className="text-xs text-ink-muted">{t('sa.retention.files', { files: String(c.files), held: String(c.onLegalHold) })}</p>
            </div>
          ))}
        </Card>
      )}
    </QueryBoundary>
  );
}
