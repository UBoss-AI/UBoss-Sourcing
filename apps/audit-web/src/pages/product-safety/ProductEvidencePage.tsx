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
import { CardField, QueryBoundary, ResponsiveTable, StatTile } from '@/components/console';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  type BadgeTone,
  Button,
  Callout,
  Card,
  CheckboxField,
  Field,
  FieldGroup,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
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

const STATUS_TONE: Record<EvidenceStatus, BadgeTone> = {
  UNVERIFIED: 'neutral',
  VERIFIED: 'success',
  SUSPENDED: 'warning',
  WITHDRAWN: 'danger',
  EXPIRED: 'danger',
  REJECTED: 'danger',
};
const EVIDENCE_STATUSES = Object.keys(STATUS_TONE) as EvidenceStatus[];

/** Inside this many days an issuer-set expiry is worth a reviewer's attention now. */
const EXPIRY_SOON_DAYS = 90;

const expiresSoon = (row: EvidenceRow): boolean =>
  row.daysToExpiry !== null && row.daysToExpiry <= EXPIRY_SOON_DAYS;

/** A long seller ID, shortened to its tail so the column stays readable. The full ID is in the title. */
function SellerId({ id }: { id: string }): React.JSX.Element {
  return (
    <span className="font-mono text-xs text-ink-muted" title={id}>
      …{id.slice(-8)}
    </span>
  );
}

