/**
 * An individual buyer's identity check, on the customer page (checklist
 * Master row 11).
 *
 * Read with customer.read. Deciding - a document or the whole check - and
 * opening a file need buyer_company.review, the same people who check
 * company applications. Every opening of a file is audited by the server.
 *
 * The rules the panel shows, and the server enforces:
 *   - The check can be verified only once the identity document is accepted.
 *   - Refusing a document or the check needs a reason; the buyer sees it.
 *   - A verified check can be withdrawn (refused) if it turns out wrong.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, DescriptionList, Field, Input, LoadingState } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api, downloadFile } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

type KycStatus = 'NOT_STARTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

interface KycDocument {
  id: string;
  kind: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  fileName: string;
  sizeBytes: number;
  reviewNote: string | null;
  createdAt: string;
}

export interface CustomerKyc {
  status: KycStatus;
  identity: {
    legalName: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    residenceCountry: string | null;
    idDocumentType: string | null;
    idDocumentNumberMasked: string | null;
    idDocumentExpiresOn: string | null;
  };
  importer: {
    isImporter: boolean;
    importerName: string | null;
    eoriNumber: string | null;
    importerTaxId: string | null;
    importLicenceNumber: string | null;
    customsBrokerName: string | null;
    customsBrokerEmail: string | null;
    preferredIncoterm: string | null;
  };
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  documents: KycDocument[];
}

const STATUS_TONE: Record<KycStatus, BadgeTone> = {
  NOT_STARTED: 'neutral',
  SUBMITTED: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};
const DOCUMENT_TONE: Record<KycDocument['status'], BadgeTone> = { PENDING: 'warning', ACCEPTED: 'success', REJECTED: 'danger' };

const dash = (value: string | null): string => (value === null || value === '' ? '—' : value);

export function CustomerKycPanel({ customerId }: { customerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canReview = can(Permission.BUYER_COMPANY_REVIEW);
  const key = ['customer', customerId, 'kyc'];
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const query = useQuery({ queryKey: key, queryFn: () => api.get<CustomerKyc>(`/admin/customers/${customerId}/kyc`) });

  const fail = (error: unknown): void => {
    setProblem(errorMessage(t, error, t('customerKyc.failed')));
    // A refusal usually means the record moved on; show it as it is now.
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const decideDocument = useMutation({
    mutationFn: (input: { documentId: string; decision: 'ACCEPTED' | 'REJECTED' }) =>
      api.post<CustomerKyc>(`/admin/customers/${customerId}/kyc/documents/${input.documentId}/decision`, {
        decision: input.decision,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: (next) => {
      setProblem(null);
      setNote('');
      queryClient.setQueryData(key, next);
      toast.success(t('customerKyc.documentDecided'));
    },
    onError: fail,
  });

  const decide = useMutation({
    mutationFn: (decision: 'VERIFIED' | 'REJECTED') =>
      api.post<CustomerKyc>(`/admin/customers/${customerId}/kyc/decision`, {
        decision,
        // What this screen shows. If a colleague decided meanwhile, the server
        // refuses and the reload below shows what they did.
        expectedStatus: query.data?.status,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: (next) => {
      setProblem(null);
      setNote('');
      queryClient.setQueryData(key, next);
      toast.success(t('customerKyc.decided'));
    },
    onError: fail,
  });

  const open = useMutation({
    mutationFn: (document: KycDocument) =>
      downloadFile(`/admin/customers/${customerId}/kyc/documents/${document.id}/file`, document.fileName),
    onError: fail,
  });

  if (query.isPending) {
    return (
      <Card title={t('customerKyc.title')}>
        <LoadingState label={t('customerKyc.loading')} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card title={t('customerKyc.title')}>
        <p className="px-5 py-4 text-sm text-ink-muted">{t('customerKyc.failed')}</p>
      </Card>
    );
  }

  const kyc = query.data;
  const identityAccepted = kyc.documents.some((document) => document.kind === 'IDENTITY' && document.status === 'ACCEPTED');
  const working = decide.isPending || decideDocument.isPending;

  return (
    <Card
      title={t('customerKyc.title')}
      description={t('customerKyc.description')}
      actions={<Badge tone={STATUS_TONE[kyc.status]}>{t(`customerKyc.status.${kyc.status}` as TranslationKey)}</Badge>}
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        {kyc.status === 'NOT_STARTED' ? (
          <p className="text-ink-muted">{t('customerKyc.notStarted')}</p>
        ) : (
          <DescriptionList
            items={[
              { label: t('customerKyc.legalName'), value: dash(kyc.identity.legalName) },
              { label: t('customerKyc.dateOfBirth'), value: dash(kyc.identity.dateOfBirth) },
              { label: t('customerKyc.nationality'), value: dash(kyc.identity.nationality) },
              { label: t('customerKyc.residence'), value: dash(kyc.identity.residenceCountry) },
              {
                label: t('customerKyc.document'),
                value: `${dash(kyc.identity.idDocumentType)} · ${dash(kyc.identity.idDocumentNumberMasked)}`,
              },
              { label: t('customerKyc.expires'), value: dash(kyc.identity.idDocumentExpiresOn) },
              { label: t('customerKyc.submitted'), value: kyc.submittedAt === null ? '—' : formatDateTime(kyc.submittedAt) },
            ]}
          />
        )}

        {kyc.importer.isImporter && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('customerKyc.importer')}</h3>
            <DescriptionList
              items={[
                { label: t('customerKyc.importerName'), value: dash(kyc.importer.importerName) },
                { label: 'EORI', value: dash(kyc.importer.eoriNumber) },
                { label: t('customerKyc.taxId'), value: dash(kyc.importer.importerTaxId) },
                { label: t('customerKyc.licence'), value: dash(kyc.importer.importLicenceNumber) },
                { label: t('customerKyc.broker'), value: dash(kyc.importer.customsBrokerName) },
                { label: 'Incoterm', value: dash(kyc.importer.preferredIncoterm) },
              ]}
            />
          </div>
        )}

        {kyc.documents.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {kyc.documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium text-ink">{t(`customerKyc.kind.${document.kind}` as TranslationKey)}</span>
                <span className="min-w-0 truncate text-ink-muted">{document.fileName}</span>
                <Badge tone={DOCUMENT_TONE[document.status]}>{t(`customerKyc.documentStatus.${document.status}` as TranslationKey)}</Badge>
                {document.reviewNote !== null && <span className="basis-full text-xs text-ink-muted">{document.reviewNote}</span>}
                {canReview && (
                  <span className="ml-auto flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      isLoading={open.isPending && open.variables.id === document.id}
                      aria-label={t('customerKyc.openNamed', { name: document.fileName })}
                      onClick={() => {
                        open.mutate(document);
                      }}
                    >
                      {t('customerKyc.open')}
                    </Button>
                    {document.status === 'PENDING' && (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={working}
                          onClick={() => {
                            decideDocument.mutate({ documentId: document.id, decision: 'ACCEPTED' });
                          }}
                        >
                          {t('customerKyc.accept')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={working}
                          onClick={() => {
                            decideDocument.mutate({ documentId: document.id, decision: 'REJECTED' });
                          }}
                        >
                          {t('customerKyc.refuse')}
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canReview && (kyc.status === 'SUBMITTED' || kyc.status === 'VERIFIED' || kyc.documents.some((d) => d.status === 'PENDING')) && (
          <div className="space-y-3">
            <Field label={t('customerKyc.note')} hint={t('customerKyc.noteHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  maxLength={500}
                  value={note}
                  onChange={(event) => {
                    setNote(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            {kyc.status === 'SUBMITTED' && !identityAccepted && <Callout tone="info">{t('customerKyc.acceptFirst')}</Callout>}
            <div className="flex flex-wrap gap-2">
              {kyc.status === 'SUBMITTED' && (
                <Button
                  variant="primary"
                  disabled={!identityAccepted || working}
                  isLoading={decide.isPending && decide.variables === 'VERIFIED'}
                  onClick={() => {
                    decide.mutate('VERIFIED');
                  }}
                >
                  {t('customerKyc.verify')}
                </Button>
              )}
              {(kyc.status === 'SUBMITTED' || kyc.status === 'VERIFIED') && (
                <Button
                  variant="danger"
                  disabled={working}
                  isLoading={decide.isPending && decide.variables === 'REJECTED'}
                  onClick={() => {
                    decide.mutate('REJECTED');
                  }}
                >
                  {kyc.status === 'VERIFIED' ? t('customerKyc.withdraw') : t('customerKyc.refuseCheck')}
                </Button>
              )}
            </div>
          </div>
        )}

        {problem !== null && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
    </Card>
  );
}
