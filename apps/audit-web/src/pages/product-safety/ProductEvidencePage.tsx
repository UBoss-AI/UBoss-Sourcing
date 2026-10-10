/**
 * Product evidence: what proves a product may trade, per SKU/version, site
 * and country (Doc 08).
 *
 *   GET  /api/v1/audit/product-evidence
 *   GET  /api/v1/audit/product-evidence/prompts
 *   POST /api/v1/audit/product-evidence
 *   POST /api/v1/audit/product-evidence/:id/status
 *
 * Every row says what its kind of evidence does NOT prove, and an expiry is
 * shown only when the issuer or the law set one - never an invented annual one.
 * The person who recorded a piece of evidence cannot verify it; the server
 * refuses that, and this screen shows the refusal.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Badge, type BadgeTone, Button, Callout, Card, CheckboxField, Field, Input, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  dateToIso,
  EVIDENCE_ACTIONS,
  EVIDENCE_KINDS,
  fetchEvidence,
  fetchPrompts,
  productSafetyKeys,
  recordEvidence,
  setEvidenceStatus,
  type EvidenceAction,
  type EvidenceKind,
  type EvidenceRow,
  type EvidenceStatus,
} from '@/lib/product-safety';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { useDebounced } from '@/lib/use-debounced';
import { FormGrid, SafetyMutationError, TextField } from './shared';

const STATUS_TONE: Record<EvidenceStatus, BadgeTone> = { UNVERIFIED: 'neutral', VERIFIED: 'success', SUSPENDED: 'warning', WITHDRAWN: 'danger', EXPIRED: 'danger', REJECTED: 'danger' };

export function ProductEvidencePage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [seller, setSeller] = useState('');
  const [country, setCountry] = useState('');
  const [recording, setRecording] = useState(false);
  const [acting, setActing] = useState<EvidenceRow | null>(null);
  const sellerId = useDebounced(seller.trim());
  const countryCode = useDebounced(country.trim().toUpperCase());
  const filter = { ...(sellerId.length === 26 ? { sellerAccountId: sellerId } : {}), ...(countryCode.length === 2 ? { countryCode } : {}) };
  const query = useQuery({ queryKey: productSafetyKeys.evidence(filter), queryFn: () => fetchEvidence(filter), placeholderData: keepPreviousData });

  const expiry = (row: EvidenceRow): React.JSX.Element =>
    row.expiresOn === null ? (
      <span className="text-ink-muted">{t('productSafety.evidence.noIssuerExpiry')}</span>
    ) : (
      <span>
        {formatDate(row.expiresOn)}
        {row.daysToExpiry !== null && <span className="block text-xs text-ink-muted">{t('productSafety.evidence.daysToExpiry', { days: String(row.daysToExpiry) })}</span>}
      </span>
    );

  const status = (row: EvidenceRow): React.JSX.Element => (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={STATUS_TONE[row.status]}>{t(`productSafety.evidenceStatus.${row.status}` as TranslationKey)}</Badge>
      {row.blocksTrading && <Badge tone="danger">{t('productSafety.evidence.blocksTrading')}</Badge>}
      {can(Permission.SELLER_VERIFY) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setActing(row);
          }}
        >
          {t('productSafety.evidence.changeStatus')}
        </Button>
      )}
    </div>
  );

  const columns: Column<EvidenceRow>[] = [
    { key: 'seller', header: t('productSafety.evidence.col.seller'), render: (row) => <span className="font-mono text-xs">{row.sellerAccountId}</span> },
    {
      key: 'product',
      header: t('productSafety.evidence.col.product'),
      render: (row) => (
        <span>
          {row.productKey} <span className="text-xs text-ink-muted">v{row.productVersion}</span>
        </span>
      ),
    },
    { key: 'site', header: t('productSafety.evidence.col.site'), secondary: true, render: (row) => row.facilityRef },
    { key: 'country', header: t('productSafety.evidence.col.country'), nowrap: true, render: (row) => row.countryCode },
    {
      key: 'kind',
      header: t('productSafety.evidence.col.kind'),
      render: (row) => (
        <div>
          <span>{t(`productSafety.evidenceKind.${row.kind}` as TranslationKey)}</span>
          {row.limit !== null && <p className="text-xs text-ink-muted">{row.limit}</p>}
        </div>
      ),
    },
    {
      key: 'scheme',
      header: t('productSafety.evidence.col.scheme'),
      secondary: true,
      render: (row) => (
        <span>
          {row.scheme}
          <span className="block text-xs text-ink-muted">{row.issuer}</span>
        </span>
      ),
    },
    { key: 'expiry', header: t('productSafety.evidence.col.expiry'), render: expiry },
    { key: 'status', header: t('productSafety.evidence.col.status'), render: status },
  ];

  return (
    <>
      <PageHeader
        title={t('productSafety.evidence.title')}
        description={t('productSafety.evidence.description')}
        actions={
          can(Permission.ASSESSMENT_WORK) ? (
            <Button
              onClick={() => {
                setRecording((value) => !value);
              }}
            >
              {t('productSafety.evidence.record')}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        {recording && (
          <RecordEvidenceForm
            onDone={() => {
              setRecording(false);
            }}
          />
        )}
        {acting !== null && (
          <StatusForm
            row={acting}
            onDone={() => {
              setActing(null);
            }}
          />
        )}
        <Card>
          <Toolbar>
            <ToolbarField label={t('productSafety.evidence.filterSeller')} grow>
              <Input
                value={seller}
                onChange={(event) => {
                  setSeller(event.target.value);
                }}
              />
            </ToolbarField>
            <ToolbarField label={t('productSafety.evidence.filterCountry')}>
              <Input
                value={country}
                maxLength={2}
                onChange={(event) => {
                  setCountry(event.target.value);
                }}
              />
            </ToolbarField>
          </Toolbar>
          <QueryBoundary query={query}>
            {(rows) => (
              <ResponsiveTable
                caption={t('productSafety.evidence.title')}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                minWidth="72rem"
                isRefreshing={query.isFetching}
                emptyTitle={t('productSafety.evidence.empty')}
                card={(row) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">
                        {row.productKey} v{row.productVersion}
                      </span>
                      {status(row)}
                    </div>
                    <CardField label={t('productSafety.evidence.col.kind')}>
                      {t(`productSafety.evidenceKind.${row.kind}` as TranslationKey)}
                      {row.limit !== null && <span className="block text-xs text-ink-muted">{row.limit}</span>}
                    </CardField>
                    <CardField label={t('productSafety.evidence.col.country')}>{row.countryCode}</CardField>
                    <CardField label={t('productSafety.evidence.col.expiry')}>{expiry(row)}</CardField>
                  </div>
                )}
              />
            )}
          </QueryBoundary>
        </Card>
        <AssuranceMatrix />
      </div>
    </>
  );
}

const EMPTY = { sellerAccountId: '', offerId: '', productKey: '', productVersion: '', facilityRef: '', countryCode: '', departmentSlug: '', scheme: '', issuer: '', accreditation: '', scope: '', certificateNumber: '', issuedOn: '', expiresOn: '', changeConditions: '', surveillanceDueAt: '', gapAssessment: '' };

function RecordEvidenceForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY);
  const [kind, setKind] = useState<EvidenceKind>('PRODUCT_CERTIFICATE');
  const [required, setRequired] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const set = (key: keyof typeof EMPTY) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      recordEvidence(
        {
          sellerAccountId: form.sellerAccountId.trim(),
          offerId: orNull(form.offerId),
          productKey: form.productKey.trim(),
          productVersion: form.productVersion.trim(),
          facilityRef: form.facilityRef.trim(),
          countryCode: form.countryCode.trim().toUpperCase(),
          departmentSlug: orNull(form.departmentSlug),
          kind,
          scheme: form.scheme.trim(),
          issuer: form.issuer.trim(),
          accreditation: orNull(form.accreditation),
          scope: form.scope.trim(),
          certificateNumber: orNull(form.certificateNumber),
          issuedOn: dateToIso(form.issuedOn),
          expiresOn: dateToIso(form.expiresOn),
          changeConditions: orNull(form.changeConditions),
          surveillanceDueAt: dateToIso(form.surveillanceDueAt),
          requiredForTrading: required,
          existingAccepted: accepted,
          gapAssessment: orNull(form.gapAssessment),
        },
        key,
      ),
    invalidate: [['audit', 'product-evidence']],
    successMessage: t('productSafety.evidence.recorded'),
    onSuccess: onDone,
  });

  return (
    <Card title={t('productSafety.evidence.record')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FormGrid>
          <TextField label={t('productSafety.evidence.f.seller')} value={form.sellerAccountId} onChange={set('sellerAccountId')} required />
          <TextField label={t('productSafety.evidence.f.offer')} value={form.offerId} onChange={set('offerId')} />
          <TextField label={t('productSafety.evidence.f.productKey')} value={form.productKey} onChange={set('productKey')} required />
          <TextField label={t('productSafety.evidence.f.productVersion')} value={form.productVersion} onChange={set('productVersion')} required />
          <TextField label={t('productSafety.evidence.f.site')} value={form.facilityRef} onChange={set('facilityRef')} required />
          <TextField label={t('productSafety.evidence.f.country')} value={form.countryCode} onChange={set('countryCode')} required />
          <TextField label={t('productSafety.evidence.f.department')} value={form.departmentSlug} onChange={set('departmentSlug')} />
          <Field label={t('productSafety.evidence.col.kind')} required>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as EvidenceKind);
                }}
              >
                {EVIDENCE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`productSafety.evidenceKind.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <TextField label={t('productSafety.evidence.col.scheme')} value={form.scheme} onChange={set('scheme')} required />
          <TextField label={t('productSafety.evidence.f.issuer')} value={form.issuer} onChange={set('issuer')} required />
          <TextField label={t('productSafety.evidence.f.accreditation')} value={form.accreditation} onChange={set('accreditation')} />
          <TextField label={t('productSafety.evidence.f.certificateNumber')} value={form.certificateNumber} onChange={set('certificateNumber')} />
          <TextField label={t('productSafety.evidence.f.issuedOn')} type="date" value={form.issuedOn} onChange={set('issuedOn')} />
          <TextField label={t('productSafety.evidence.f.expiresOn')} type="date" value={form.expiresOn} onChange={set('expiresOn')} hint={t('productSafety.evidence.expiryHint')} />
          <TextField label={t('productSafety.evidence.f.surveillanceDue')} type="date" value={form.surveillanceDueAt} onChange={set('surveillanceDueAt')} />
        </FormGrid>
        <TextField label={t('productSafety.evidence.f.scope')} value={form.scope} onChange={set('scope')} required multiline />
        <TextField label={t('productSafety.evidence.f.changeConditions')} value={form.changeConditions} onChange={set('changeConditions')} multiline />
        <p className="text-xs text-ink-muted">{t('productSafety.evidence.limitIntro')}</p>
        <CheckboxField
          label={t('productSafety.evidence.f.required')}
          description={t('productSafety.evidence.f.requiredHint')}
          checked={required}
          onChange={(event) => {
            setRequired(event.target.checked);
          }}
        />
        <CheckboxField
          label={t('productSafety.evidence.f.existingAccepted')}
          checked={accepted}
          onChange={(event) => {
            setAccepted(event.target.checked);
          }}
        />
        {accepted && <TextField label={t('productSafety.evidence.f.gapAssessment')} value={form.gapAssessment} onChange={set('gapAssessment')} required multiline hint={t('productSafety.evidence.gapHint')} />}
        <SafetyMutationError error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" isLoading={save.isPending}>
            {t('productSafety.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('productSafety.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function StatusForm({ row, onDone }: { row: EvidenceRow; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [action, setAction] = useState<EvidenceAction>('VERIFIED');
  const [method, setMethod] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      setEvidenceStatus(row.id, { status: action, method: action === 'VERIFIED' ? method.trim() : null, evidence: action === 'VERIFIED' ? evidence.trim() : null, reason: reason.trim() === '' ? null : reason.trim() }, key),
    invalidate: [['audit', 'product-evidence']],
    successMessage: t('productSafety.evidence.statusSaved'),
    onSuccess: onDone,
  });
  return (
    <Card title={t('productSafety.evidence.changeStatusFor', { product: `${row.productKey} v${row.productVersion}` })}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('productSafety.evidence.action')} required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={action}
              onChange={(event) => {
                setAction(event.target.value as EvidenceAction);
              }}
            >
              {EVIDENCE_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`productSafety.evidenceAction.${value}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {action === 'VERIFIED' && (
          <>
            <Callout tone="info">{t('productSafety.evidence.verifyHint')}</Callout>
            <TextField label={t('productSafety.evidence.f.method')} value={method} onChange={setMethod} required />
            <TextField label={t('productSafety.evidence.f.checkShowed')} value={evidence} onChange={setEvidence} required multiline />
          </>
        )}
        <TextField label={t('productSafety.evidence.f.reason')} value={reason} onChange={setReason} required={action !== 'VERIFIED'} multiline />
        <SafetyMutationError error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" isLoading={save.isPending}>
            {t('productSafety.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('productSafety.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AssuranceMatrix(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: productSafetyKeys.prompts(), queryFn: fetchPrompts, staleTime: 60 * 60 * 1000 });
  return (
    <Card title={t('productSafety.matrix.title')}>
      <Callout tone="info" className="mb-3">
        {t('productSafety.matrix.notice')}
      </Callout>
      <QueryBoundary query={query}>
        {(data) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">{t('productSafety.matrix.title')}</caption>
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th className="py-2 pr-3">{t('productSafety.matrix.department')}</th>
                  <th className="py-2 pr-3">{t('productSafety.matrix.triggers')}</th>
                  <th className="py-2 pr-3">{t('productSafety.matrix.surveillance')}</th>
                  <th className="py-2">{t('productSafety.matrix.sixMonth')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle align-top">
                {data.matrix.map((row) => (
                  <tr key={row.department}>
                    <td className="py-2 pr-3 font-medium">{row.department}</td>
                    <td className="py-2 pr-3">{row.triggers}</td>
                    <td className="py-2 pr-3">{row.surveillance}</td>
                    <td className="py-2">
                      <Badge tone={row.sixMonth === 'ALL' ? 'warning' : row.sixMonth === 'CONDITIONAL' ? 'action' : 'neutral'}>{t(`productSafety.matrix.six.${row.sixMonth}` as TranslationKey)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}
