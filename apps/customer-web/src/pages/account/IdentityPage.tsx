/**
 * Identity and import - an individual buyer's identity check, their
 * documents and their importer-of-record details (checklist Master row 11).
 *
 * Three panels, in the order somebody fills them in:
 *
 *   - **Identity details.** Legal name, date of birth, nationality, country of
 *     residence and the identity document. Locked while the check is with a
 *     reviewer or verified, because a verified check describes exactly the
 *     details that were checked. The document number is typed whole once and
 *     only its last characters ever come back.
 *   - **Documents.** A copy of the identity document is required to send the
 *     check; proof of address, an import licence and a tax registration are
 *     optional. Each is scanned and stored privately, and a file nobody has
 *     decided on yet can be withdrawn.
 *   - **Importer details.** For somebody who clears goods through customs in
 *     their own name. Always editable, and never "verified": they are the
 *     buyer's own statement, used on the paperwork.
 *
 * Company buyers are checked through the company application instead; this
 * page is the individual's own.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import {
  ID_DOCUMENT_TYPES,
  INCOTERMS,
  KYC_DOCUMENT_KINDS,
  kycApi,
  kycKeys,
  type IdentityDraft,
  type Kyc,
  type KycDocumentKind,
  type KycImporter,
  type KycStatus,
} from '@/lib/customer-kyc';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { CountrySelect } from '@/pages/company/application-parts';
import { AccountPanel } from './AccountPanel';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
const IDENTITY_KINDS = new Set<KycDocumentKind>(['IDENTITY', 'PROOF_OF_ADDRESS']);

const STATUS_TONE: Record<KycStatus, BadgeTone> = {
  NOT_STARTED: 'neutral',
  SUBMITTED: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

export function IdentityPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('kyc.title'), noIndex: true }, business.displayName);

  const kyc = useQuery({ queryKey: kycKeys.kyc, queryFn: kycApi.get });

  return (
    <div>
      <PageHeader title={t('kyc.title')} description={t('kyc.description')} />
      {kyc.isPending ? (
        <LoadingState />
      ) : kyc.isError ? (
        <ErrorState
          error={kyc.error}
          onRetry={() => {
            void kyc.refetch();
          }}
        />
      ) : (
        <div className="space-y-6">
          <StatusPanel kyc={kyc.data} />
          <IdentityPanel kyc={kyc.data} />
          <DocumentsPanel kyc={kyc.data} />
          <ImporterPanel kyc={kyc.data} />
        </div>
      )}
    </div>
  );
}

function useKycMutation<TArgs>(run: (args: TArgs) => Promise<Kyc>, done: TranslationKey) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: (next) => {
      setProblem(null);
      queryClient.setQueryData(kycKeys.kyc, next);
      toast.success(t(done));
    },
    onError: (error) => {
      setProblem(errorMessage(t, error, t('kyc.failed')));
    },
  });
  return { mutation, problem };
}

function Problem({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function StatusPanel({ kyc }: { kyc: Kyc }): React.JSX.Element {
  const { t } = useI18n();
  const { mutation, problem } = useKycMutation(() => kycApi.submit(), 'kyc.submitted');
  const canSubmit = kyc.status === 'NOT_STARTED' || kyc.status === 'REJECTED' || kyc.status === 'EXPIRED';

  return (
    <AccountPanel title={t('kyc.status.title')}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[kyc.status]}>{t(`kyc.status.${kyc.status}` as TranslationKey)}</Badge>
          {kyc.submittedAt !== null && kyc.status === 'SUBMITTED' && (
            <span className="text-xs text-ink-muted">
              {t('kyc.status.sentOn', { date: formatDateTime(kyc.submittedAt) })}
            </span>
          )}
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          {t(`kyc.status.explain.${kyc.status}` as TranslationKey)}
        </p>
        {kyc.status === 'REJECTED' && kyc.reviewNote !== null && (
          <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {t('kyc.status.reason', { reason: kyc.reviewNote })}
          </p>
        )}
        <Problem message={problem} />
        {canSubmit && (
          <Button
            onClick={() => {
              mutation.mutate(undefined);
            }}
            isLoading={mutation.isPending}
          >
            {t('kyc.submit')}
          </Button>
        )}
      </div>
    </AccountPanel>
  );
}

function identityDraftOf(kyc: Kyc): IdentityDraft {
  const { legalName, dateOfBirth, nationality, residenceCountry, idDocumentType, idDocumentExpiresOn } = kyc.identity;
  return { legalName, dateOfBirth, nationality, residenceCountry, idDocumentType, idDocumentExpiresOn };
}

function IdentityPanel({ kyc }: { kyc: Kyc }): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<IdentityDraft>(() => identityDraftOf(kyc));
  const [number, setNumber] = useState('');
  const { mutation, problem } = useKycMutation((body: IdentityDraft) => kycApi.saveIdentity(body), 'kyc.saved');

  useEffect(() => {
    setDraft(identityDraftOf(kyc));
  }, [kyc]);

  const locked = !kyc.editable;
  const set = (patch: Partial<IdentityDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <AccountPanel title={t('kyc.identity.title')} description={t(locked ? 'kyc.identity.locked' : 'kyc.identity.description')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(
            { ...draft, ...(number.trim() === '' ? {} : { idDocumentNumber: number.trim() }) },
            {
              onSuccess: () => {
                setNumber('');
              },
            },
          );
        }}
      >
        <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
          <Field label={t('kyc.identity.legalName')} hint={t('kyc.identity.legalNameHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                autoComplete="name"
                value={draft.legalName ?? ''}
                onChange={(event) => {
                  set({ legalName: event.currentTarget.value });
                }}
              />
            )}
          </Field>
          <Field label={t('kyc.identity.dateOfBirth')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="date"
                autoComplete="bday"
                value={draft.dateOfBirth ?? ''}
                onChange={(event) => {
                  set({ dateOfBirth: event.currentTarget.value === '' ? null : event.currentTarget.value });
                }}
              />
            )}
          </Field>
          <Field label={t('kyc.identity.nationality')}>
            {({ inputId, describedBy }) => (
              <CountrySelect
                id={inputId}
                describedBy={describedBy}
                value={draft.nationality ?? ''}
                onChange={(code) => {
                  set({ nationality: code === '' ? null : code });
                }}
              />
            )}
          </Field>
          <Field label={t('kyc.identity.residenceCountry')}>
            {({ inputId, describedBy }) => (
              <CountrySelect
                id={inputId}
                describedBy={describedBy}
                value={draft.residenceCountry ?? ''}
                onChange={(code) => {
                  set({ residenceCountry: code === '' ? null : code });
                }}
              />
            )}
          </Field>
          <Field label={t('kyc.identity.documentType')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={draft.idDocumentType ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  set({ idDocumentType: value === '' ? null : (value as IdentityDraft['idDocumentType']) });
                }}
              >
                <option value="">{t('kyc.identity.chooseDocumentType')}</option>
                {ID_DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`kyc.documentType.${type}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('kyc.identity.documentNumber')}
            hint={
              kyc.identity.idDocumentNumberMasked === null
                ? t('kyc.identity.documentNumberHint')
                : t('kyc.identity.documentNumberStored', { masked: kyc.identity.idDocumentNumberMasked })
            }
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                autoComplete="off"
                spellCheck={false}
                value={number}
                onChange={(event) => {
                  setNumber(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label={t('kyc.identity.documentExpires')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="date"
                value={draft.idDocumentExpiresOn ?? ''}
                onChange={(event) => {
                  set({ idDocumentExpiresOn: event.currentTarget.value === '' ? null : event.currentTarget.value });
                }}
              />
            )}
          </Field>
        </fieldset>
        <Problem message={problem} />
        {!locked && (
          <Button type="submit" isLoading={mutation.isPending}>
            {t('kyc.identity.save')}
          </Button>
        )}
      </form>
    </AccountPanel>
  );
}

const DOCUMENT_TONE: Record<string, BadgeTone> = { PENDING: 'warning', ACCEPTED: 'success', REJECTED: 'danger' };

function DocumentsPanel({ kyc }: { kyc: Kyc }): React.JSX.Element {
  const { t } = useI18n();
  const kinds = KYC_DOCUMENT_KINDS.filter((kind) => kyc.editable || !IDENTITY_KINDS.has(kind));
  const [kind, setKind] = useState<KycDocumentKind>(kinds[0] ?? 'OTHER');
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useKycMutation((file: File) => kycApi.upload(kind, file), 'kyc.documents.uploaded');
  const withdraw = useKycMutation((id: string) => kycApi.withdraw(id), 'kyc.documents.withdrawn');

  useEffect(() => {
    if (!kinds.includes(kind)) setKind(kinds[0] ?? 'OTHER');
  }, [kinds, kind]);

  return (
    <AccountPanel title={t('kyc.documents.title')} description={t('kyc.documents.description')}>
      <div className="space-y-4">
        {kyc.documents.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('kyc.documents.none')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {kyc.documents.map((document) => {
              const canWithdraw = document.status === 'PENDING' && (kyc.editable || !IDENTITY_KINDS.has(document.kind));
              return (
                <li key={document.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                  <span className="font-medium text-ink">{t(`kyc.documentKind.${document.kind}` as TranslationKey)}</span>
                  <span className="min-w-0 truncate text-ink-muted">{document.fileName}</span>
                  <Badge tone={DOCUMENT_TONE[document.status] ?? 'neutral'}>
                    {t(`kyc.documentStatus.${document.status}` as TranslationKey)}
                  </Badge>
                  <span className="text-xs text-ink-muted">{formatDateTime(document.createdAt)}</span>
                  {document.status === 'REJECTED' && document.reviewNote !== null && (
                    <span className="basis-full text-xs text-danger">{t('kyc.status.reason', { reason: document.reviewNote })}</span>
                  )}
                  {canWithdraw && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      isLoading={withdraw.mutation.isPending && withdraw.mutation.variables === document.id}
                      aria-label={t('kyc.documents.withdrawNamed', { name: document.fileName })}
                      onClick={() => {
                        withdraw.mutation.mutate(document.id);
                      }}
                    >
                      {t('kyc.documents.withdraw')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Problem message={withdraw.problem} />

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('kyc.documents.kind')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={kind}
                onChange={(event) => {
                  setKind(event.currentTarget.value as KycDocumentKind);
                }}
              >
                {kinds.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`kyc.documentKind.${entry}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('kyc.documents.file')} hint={t('kyc.documents.fileHint')}>
            {({ inputId, describedBy }) => (
              <input
                ref={inputRef}
                id={inputId}
                type="file"
                accept={ACCEPT}
                aria-describedby={describedBy}
                disabled={upload.mutation.isPending}
                className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file === undefined) return;
                  upload.mutation.mutate(file, {
                    onSettled: () => {
                      if (inputRef.current !== null) inputRef.current.value = '';
                    },
                  });
                }}
              />
            )}
          </Field>
        </div>
        {upload.mutation.isPending && (
          <p role="status" className="text-xs text-ink-muted">
            {t('kyc.documents.uploading')}
          </p>
        )}
        <Problem message={upload.problem} />
      </div>
    </AccountPanel>
  );
}

function ImporterPanel({ kyc }: { kyc: Kyc }): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<KycImporter>(kyc.importer);
  const { mutation, problem } = useKycMutation((body: KycImporter) => kycApi.saveImporter(body), 'kyc.saved');

  useEffect(() => {
    setDraft(kyc.importer);
  }, [kyc]);

  const set = (patch: Partial<KycImporter>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const text = (key: keyof KycImporter, label: TranslationKey, hint?: TranslationKey, type = 'text') => (
    <Field label={t(label)} {...(hint === undefined ? {} : { hint: t(hint) })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          type={type}
          value={(draft[key] as string | null) ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value;
            set({ [key]: value.trim() === '' ? null : value });
          }}
        />
      )}
    </Field>
  );

  return (
    <AccountPanel title={t('kyc.importer.title')} description={t('kyc.importer.description')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(draft);
        }}
      >
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border text-brand"
            checked={draft.isImporter}
            onChange={(event) => {
              set({ isImporter: event.currentTarget.checked });
            }}
          />
          <span>{t('kyc.importer.isImporter')}</span>
        </label>
        {draft.isImporter && (
          <div className="grid gap-4 sm:grid-cols-2">
            {text('importerName', 'kyc.importer.name')}
            {text('eoriNumber', 'kyc.importer.eori', 'kyc.importer.eoriHint')}
            {text('importerTaxId', 'kyc.importer.taxId')}
            {text('importLicenceNumber', 'kyc.importer.licence')}
            {text('customsBrokerName', 'kyc.importer.brokerName')}
            {text('customsBrokerEmail', 'kyc.importer.brokerEmail', undefined, 'email')}
            <Field label={t('kyc.importer.incoterm')} hint={t('kyc.importer.incotermHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.preferredIncoterm ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    set({ preferredIncoterm: value === '' ? null : value });
                  }}
                >
                  <option value="">{t('kyc.importer.noIncoterm')}</option>
                  {INCOTERMS.map((term) => (
                    <option key={term} value={term}>
                      {term}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        <Problem message={problem} />
        <Button type="submit" isLoading={mutation.isPending}>
          {t('kyc.importer.save')}
        </Button>
      </form>
    </AccountPanel>
  );
}