export function ProductEvidencePage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [seller, setSeller] = useState('');
  const [country, setCountry] = useState('');
  const [statusFilter, setStatusFilter] = useState<EvidenceStatus | ''>('');
  const [blockingOnly, setBlockingOnly] = useState(false);
  const [recording, setRecording] = useState(false);
  const [acting, setActing] = useState<EvidenceRow | null>(null);
  const sellerId = useDebounced(seller.trim());
  const countryCode = useDebounced(country.trim().toUpperCase());
  const filter = {
    ...(sellerId.length === 26 ? { sellerAccountId: sellerId } : {}),
    ...(countryCode.length === 2 ? { countryCode } : {}),
  };
  const query = useQuery({
    queryKey: productSafetyKeys.evidence(filter),
    queryFn: () => fetchEvidence(filter),
    placeholderData: keepPreviousData,
  });
  const filtered = seller !== '' || country !== '' || statusFilter !== '' || blockingOnly;
  const canAct = can(Permission.SELLER_VERIFY);

  const expiry = (row: EvidenceRow): React.JSX.Element =>
    row.expiresOn === null ? (
      <span className="text-ink-muted">{t('productSafety.evidence.noIssuerExpiry')}</span>
    ) : (
      <span className="tabular">
        {formatDate(row.expiresOn)}
        {row.daysToExpiry !== null && (
          <span
            className={cx(
              'block text-xs',
              row.daysToExpiry <= 30
                ? 'font-medium text-danger'
                : expiresSoon(row)
                  ? 'font-medium text-warning'
                  : 'text-ink-muted',
            )}
          >
            {t('productSafety.evidence.daysToExpiry', { days: String(row.daysToExpiry) })}
          </span>
        )}
      </span>
    );

  const status = (row: EvidenceRow): React.JSX.Element => (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={STATUS_TONE[row.status]}>
        {t(`productSafety.evidenceStatus.${row.status}` as TranslationKey)}
      </Badge>
      {row.blocksTrading && (
        <Badge tone="danger">{t('productSafety.evidence.blocksTrading')}</Badge>
      )}
    </div>
  );

  const changeStatus = (row: EvidenceRow): React.JSX.Element => (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        setRecording(false);
        setActing(row);
      }}
    >
      {t('productSafety.evidence.changeStatus')}
    </Button>
  );

  const columns: Column<EvidenceRow>[] = [
    {
      key: 'product',
      header: t('productSafety.evidence.col.product'),
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {row.productKey}{' '}
            <span className="ml-1 rounded bg-surface-sunken px-1.5 py-0.5 text-xxs font-semibold text-ink-muted">
              v{row.productVersion}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {row.facilityRef} · <SellerId id={row.sellerAccountId} />
          </p>
        </div>
      ),
    },
    {
      key: 'country',
      header: t('productSafety.evidence.col.country'),
      nowrap: true,
      render: (row) => <span className="font-mono text-sm font-semibold">{row.countryCode}</span>,
    },
    {
      key: 'kind',
      header: t('productSafety.evidence.col.kind'),
      render: (row) => (
        <div className="max-w-xs">
          <span className="font-medium">
            {t(`productSafety.evidenceKind.${row.kind}` as TranslationKey)}
          </span>
          {row.limit !== null && (
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{row.limit}</p>
          )}
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
    { key: 'expiry', header: t('productSafety.evidence.col.expiry'), nowrap: true, render: expiry },
    { key: 'status', header: t('productSafety.evidence.col.status'), render: status },
    ...(canAct
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">{t('common.actions')}</span>,
            align: 'right' as const,
            render: changeStatus,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t('productSafety.evidence.title')}
        description={t('productSafety.evidence.description')}
        actions={
          can(Permission.ASSESSMENT_WORK) ? (
            <Button
              variant={recording ? 'secondary' : 'primary'}
              onClick={() => {
                setActing(null);
                setRecording((value) => !value);
              }}
            >
              {recording ? t('productSafety.cancel') : t('productSafety.evidence.record')}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        {query.data !== undefined && <EvidenceSummary rows={query.data} />}
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
                placeholder={t('productSafety.evidence.filterSellerPlaceholder')}
                className="font-mono"
                onChange={(event) => {
                  setSeller(event.target.value);
                }}
              />
            </ToolbarField>
            <ToolbarField label={t('productSafety.evidence.filterCountry')} className="w-36">
              <Input
                value={country}
                maxLength={2}
                placeholder="DE"
                className="font-mono uppercase"
                onChange={(event) => {
                  setCountry(event.target.value);
                }}
              />
            </ToolbarField>
            <ToolbarField label={t('productSafety.evidence.col.status')} className="w-44">
              <Select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as EvidenceStatus | '');
                }}
              >
                <option value="">{t('common.all')}</option>
                {EVIDENCE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`productSafety.evidenceStatus.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            </ToolbarField>
            <div className="flex items-end">
              <ToolbarToggle
                label={t('productSafety.evidence.blocksTrading')}
                checked={blockingOnly}
                onChange={setBlockingOnly}
              />
            </div>
            {filtered && (
              <ToolbarActions>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSeller('');
                    setCountry('');
                    setStatusFilter('');
                    setBlockingOnly(false);
                  }}
                >
                  {t('common.clearFilters')}
                </Button>
              </ToolbarActions>
            )}
          </Toolbar>
          <QueryBoundary query={query}>
            {(all) => {
              const rows = all.filter(
                (row) =>
                  (statusFilter === '' || row.status === statusFilter) &&
                  (!blockingOnly || row.blocksTrading),
              );
              return (
                <ResponsiveTable
                  caption={t('productSafety.evidence.title')}
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.id}
                  minWidth="64rem"
                  isRefreshing={query.isFetching}
                  rowClassName={(row) => (row.blocksTrading ? 'bg-danger-soft/40' : undefined)}
                  emptyTitle={
                    filtered
                      ? t('productSafety.evidence.empty')
                      : t('productSafety.evidence.emptyNone')
                  }
                  {...(filtered
                    ? {}
                    : { emptyDescription: t('productSafety.evidence.emptyNoneHint') })}
                  card={(row) => (
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {row.productKey}{' '}
                            <span className="text-xs text-ink-muted">v{row.productVersion}</span>
                          </p>
                          <p className="text-xs text-ink-muted">
                            {row.facilityRef} · {row.countryCode}
                          </p>
                        </div>
                        {status(row)}
                      </div>
                      <CardField label={t('productSafety.evidence.col.kind')}>
                        {t(`productSafety.evidenceKind.${row.kind}` as TranslationKey)}
                        {row.limit !== null && (
                          <span className="block text-xs text-ink-muted">{row.limit}</span>
                        )}
                      </CardField>
                      <CardField label={t('productSafety.evidence.col.scheme')}>
                        {row.scheme} · {row.issuer}
                      </CardField>
                      <CardField label={t('productSafety.evidence.col.expiry')}>
                        {expiry(row)}
                      </CardField>
                      {canAct && <div className="pt-1">{changeStatus(row)}</div>}
                    </div>
                  )}
                />
              );
            }}
          </QueryBoundary>
        </Card>
        <AssuranceMatrix />
      </div>
    </>
  );
}

/** Where the evidence stands, before anybody reads a row. */
function EvidenceSummary({ rows }: { rows: EvidenceRow[] }): React.JSX.Element {
  const { t } = useI18n();
  const count = (test: (row: EvidenceRow) => boolean): number => rows.filter(test).length;
  const unverified = count((row) => row.status === 'UNVERIFIED');
  const blocking = count((row) => row.blocksTrading);
  const soon = count(expiresSoon);
  const verified = count((row) => row.status === 'VERIFIED');
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <StatTile label={t('productSafety.evidence.sum.total')} value={String(rows.length)} />
      <StatTile label={t('productSafety.evidenceStatus.VERIFIED')} value={String(verified)} tone={verified > 0 ? 'success' : 'default'} />
      <StatTile
        label={t('productSafety.evidenceStatus.UNVERIFIED')}
        value={String(unverified)}
        tone={unverified > 0 ? 'warning' : 'default'}
      />
      <StatTile
        label={t('productSafety.evidence.blocksTrading')}
        value={String(blocking)}
        tone={blocking > 0 ? 'danger' : 'default'}
      />
      <StatTile
        label={t('productSafety.evidence.sum.expiringSoon')}
        value={String(soon)}
        tone={soon > 0 ? 'warning' : 'default'}
      />
    </div>
  );
}

const EMPTY = {
  sellerAccountId: '',
  offerId: '',
  productKey: '',
  productVersion: '',
  facilityRef: '',
  countryCode: '',
  departmentSlug: '',
  scheme: '',
  issuer: '',
  accreditation: '',
  scope: '',
  certificateNumber: '',
  issuedOn: '',
  expiresOn: '',
  changeConditions: '',
  surveillanceDueAt: '',
  gapAssessment: '',
};

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
    <Card title={t('productSafety.evidence.record')} bodyClassName="px-5 py-5">
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FieldGroup legend={t('productSafety.evidence.group.product')}>
          <FormGrid>
            <TextField
              label={t('productSafety.evidence.f.seller')}
              value={form.sellerAccountId}
              onChange={set('sellerAccountId')}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.offer')}
              value={form.offerId}
              onChange={set('offerId')}
            />
            <TextField
              label={t('productSafety.evidence.f.productKey')}
              value={form.productKey}
              onChange={set('productKey')}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.productVersion')}
              value={form.productVersion}
              onChange={set('productVersion')}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.site')}
              value={form.facilityRef}
              onChange={set('facilityRef')}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.country')}
              value={form.countryCode}
              onChange={set('countryCode')}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.department')}
              value={form.departmentSlug}
              onChange={set('departmentSlug')}
            />
          </FormGrid>
        </FieldGroup>
        <FieldGroup
          legend={t('productSafety.evidence.group.evidence')}
          hint={t('productSafety.evidence.limitIntro')}
        >
          <div className="space-y-3">
            <FormGrid>
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
              <TextField
                label={t('productSafety.evidence.col.scheme')}
                value={form.scheme}
                onChange={set('scheme')}
                required
              />
              <TextField
                label={t('productSafety.evidence.f.issuer')}
                value={form.issuer}
                onChange={set('issuer')}
                required
              />
              <TextField
                label={t('productSafety.evidence.f.accreditation')}
                value={form.accreditation}
                onChange={set('accreditation')}
              />
              <TextField
                label={t('productSafety.evidence.f.certificateNumber')}
                value={form.certificateNumber}
                onChange={set('certificateNumber')}
              />
            </FormGrid>
            <TextField
              label={t('productSafety.evidence.f.scope')}
              value={form.scope}
              onChange={set('scope')}
              required
              multiline
            />
            <TextField
              label={t('productSafety.evidence.f.changeConditions')}
              value={form.changeConditions}
              onChange={set('changeConditions')}
              multiline
            />
          </div>
        </FieldGroup>
        <FieldGroup legend={t('productSafety.evidence.group.dates')}>
          <FormGrid>
            <TextField
              label={t('productSafety.evidence.f.issuedOn')}
              type="date"
              value={form.issuedOn}
              onChange={set('issuedOn')}
            />
            <TextField
              label={t('productSafety.evidence.f.expiresOn')}
              type="date"
              value={form.expiresOn}
              onChange={set('expiresOn')}
              hint={t('productSafety.evidence.expiryHint')}
            />
            <TextField
              label={t('productSafety.evidence.f.surveillanceDue')}
              type="date"
              value={form.surveillanceDueAt}
              onChange={set('surveillanceDueAt')}
            />
          </FormGrid>
        </FieldGroup>
        <FieldGroup legend={t('productSafety.evidence.group.trading')}>
          <div className="space-y-3">
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
            {accepted && (
              <TextField
                label={t('productSafety.evidence.f.gapAssessment')}
                value={form.gapAssessment}
                onChange={set('gapAssessment')}
                required
                multiline
                hint={t('productSafety.evidence.gapHint')}
              />
            )}
          </div>
        </FieldGroup>
        <SafetyMutationError error={save.error} />
        <div className="flex gap-2 border-t border-border-subtle pt-4">
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
      setEvidenceStatus(
        row.id,
        {
          status: action,
          method: action === 'VERIFIED' ? method.trim() : null,
          evidence: action === 'VERIFIED' ? evidence.trim() : null,
          reason: reason.trim() === '' ? null : reason.trim(),
        },
        key,
      ),
    invalidate: [['audit', 'product-evidence']],
    successMessage: t('productSafety.evidence.statusSaved'),
    onSuccess: onDone,
  });
  return (
    <Card
      title={t('productSafety.evidence.changeStatusFor', {
        product: `${row.productKey} v${row.productVersion}`,
      })}
      bodyClassName="px-5 py-5"
    >
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
            <TextField
              label={t('productSafety.evidence.f.method')}
              value={method}
              onChange={setMethod}
              required
            />
            <TextField
              label={t('productSafety.evidence.f.checkShowed')}
              value={evidence}
              onChange={setEvidence}
              required
              multiline
            />
          </>
        )}
        <TextField
          label={t('productSafety.evidence.f.reason')}
          value={reason}
          onChange={setReason}
          required={action !== 'VERIFIED'}
          multiline
        />
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
  const query = useQuery({
    queryKey: productSafetyKeys.prompts(),
    queryFn: fetchPrompts,
    staleTime: 60 * 60 * 1000,
  });
  return (
    <Card title={t('productSafety.matrix.title')} bodyClassName="px-5 py-5">
      <Callout tone="info" className="mb-3">
        {t('productSafety.matrix.notice')}
      </Callout>
      <QueryBoundary query={query}>
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2" aria-label={t('productSafety.matrix.title')}>
            {data.matrix.map((row) => (
              <li
                key={row.department}
                className={cx(
                  'flex flex-col rounded-lg border border-border bg-surface-raised p-4 shadow-card',
                  row.sixMonth === 'ALL' && 'border-l-4 border-l-warning',
                  row.sixMonth === 'CONDITIONAL' && 'border-l-4 border-l-action',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-ink">{row.department}</h3>
                  <Badge
                    tone={
                      row.sixMonth === 'ALL'
                        ? 'warning'
                        : row.sixMonth === 'CONDITIONAL'
                          ? 'action'
                          : 'neutral'
                    }
                  >
                    <span className="sr-only">{t('productSafety.matrix.sixMonth')}: </span>
                    {t(`productSafety.matrix.six.${row.sixMonth}` as TranslationKey)}
                  </Badge>
                </div>
                <dl className="mt-3 space-y-2.5 text-sm">
                  <div>
                    <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {t('productSafety.matrix.triggers')}
                    </dt>
                    <dd className="mt-0.5 leading-relaxed text-ink">{row.triggers}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {t('productSafety.matrix.surveillance')}
                    </dt>
                    <dd className="mt-0.5 leading-relaxed text-ink-muted">{row.surveillance}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
