/**
 * A supplier's factories and certificates, and the decisions on them
 * (checklist Master row 13). On the seller detail page.
 *
 * Read with customer.read. Deciding needs customer.status.write - the same
 * people who approve seller applications. Evidence files are opened through
 * the audited seller-document link; this panel shows their metadata only.
 *
 * The rules the panel shows, and the server enforces:
 *   - A factory with no evidence cannot be verified.
 *   - A refusal needs a reason, which the seller is shown. The internal note
 *     is never shown to them.
 *   - A decision names the check the reviewer was looking at, so a colleague
 *     who decided first wins and this screen is told to reload.
 *   - A verification lasts the deployment's re-verification interval unless
 *     the reviewer sets an earlier or later end date (at most five years).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, DescriptionList, ErrorState, Field, Input, LoadingState, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { createSellerDocumentLink } from '@/lib/sellers';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

type FactoryStatus = 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
type CheckState = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export interface ReviewFactory {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  establishedYear: number | null;
  floorAreaSqm: number | null;
  workforceCount: number | null;
  qcStaffCount: number | null;
  monthlyCapacity: number | null;
  capacityUnit: string | null;
  productsMade: string | null;
  qcProcess: string | null;
  machines: { id: string; name: string; quantity: number; capacityNote: string | null }[];
  evidence: {
    id: string;
    documentId: string;
    caption: string | null;
    capturedLatitude: number | null;
    capturedLongitude: number | null;
    document: { originalFileName: string; kind: string; scanState: string; status: string; isReplaced: boolean } | null;
  }[];
  verification: { status: FactoryStatus; checkId: string | null; reason: string | null; validUntil: string | null };
  history: {
    id: string;
    state: CheckState;
    at: string;
    reason: string | null;
    validUntil: string | null;
    internalNote?: string | null;
    decidedBy?: { id: string; email: string | null } | null;
  }[];
}

export interface ReviewCertification {
  id: string;
  factoryName: string | null;
  standard: string;
  certificateNumber: string | null;
  issuer: string;
  scope: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  documentId: string | null;
  document: { originalFileName: string; isReplaced: boolean } | null;
  state: CheckState;
  verifiedAt: string | null;
  rejectionReason: string | null;
  verifiedBy?: { id: string; email: string | null } | null;
}

interface Review {
  factories: ReviewFactory[];
  certifications: ReviewCertification[];
  reverificationDays: number;
}

const FACTORY_TONE: Record<FactoryStatus, BadgeTone> = {
  NOT_SUBMITTED: 'neutral',
  PENDING: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};
const CHECK_TONE: Record<CheckState, BadgeTone> = { PENDING: 'warning', VERIFIED: 'success', REJECTED: 'danger', EXPIRED: 'warning' };

const dash = (value: string | number | null): string => (value === null || value === '' ? '—' : String(value));

function useOpenDocument(): { open: (documentId: string) => void; pendingId: string | null } {
  const { t } = useI18n();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: createSellerDocumentLink,
    onSuccess: (link) => {
      // Opened the moment it is minted: the link is single-use and short-lived.
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerFactories.openFailed')));
    },
  });
  return {
    open: (documentId) => {
      mutation.mutate(documentId);
    },
    pendingId: mutation.isPending ? mutation.variables : null,
  };
}

export function SellerFactoriesPanel({ sellerId }: { sellerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const key = ['admin', 'seller', sellerId, 'factories'];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Review>(`/admin/sellers/${sellerId}/factories`) });

  return (
    <Card title={t('sellerFactories.title')} description={t('sellerFactories.description')}>
      {query.isPending && <LoadingState label={t('sellerFactories.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isSuccess && (
        <div className="space-y-6 px-5 py-4 text-sm">
          <section aria-labelledby={`factories-${sellerId}`} className="space-y-3">
            <h3 id={`factories-${sellerId}`} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t('sellerFactories.factories')}
            </h3>
            {query.data.factories.length === 0 ? (
              <p className="text-ink-muted">{t('sellerFactories.noFactories')}</p>
            ) : (
              <ul className="space-y-4">
                {query.data.factories.map((factory) => (
                  <FactoryReview key={factory.id} factory={factory} reverificationDays={query.data.reverificationDays} queryKey={key} />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby={`certificates-${sellerId}`} className="space-y-3">
            <h3 id={`certificates-${sellerId}`} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t('sellerFactories.certificates')}
            </h3>
            {query.data.certifications.length === 0 ? (
              <p className="text-ink-muted">{t('sellerFactories.noCertificates')}</p>
            ) : (
              <ul className="space-y-4">
                {query.data.certifications.map((certification) => (
                  <CertificationReview key={certification.id} certification={certification} queryKey={key} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Card>
  );
}

function DecisionForm({
  kind,
  verified,
  canVerify,
  reverificationDays,
  isPending,
  onDecide,
}: {
  kind: 'factory' | 'certificate';
  verified: boolean;
  canVerify: boolean;
  reverificationDays: number | null;
  isPending: boolean;
  onDecide: (input: { decision: 'VERIFIED' | 'REJECTED'; reason: string | null; internalNote: string | null; validUntil: string | null }) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const clean = (value: string): string | null => (value.trim() === '' ? null : value.trim());

  return (
    <div className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken/40 p-3">
      <Field
        label={t('sellerFactories.reason')}
        hint={t('sellerFactories.reasonHint')}
        error={missingReason ? t('sellerFactories.reasonRequired') : undefined}
      >
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            maxLength={2000}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      {kind === 'factory' && (
        <Field label={t('sellerFactories.internalNote')} hint={t('sellerFactories.internalNoteHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={4000}
              value={note}
              onChange={(event) => {
                setNote(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      )}
      {kind === 'factory' && !verified && reverificationDays !== null && (
        <Field label={t('sellerFactories.validUntil')} hint={t('sellerFactories.validUntilHint', { days: String(reverificationDays) })}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={validUntil}
              onChange={(event) => {
                setValidUntil(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        {!verified && (
          <Button
            variant="primary"
            size="sm"
            disabled={!canVerify || isPending}
            onClick={() => {
              onDecide({ decision: 'VERIFIED', reason: clean(reason), internalNote: clean(note), validUntil: clean(validUntil) });
            }}
          >
            {t('sellerFactories.verify')}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          disabled={isPending}
          onClick={() => {
            const why = clean(reason);
            setMissingReason(why === null || why.length < 5);
            if (why !== null && why.length >= 5) {
              onDecide({ decision: 'REJECTED', reason: why, internalNote: clean(note), validUntil: null });
            }
          }}
        >
          {t(verified ? 'sellerFactories.withdraw' : 'sellerFactories.refuse')}
        </Button>
      </div>
    </div>
  );
}

function FactoryReview({
  factory,
  reverificationDays,
  queryKey,
}: {
  factory: ReviewFactory;
  reverificationDays: number;
  queryKey: string[];
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const document = useOpenDocument();
  const [problem, setProblem] = useState<string | null>(null);
  const { status, checkId } = factory.verification;
  const canDecide = can(Permission.CUSTOMER_STATUS_WRITE) && checkId !== null && (status === 'PENDING' || status === 'VERIFIED');

  const decide = useMutation({
    mutationFn: (input: { decision: 'VERIFIED' | 'REJECTED'; reason: string | null; internalNote: string | null; validUntil: string | null }) =>
      api.post(`/admin/seller-factories/${factory.id}/decision`, { ...input, expectedCheckId: checkId }),
    onSuccess: async () => {
      setProblem(null);
      await client.invalidateQueries({ queryKey });
      toast.success(t('sellerFactories.decided'));
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('sellerFactories.decideFailed')));
      // A refusal usually means the factory moved on; show it as it is now.
      void client.invalidateQueries({ queryKey });
    },
  });

  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium text-ink">{factory.name}</p>
          <p className="break-words text-xs text-ink-muted">
            {[factory.addressLine1, factory.addressLine2, factory.city, factory.region, factory.postcode, factory.countryCode].filter(Boolean).join(', ')}
          </p>
        </div>
        <Badge tone={FACTORY_TONE[status]}>{t(`sellerFactories.status.${status}` as TranslationKey)}</Badge>
      </div>

      <DescriptionList
        items={[
          {
            label: t('sellerFactories.coordinates'),
            value: factory.latitude === null ? '—' : `${String(factory.latitude)}, ${String(factory.longitude)}`,
          },
          { label: t('sellerFactories.established'), value: dash(factory.establishedYear) },
          { label: t('sellerFactories.floorArea'), value: factory.floorAreaSqm === null ? '—' : `${String(factory.floorAreaSqm)} m²` },
          { label: t('sellerFactories.workforce'), value: dash(factory.workforceCount) },
          { label: t('sellerFactories.qcStaff'), value: dash(factory.qcStaffCount) },
          {
            label: t('sellerFactories.capacity'),
            value: factory.monthlyCapacity === null ? '—' : `${String(factory.monthlyCapacity)} ${factory.capacityUnit ?? ''}`.trim(),
          },
          { label: t('sellerFactories.productsMade'), value: dash(factory.productsMade) },
          { label: t('sellerFactories.qcProcess'), value: dash(factory.qcProcess) },
          { label: t('sellerFactories.validUntilLabel'), value: factory.verification.validUntil === null ? '—' : formatDate(factory.verification.validUntil) },
        ]}
      />

      <div>
        <p className="text-xs font-semibold text-ink-muted">{t('sellerFactories.machines')}</p>
        {factory.machines.length === 0 ? (
          <p className="text-xs text-ink-subtle">{t('sellerFactories.noMachines')}</p>
        ) : (
          <ul className="text-xs text-ink">
            {factory.machines.map((machine) => (
              <li key={machine.id} className="break-words">
                {machine.name} × {machine.quantity}
                {machine.capacityNote !== null && <span className="text-ink-muted"> · {machine.capacityNote}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold text-ink-muted">{t('sellerFactories.evidence')}</p>
        {factory.evidence.length === 0 ? (
          <p className="text-xs text-ink-subtle">{t('sellerFactories.noEvidence')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle text-xs">
            {factory.evidence.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="min-w-0 break-all text-ink">{item.document?.originalFileName ?? t('sellerFactories.documentGone')}</span>
                {item.caption !== null && <span className="text-ink-muted">{item.caption}</span>}
                {item.capturedLatitude !== null && (
                  <span className="text-ink-muted">
                    {t('sellerFactories.capturedAt', { point: `${String(item.capturedLatitude)}, ${String(item.capturedLongitude)}` })}
                  </span>
                )}
                {item.document?.isReplaced === true && <Badge tone="neutral">{t('sellerFactories.replaced')}</Badge>}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  isLoading={document.pendingId === item.documentId}
                  aria-label={t('sellerFactories.openNamed', { name: item.document?.originalFileName ?? '' })}
                  onClick={() => {
                    document.open(item.documentId);
                  }}
                >
                  {t('sellerFactories.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {factory.history.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-ink-muted">{t('sellerFactories.history')}</p>
          <ol className="space-y-1 text-xs">
            {[...factory.history].reverse().map((entry) => (
              <li key={entry.id} className="break-words text-ink-muted">
                <span className="text-ink">{t(`sellerFactories.historyState.${entry.state}` as TranslationKey)}</span> · {formatDateTime(entry.at)}
                {' · '}
                {entry.decidedBy === null || entry.decidedBy === undefined
                  ? t(entry.state === 'EXPIRED' ? 'sellerFactories.bySystem' : 'sellerFactories.bySeller')
                  : (entry.decidedBy.email ?? entry.decidedBy.id)}
                {entry.reason !== null && <span className="block text-ink">{t('sellerFactories.toldSeller', { reason: entry.reason })}</span>}
                {entry.internalNote !== null && entry.internalNote !== undefined && (
                  <span className="block">{t('sellerFactories.internal', { note: entry.internalNote })}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {canDecide && (
        <DecisionForm
          kind="factory"
          verified={status === 'VERIFIED'}
          canVerify={factory.evidence.length > 0}
          reverificationDays={reverificationDays}
          isPending={decide.isPending}
          onDecide={(input) => {
            decide.mutate(input);
          }}
        />
      )}
      {canDecide && status === 'PENDING' && factory.evidence.length === 0 && (
        <p className="text-xs text-ink-muted">{t('sellerFactories.needsEvidence')}</p>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </li>
  );
}

function CertificationReview({ certification, queryKey }: { certification: ReviewCertification; queryKey: string[] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const document = useOpenDocument();
  const [problem, setProblem] = useState<string | null>(null);
  const { state } = certification;
  const canDecide = can(Permission.CUSTOMER_STATUS_WRITE) && (state === 'PENDING' || state === 'VERIFIED');

  const decide = useMutation({
    mutationFn: (input: { decision: 'VERIFIED' | 'REJECTED'; reason: string | null }) =>
      api.post(`/admin/seller-certifications/${certification.id}/decision`, { ...input, expectedState: state }),
    onSuccess: async () => {
      setProblem(null);
      await client.invalidateQueries({ queryKey });
      toast.success(t('sellerFactories.decided'));
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('sellerFactories.decideFailed')));
      void client.invalidateQueries({ queryKey });
    },
  });

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium text-ink">{certification.standard}</p>
          <p className="break-words text-xs text-ink-muted">
            {[certification.issuer, certification.certificateNumber, certification.factoryName ?? t('sellerFactories.wholeBusiness')]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Badge tone={CHECK_TONE[state]}>{t(`sellerFactories.historyState.${state}` as TranslationKey)}</Badge>
      </div>
      <DescriptionList
        items={[
          { label: t('sellerFactories.issuedOn'), value: certification.issuedOn === null ? '—' : formatDate(certification.issuedOn) },
          { label: t('sellerFactories.expiresOn'), value: certification.expiresOn === null ? '—' : formatDate(certification.expiresOn) },
          { label: t('sellerFactories.scope'), value: dash(certification.scope) },
          {
            label: t('sellerFactories.lastDecision'),
            value:
              certification.verifiedBy === null || certification.verifiedBy === undefined
                ? '—'
                : (certification.verifiedBy.email ?? certification.verifiedBy.id),
          },
        ]}
      />
      {certification.rejectionReason !== null && (
        <p className="text-xs text-ink">{t('sellerFactories.toldSeller', { reason: certification.rejectionReason })}</p>
      )}
      {certification.documentId !== null && (
        <Button
          size="sm"
          variant="secondary"
          isLoading={document.pendingId === certification.documentId}
          aria-label={t('sellerFactories.openNamed', { name: certification.document?.originalFileName ?? certification.standard })}
          onClick={() => {
            if (certification.documentId !== null) document.open(certification.documentId);
          }}
        >
          {t('sellerFactories.openCertificate')}
        </Button>
      )}
      {canDecide && (
        <DecisionForm
          kind="certificate"
          verified={state === 'VERIFIED'}
          canVerify={certification.documentId !== null}
          reverificationDays={null}
          isPending={decide.isPending}
          onDecide={(input) => {
            decide.mutate({ decision: input.decision, reason: input.reason });
          }}
        />
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </li>
  );
}
