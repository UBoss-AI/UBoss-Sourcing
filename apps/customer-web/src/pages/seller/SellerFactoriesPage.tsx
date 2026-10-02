/**
 * Seller Hub -> Factories and certificates (checklist Master row 13).
 *
 * The seller records each plant - where it is, what it can make and how much,
 * who works there, how quality is checked, the machines on its floor - and
 * attaches evidence, then sends it to the marketplace to be verified. Their
 * certificates live here too, each with the document that proves it.
 *
 * What the screen promises, and the server enforces:
 *   - Only the marketplace sets a status. There is nothing on this page that
 *     can mark a factory or certificate verified.
 *   - While something is with a reviewer it cannot be changed.
 *   - Changing the facts of a verified factory, or any detail of a verified
 *     certificate, sends it back for review - the dialog says so first.
 *   - Only verified, in-date factories and certificates appear on the
 *     supplier's public page.
 */
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PreviewAsBuyerLink } from './SellerCompanyChangeCard';
import type { SellerOutletContext } from './SellerLayout';
import { Modal } from '@/components/Modal';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatNumber } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import {
  archiveCertification,
  archiveFactory,
  fetchCertifications,
  fetchFactories,
  removeEvidence,
  submitCertification,
  submitFactory,
  type Certification,
  type CertificationState,
  type Factory,
  type FactoryStatus,
} from '@/lib/factories';
import {
  CERTIFICATIONS_KEY,
  CertificationDialog,
  EvidenceDialog,
  FACTORIES_KEY,
  FactoryDialog,
  MachinesDialog,
} from './FactoryDialogs';

const FACTORY_TONE: Record<FactoryStatus, BadgeTone> = {
  NOT_SUBMITTED: 'neutral',
  PENDING: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};
