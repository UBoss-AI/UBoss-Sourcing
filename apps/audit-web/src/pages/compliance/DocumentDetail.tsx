/**
 * One compliance document, opened over the list: the file itself, what it
 * claims, what the audit team recorded about it, its versions, its history,
 * and the review form.
 *
 * Wording matters here. A reviewer records HOW a document was checked and
 * WHAT the outside source said; the console never calls a document
 * "authentic", and "could not be checked" is never an accusation. The badge
 * shown is the server's own summary of that record.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChipInput,
  DownloadButton,
  EnumBadge,
  FilePreview,
  HistoryList,
  MutationError,
  QueryBoundary,
  SectionHeading,
} from '@/components/console';
import { Modal } from '@/components/Modal';
import { Badge, Button, Callout, DescriptionList, Field, Input, MultiSelect, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import {
  consoleKeys,
  decideDocument,
  documentFilePath,
  fetchCoverage,
  fetchDocument,
  type DocumentActionName,
} from '@/lib/console-api';
import {
  VERIFICATION_METHODS,
  VERIFICATION_OUTCOMES,
  type CoverageRow,
  type DocumentDecisionInput,
  type DocumentDetail as DocumentDetailData,
} from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatBytes, formatCalendarDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import {
  documentActionNeedsMessage,
  documentActionsFor,
  expectedStatusOf,
  isPreviewable,
  normaliseRequirementCode,
} from './compliance-rules';

const ACTION_LABEL: Record<DocumentActionName, TranslationKey> = {
  start: 'documents.action.start',
  'request-changes': 'documents.action.requestChanges',
  approve: 'documents.action.approve',
  reject: 'documents.action.reject',
  suspend: 'documents.action.suspend',
};

export function DocumentDetailDialog({ documentId, onClose }: { documentId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useQuery({ queryKey: consoleKeys.document(documentId), queryFn: () => fetchDocument(documentId) });
  const coverage = useQuery({
    queryKey: consoleKeys.coverage(),
    queryFn: fetchCoverage,
    enabled: can(Permission.RULE_READ),
    staleTime: 5 * 60_000,
  });

  const title = query.data === undefined ? t('documents.detailTitle') : query.data.document.standard;

  return (
    <Modal isOpen onClose={onClose} size="xl" title={title} description={t('documents.detailDescription')}>
      <QueryBoundary query={query}>
        {(detail) => <DocumentBody detail={detail} categories={coverage.data?.categories ?? null} />}
      </QueryBoundary>
    </Modal>
  );
}

function DocumentBody({
  detail,
  categories,
}: {
  detail: DocumentDetailData;
  categories: CoverageRow[] | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const doc = detail.document;
  const names = useMemo(() => new Map((categories ?? []).map((row) => [row.categoryId, row.name])), [categories]);
  const categoryName = (id: string): string => names.get(id) ?? id;

  const file = detail.file;
  const actions = can(Permission.CASE_REVIEW) ? documentActionsFor(doc.reviewStatus) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <EnumBadge family="documentStatus" value={doc.reviewStatus} />
        {doc.badge !== null && <EnumBadge family="documentBadge" value={doc.badge} />}
        <Badge tone="neutral">{t('documents.revision', { revision: String(doc.revision) })}</Badge>
        {doc.supersededAt !== null && <Badge tone="neutral">{t('documents.superseded')}</Badge>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="doc-file">
          <SectionHeading
            id="doc-file"
            title={t('documents.file')}
            description={file === null ? undefined : `${file.fileName} · ${formatBytes(file.byteSize)}`}
            actions={
              file !== null && isPreviewable(file.scanState) ? (
                <DownloadButton path={documentFilePath(doc.id)} fileName={file.fileName} />
              ) : undefined
            }
          />
          {file === null || !doc.hasFile ? (
            <Callout tone="warning">{t('documents.noFile')}</Callout>
          ) : isPreviewable(file.scanState) ? (
            <FilePreview path={documentFilePath(doc.id)} name={file.fileName} />
          ) : (
            <Callout tone="warning" title={enumLabel(t, 'scanState', file.scanState)}>
              {t('documents.notScanned')}
            </Callout>
          )}
        </section>

        <section aria-labelledby="doc-facts" className="space-y-5">
          <SectionHeading id="doc-facts" title={t('documents.claims')} description={t('documents.claimsHint')} />
          <DescriptionList
            items={[
              { label: t('documents.col.type'), value: enumLabel(t, 'documentType', doc.documentType) },
              { label: t('documents.certificateNumber'), value: doc.certificateNumber ?? '—' },
              { label: t('documents.issuer'), value: doc.issuer },
              { label: t('documents.issuingCountry'), value: doc.issuingCountry ?? '—' },
              { label: t('documents.legalEntity'), value: doc.legalEntityName ?? '—' },
              { label: t('documents.issuedOn'), value: formatCalendarDate(doc.issuedOn) },
              {
                label: t('documents.col.expires'),
                value: doc.expiresOn === null ? t('documents.noExpiry', { reason: doc.noExpiryReason ?? '—' }) : formatCalendarDate(doc.expiresOn),
              },
              {
                label: t('documents.col.seller'),
                value: (
                  <Link className="text-accent hover:underline" to={`/sellers/${doc.sellerAccountId}`}>
                    {t('documents.openSeller')}
                  </Link>
                ),
              },
            ]}
          />

          <div>
            <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('documents.scopeCategories')}</p>
            {doc.categoryScopeIds.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">{t('common.none')}</p>
            ) : (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {doc.categoryScopeIds.map((id) => (
                  <li key={id}>
                    <Badge tone="neutral">{categoryName(id)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(doc.scope !== null || doc.modelScope !== null) && (
            <DescriptionList
              columns={1}
              items={[
                ...(doc.scope === null ? [] : [{ label: t('documents.scopeText'), value: doc.scope }]),
                ...(doc.modelScope === null ? [] : [{ label: t('documents.modelScope'), value: doc.modelScope }]),
              ]}
            />
          )}
          <div>
            <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('documents.col.requirements')}</p>
            <p className="mt-1 font-mono text-xs text-ink">
              {doc.requirementCodes.length === 0 ? '—' : doc.requirementCodes.join(', ')}
            </p>
          </div>
        </section>
      </div>

      <section aria-labelledby="doc-check" className="rounded-md border border-border p-4">
        <SectionHeading id="doc-check" title={t('documents.checkRecord')} description={t('documents.checkRecordHint')} />
        <DescriptionList
          columns={3}
          items={[
            { label: t('documents.method'), value: enumLabel(t, 'verificationMethod', doc.verificationMethod) },
            { label: t('documents.outcome'), value: <EnumBadge family="verificationOutcome" value={doc.verificationOutcome} /> },
            { label: t('documents.source'), value: doc.verificationSource ?? '—' },
            { label: t('documents.checkedAt'), value: formatDateTime(doc.verifiedAt) },
            { label: t('case.reviewer'), value: doc.reviewerLabel ?? '—' },
            ...(doc.suspendedReason === null ? [] : [{ label: t('documents.suspendedReason'), value: doc.suspendedReason }]),
          ]}
        />
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5">
            <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('case.sellerMessage')}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-ink">{doc.reviewMessage ?? t('common.none')}</p>
          </div>
          <div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3 py-2.5">
            <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('case.internalNote')}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-ink">{doc.internalNote ?? t('common.none')}</p>
          </div>
        </div>
      </section>

      {actions.length > 0 && <ReviewForm key={doc.reviewStatus} detail={detail} actions={actions} categories={categories} categoryName={categoryName} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="doc-versions">
          <SectionHeading id="doc-versions" title={t('documents.versions')} />
          {detail.versions.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('documents.onlyVersion')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border">
              {detail.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <Link className="text-accent hover:underline" to={`/documents?document=${version.id}`}>
                    {t('documents.revision', { revision: String(version.revision) })}
                  </Link>
                  <span className="flex items-center gap-2">
                    <EnumBadge family="documentStatus" value={version.reviewStatus} />
                    {version.supersededAt !== null && <Badge tone="neutral">{t('documents.superseded')}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="doc-history">
          <SectionHeading id="doc-history" title={t('documents.reviewHistory')} />
          <HistoryList entries={detail.history} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The review form
// ---------------------------------------------------------------------------

type Method = (typeof VERIFICATION_METHODS)[number];
type Outcome = (typeof VERIFICATION_OUTCOMES)[number];

function ReviewForm({
  detail,
  actions,
  categories,
  categoryName,
}: {
  detail: DocumentDetailData;
  actions: readonly DocumentActionName[];
  categories: CoverageRow[] | null;
  categoryName: (id: string) => string;
}): React.JSX.Element {
  const { t } = useI18n();
  const doc = detail.document;
  const [action, setAction] = useState<DocumentActionName>(actions[0] ?? 'start');
  const [method, setMethod] = useState<Method>('MANUAL_EVIDENCE');
  const [outcome, setOutcome] = useState<Outcome>('NOT_CHECKED');
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<string[]>(doc.categoryScopeIds);
  const [codes, setCodes] = useState<string[]>(doc.requirementCodes);
  const [message, setMessage] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [touched, setTouched] = useState(false);

  const expectedStatus = expectedStatusOf(doc.reviewStatus);
  const approving = action === 'approve';
  const needsMessage = documentActionNeedsMessage(action);

  const errors = {
    message: needsMessage && message.trim().length < 10 ? t('documents.form.messageRequired') : undefined,
    source: approving && method !== 'MANUAL_EVIDENCE' && source.trim() === '' ? t('documents.form.sourceRequired') : undefined,
    outcome:
      approving && outcome === 'MISMATCH'
        ? t('documents.form.mismatch')
        : approving && method !== 'MANUAL_EVIDENCE' && outcome === 'NOT_CHECKED'
          ? t('documents.form.outcomeRequired')
          : undefined,
    internalNote:
      approving && outcome === 'UNABLE_TO_VERIFY' && internalNote.trim().length < 10 ? t('documents.form.unableNoteRequired') : undefined,
    scope: approving && scope.length === 0 ? t('documents.form.scopeRequired') : undefined,
  };
  const valid = Object.values(errors).every((value) => value === undefined) && expectedStatus !== null;

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) => {
      const body: DocumentDecisionInput = {
        expectedStatus: expectedStatus ?? 'SUBMITTED',
        ...(action === 'start' || action === 'approve' ? {} : { message: message.trim() }),
        ...(approving && message.trim() !== '' ? { message: message.trim() } : {}),
        internalNote: internalNote.trim() === '' ? null : internalNote.trim(),
        ...(approving
          ? {
              verificationMethod: method,
              verificationOutcome: outcome,
              verificationSource: source.trim() === '' ? null : source.trim(),
              categoryScopeIds: scope,
              requirementCodes: codes,
            }
          : {}),
      };
      return decideDocument(doc.id, action, body, key);
    },
    invalidate: [consoleKeys.document(doc.id), consoleKeys.documentsAll(), consoleKeys.seller(doc.sellerAccountId), consoleKeys.casesAll()],
    successMessage: t('documents.form.done'),
    onSuccess: () => {
      setTouched(false);
      setMessage('');
      setInternalNote('');
    },
  });

  const show = (key: keyof typeof errors): string | undefined => (touched ? errors[key] : undefined);
  const categoryOptions = categories === null ? doc.categoryScopeIds.map((id) => ({ id, label: id, depth: 0 })) : categories.map((row) => ({ id: row.categoryId, label: row.name, depth: row.depth }));

  return (
    <section aria-labelledby="doc-review" className="rounded-lg border border-accent/30 p-4">
      <SectionHeading id="doc-review" title={t('documents.form.title')} description={t('documents.form.description')} />

      <fieldset>
        <legend className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('documents.form.decision')}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.map((name) => (
            <label
              key={name}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand ${
                action === name ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border-strong text-ink hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name="document-decision"
                className="sr-only"
                checked={action === name}
                onChange={() => {
                  setAction(name);
                  setTouched(false);
                }}
              />
              {t(ACTION_LABEL[name])}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 space-y-4">
        {approving && (
          <>
            <Callout tone="info">{t('documents.form.approveExplain')}</Callout>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('documents.method')} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={method}
                    onChange={(event) => {
                      setMethod(event.target.value as Method);
                    }}
                  >
                    {VERIFICATION_METHODS.map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'verificationMethod', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('documents.outcome')} required error={show('outcome')}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={show('outcome') !== undefined}
                    value={outcome}
                    onChange={(event) => {
                      setOutcome(event.target.value as Outcome);
                    }}
                  >
                    {VERIFICATION_OUTCOMES.map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'verificationOutcome', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {outcome === 'MISMATCH' && <Callout tone="danger">{t('documents.form.mismatch')}</Callout>}
            {outcome === 'UNABLE_TO_VERIFY' && <Callout tone="warning">{t('documents.form.unableExplain')}</Callout>}
            <Field
              label={t('documents.source')}
              hint={t('documents.form.sourceHint')}
              required={method !== 'MANUAL_EVIDENCE'}
              error={show('source')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={show('source') !== undefined}
                  value={source}
                  maxLength={1024}
                  onChange={(event) => {
                    setSource(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('documents.form.scope')} hint={t('documents.form.scopeHint')} required error={show('scope')}>
              {({ inputId, describedBy }) => (
                <MultiSelect
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={show('scope') !== undefined}
                  size={8}
                  value={scope}
                  onChange={(event) => {
                    setScope(Array.from(event.target.selectedOptions, (option) => option.value));
                  }}
                >
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {`${'  '.repeat(option.depth)}${option.label}`}
                    </option>
                  ))}
                </MultiSelect>
              )}
            </Field>
            {scope.length > 0 && (
              <p className="text-xs text-ink-muted">
                {t('documents.form.scopeChosen', { categories: scope.map(categoryName).join(', ') })}
              </p>
            )}
            <ChipInput
              label={t('documents.form.codes')}
              values={codes}
              onChange={setCodes}
              normalise={normaliseRequirementCode}
              max={40}
              hint={t('documents.form.codesHint')}
            />
          </>
        )}

        {action !== 'start' && (
          <div className="rounded-md border border-accent/30 bg-accent-soft p-3">
            <Field
              label={t('case.sellerMessage')}
              hint={t('case.sellerMessageHint')}
              required={needsMessage}
              error={show('message')}
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={show('message') !== undefined}
                  value={message}
                  maxLength={4000}
                  onChange={(event) => {
                    setMessage(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        )}
        <div className="rounded-md border border-dashed border-border-strong bg-surface-sunken p-3">
          <Field label={t('case.internalNote')} hint={t('case.internalNoteHint')} error={show('internalNote')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={show('internalNote') !== undefined}
                value={internalNote}
                maxLength={4000}
                onChange={(event) => {
                  setInternalNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {mutation.isError && <MutationError error={mutation.error} />}

        <div className="flex justify-end">
          <Button
            variant={action === 'reject' || action === 'suspend' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            disabled={approving && outcome === 'MISMATCH'}
            onClick={() => {
              setTouched(true);
              if (!valid) return;
              mutation.mutate(undefined);
            }}
          >
            {t(ACTION_LABEL[action])}
          </Button>
        </div>
      </div>
    </section>
  );
}