const CERTIFICATE_TONE: Record<CertificationState, BadgeTone> = {
  PENDING: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

type Dialog =
  | { kind: 'factory'; factory: Factory | null }
  | { kind: 'machines'; factory: Factory }
  | { kind: 'evidence'; factory: Factory }
  | { kind: 'archiveFactory'; factory: Factory }
  | { kind: 'certificate'; certification: Certification | null }
  | { kind: 'archiveCertificate'; certification: Certification };

export function SellerFactoriesPage(): React.JSX.Element {
  const { t } = useI18n();
  // Absent outside the Seller Hub layout (a test rendering the page alone).
  const seller = useOutletContext<SellerOutletContext | null | undefined>() ?? null;
  const factories = useQuery({ queryKey: FACTORIES_KEY, queryFn: fetchFactories });
  const certifications = useQuery({ queryKey: CERTIFICATIONS_KEY, queryFn: fetchCertifications });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = (): void => {
    setDialog(null);
  };
  const factoryRows = factories.data?.factories ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.factories.title')}
        description={t('seller.factories.intro')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* What a buyer sees: only verified, in-date factories and certificates. */}
            {seller !== null && <PreviewAsBuyerLink slug={seller.slug} isTrading={seller.isTrading} />}
            <Button
              variant="primary"
              onClick={() => {
                setDialog({ kind: 'factory', factory: null });
              }}
            >
              {t('seller.factories.add')}
            </Button>
          </div>
        }
      />

      <Card title={t('seller.factories.factoriesCard')} description={t('seller.factories.factoriesCardHint')}>
        {factories.isPending && <LoadingState label={t('seller.factories.loading')} />}
        {factories.isError && (
          <ErrorState
            error={factories.error}
            onRetry={() => {
              void factories.refetch();
            }}
          />
        )}
        {factories.isSuccess && factoryRows.length === 0 && (
          <EmptyState title={t('seller.factories.emptyTitle')} description={t('seller.factories.emptyBody')} />
        )}
        {factoryRows.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {factoryRows.map((factory) => (
              <FactoryItem key={factory.id} factory={factory} onDialog={setDialog} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t('seller.factories.certificatesCard')}
        description={t('seller.factories.certificatesCardHint')}
        actions={
          <Button
            onClick={() => {
              setDialog({ kind: 'certificate', certification: null });
            }}
          >
            {t('seller.factories.addCertificate')}
          </Button>
        }
      >
        {certifications.isPending && <LoadingState label={t('seller.factories.loadingCertificates')} />}
        {certifications.isError && (
          <ErrorState
            error={certifications.error}
            onRetry={() => {
              void certifications.refetch();
            }}
          />
        )}
        {certifications.isSuccess && certifications.data.certifications.length === 0 && (
          <EmptyState title={t('seller.factories.noCertificatesTitle')} description={t('seller.factories.noCertificatesBody')} />
        )}
        {certifications.isSuccess && certifications.data.certifications.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {certifications.data.certifications.map((certification) => (
              <CertificationItem key={certification.id} certification={certification} onDialog={setDialog} />
            ))}
          </ul>
        )}
      </Card>

      {dialog?.kind === 'factory' && <FactoryDialog factory={dialog.factory} onClose={close} />}
      {dialog?.kind === 'machines' && <MachinesDialog factory={dialog.factory} onClose={close} />}
      {dialog?.kind === 'evidence' && <EvidenceDialog factory={dialog.factory} onClose={close} />}
      {dialog?.kind === 'certificate' && (
        <CertificationDialog certification={dialog.certification} factories={factoryRows} onClose={close} />
      )}
      {dialog?.kind === 'archiveFactory' && (
        <ArchiveDialog
          title={t('seller.factories.archiveTitle')}
          body={t('seller.factories.archiveBody', { name: dialog.factory.name })}
          action={() => archiveFactory(dialog.factory.id)}
          queryKey={FACTORIES_KEY}
          onClose={close}
        />
      )}
      {dialog?.kind === 'archiveCertificate' && (
        <ArchiveDialog
          title={t('seller.factories.archiveCertificateTitle')}
          body={t('seller.factories.archiveCertificateBody', { name: dialog.certification.standard })}
          action={() => archiveCertification(dialog.certification.id)}
          queryKey={CERTIFICATIONS_KEY}
          onClose={close}
        />
      )}
    </div>
  );
}

/** One sentence on where the verification stands and what to do next. */
function statusLine(t: ReturnType<typeof useI18n>['t'], factory: Factory): string {
  const { verification } = factory;
  switch (verification.status) {
    case 'NOT_SUBMITTED':
      return t(factory.evidence.length === 0 ? 'seller.factories.line.needsEvidence' : 'seller.factories.line.ready');
    case 'PENDING':
      return t('seller.factories.line.pending', { date: formatDate(verification.submittedAt) });
    case 'VERIFIED':
      return t('seller.factories.line.verified', {
        date: formatDate(verification.decidedAt),
        until: formatDate(verification.validUntil),
      });
    case 'REJECTED':
      return t('seller.factories.line.rejected', { date: formatDate(verification.decidedAt) });
    case 'EXPIRED':
      return t('seller.factories.line.expired', { date: formatDate(verification.validUntil) });
  }
}

function FactoryItem({ factory, onDialog }: { factory: Factory; onDialog: (dialog: Dialog) => void }): React.JSX.Element {
  const { t, language } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { status, isEditable } = factory.verification;
  const canSubmit = status === 'NOT_SUBMITTED' || status === 'REJECTED' || status === 'EXPIRED';

  const submit = useMutation({
    mutationFn: () => submitFactory(factory.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: FACTORIES_KEY });
      toast.success(t('seller.factories.submitted', { name: factory.name }));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });
  const detach = useMutation({
    mutationFn: (evidenceId: string) => removeEvidence(factory.id, evidenceId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: FACTORIES_KEY });
      toast.success(t('seller.factories.evidenceRemoved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  const facts: { label: string; value: string }[] = [];
  if (factory.monthlyCapacity !== null) {
    facts.push({
      label: t('seller.factories.fact.capacity'),
      value: `${formatNumber(factory.monthlyCapacity)}${factory.capacityUnit === null ? '' : ` ${factory.capacityUnit}`}`,
    });
  }
  if (factory.workforceCount !== null) facts.push({ label: t('seller.factories.fact.workforce'), value: formatNumber(factory.workforceCount) });
  if (factory.qcStaffCount !== null) facts.push({ label: t('seller.factories.fact.qcStaff'), value: formatNumber(factory.qcStaffCount) });
  if (factory.floorAreaSqm !== null) facts.push({ label: t('seller.factories.fact.floorArea'), value: `${formatNumber(factory.floorAreaSqm)} m²` });
  if (factory.establishedYear !== null) facts.push({ label: t('seller.factories.fact.established'), value: String(factory.establishedYear) });

  return (
    <li className="space-y-3 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-ink">{factory.name}</h3>
          <p className="break-words text-xs text-ink-muted">
            {[factory.addressLine1, factory.city, factory.region, countryName(factory.countryCode, language)].filter(Boolean).join(', ')}
          </p>
        </div>
        <Badge tone={FACTORY_TONE[status]}>{t(`seller.factories.status.${status}` as TranslationKey)}</Badge>
      </div>

      <p className="text-sm text-ink-muted">{statusLine(t, factory)}</p>
      {status === 'REJECTED' && factory.verification.reason !== null && (
        <p className="whitespace-pre-wrap rounded-lg bg-danger-soft px-3 py-2 text-xs leading-relaxed text-ink">{factory.verification.reason}</p>
      )}

      {facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label} className="flex gap-1">
              <dt className="text-ink-muted">{fact.label}</dt>
              <dd className="text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('seller.factories.machines')}</h4>
        {factory.machines.length === 0 ? (
          <p className="text-xs text-ink-subtle">{t('seller.factories.noMachines')}</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-xs text-ink">
            {factory.machines.map((machine) => (
              <li key={machine.id} className="break-words">
                {t('seller.factories.machineLine', { name: machine.name, quantity: formatNumber(machine.quantity) })}
                {machine.capacityNote !== null && <span className="text-ink-muted"> · {machine.capacityNote}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('seller.factories.evidence')}</h4>
        {factory.evidence.length === 0 ? (
          <p className="text-xs text-ink-subtle">{t('seller.factories.noEvidence')}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs">
            {factory.evidence.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 break-all text-ink">{item.document?.originalFileName ?? t('seller.factories.documentGone')}</span>
                {item.caption !== null && <span className="text-ink-muted">· {item.caption}</span>}
                {isEditable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    isLoading={detach.isPending && detach.variables === item.id}
                    aria-label={t('seller.factories.removeEvidenceNamed', { name: item.document?.originalFileName ?? '' })}
                    onClick={() => {
                      detach.mutate(item.id);
                    }}
                  >
                    {t('common.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {!isEditable && <p className="text-xs text-ink-muted">{t('seller.factories.lockedWhilePending')}</p>}

      <div className="flex flex-wrap gap-2">
        {canSubmit && (
          <Button
            variant="primary"
            size="sm"
            isLoading={submit.isPending}
            disabled={factory.evidence.length === 0}
            onClick={() => {
              submit.mutate();
            }}
          >
            {t(status === 'NOT_SUBMITTED' ? 'seller.factories.submit' : 'seller.factories.resubmit')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!isEditable}
          onClick={() => {
            onDialog({ kind: 'factory', factory });
          }}
        >
          {t('seller.factories.edit')}
        </Button>
        <Button
          size="sm"
          disabled={!isEditable}
          onClick={() => {
            onDialog({ kind: 'machines', factory });
          }}
        >
          {t('seller.factories.editMachines')}
        </Button>
        <Button
          size="sm"
          disabled={!isEditable}
          onClick={() => {
            onDialog({ kind: 'evidence', factory });
          }}
        >
          {t('seller.factories.addEvidence')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDialog({ kind: 'archiveFactory', factory });
          }}
        >
          {t('seller.factories.archive')}
        </Button>
      </div>

      {factory.history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">{t('seller.factories.history')}</summary>
          <ol className="mt-2 space-y-1">
            {[...factory.history].reverse().map((entry) => (
              <li key={entry.id} className="break-words text-ink-muted">
                <span className="text-ink">{t(`seller.factories.historyState.${entry.state}` as TranslationKey)}</span> · {formatDate(entry.at)}
                {entry.reason !== null && <span> · {entry.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function CertificationItem({
  certification,
  onDialog,
}: {
  certification: Certification;
  onDialog: (dialog: Dialog) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const submit = useMutation({
    mutationFn: () => submitCertification(certification.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CERTIFICATIONS_KEY });
      toast.success(t('seller.factories.certificateSubmitted', { name: certification.standard }));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  return (
    <li className="space-y-2 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-ink">{certification.standard}</h3>
          <p className="break-words text-xs text-ink-muted">
            {[
              t('seller.factories.issuedBy', { issuer: certification.issuer }),
              certification.certificateNumber,
              certification.factoryName,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Badge tone={CERTIFICATE_TONE[certification.state]}>{t(`seller.factories.certificateState.${certification.state}` as TranslationKey)}</Badge>
      </div>
      <p className="text-xs text-ink-muted">
        {certification.expiresOn === null
          ? t('seller.factories.noExpiry')
          : t('seller.factories.expiresOnLine', { date: formatDate(certification.expiresOn) })}
        {certification.verifiedAt !== null && certification.state === 'VERIFIED' && (
          <> · {t('seller.factories.verifiedOnLine', { date: formatDate(certification.verifiedAt) })}</>
        )}
      </p>
      {certification.expiresSoon && <p className="text-xs font-medium text-warning">{t('seller.factories.expiresSoon')}</p>}
      {certification.state === 'REJECTED' && certification.rejectionReason !== null && (
        <p className="whitespace-pre-wrap rounded-lg bg-danger-soft px-3 py-2 text-xs leading-relaxed text-ink">{certification.rejectionReason}</p>
      )}
      {certification.state === 'EXPIRED' && <p className="text-xs text-ink-muted">{t('seller.factories.certificateExpiredHint')}</p>}
      {!certification.isEditable && <p className="text-xs text-ink-muted">{t('seller.factories.certificateLocked')}</p>}
      <div className="flex flex-wrap gap-2">
        {(certification.state === 'REJECTED' || certification.state === 'EXPIRED') && (
          <Button
            size="sm"
            variant="primary"
            isLoading={submit.isPending}
            onClick={() => {
              submit.mutate();
            }}
          >
            {t('seller.factories.resubmit')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!certification.isEditable}
          onClick={() => {
            onDialog({ kind: 'certificate', certification });
          }}
        >
          {t('seller.factories.edit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDialog({ kind: 'archiveCertificate', certification });
          }}
        >
          {t('seller.factories.archive')}
        </Button>
      </div>
    </li>
  );
}

function ArchiveDialog({
  title,
  body,
  action,
  queryKey,
  onClose,
}: {
  title: string;
  body: string;
  action: () => Promise<unknown>;
  queryKey: readonly string[];
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: action,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey });
      toast.success(t('seller.factories.archived'));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });
  return (
    <Modal isOpen title={title} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{body}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('seller.factories.archive')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
