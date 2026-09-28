/**
 * Settings → Legal documents.
 *
 * Where the operator writes and publishes the Terms and Conditions every new
 * account must accept - the buyer terms, and the terms a carrier's staff
 * accept when they activate the logistics portal. Two screens:
 *
 *   - **The list**: every version of each, which one is in force, and how many
 *     people accepted each (never who). It says loudly when nothing is in
 *     force, because then sign-up and invitation activation are refused.
 *   - **One document**: a draft is an editor with a live preview; a published
 *     document is read-only, with its hash, its PDF and the version it
 *     replaced. Nothing here can change a published document - the server
 *     refuses, whoever asks - and publishing says so before it happens.
 *
 * The software supplies no legal wording. The page says so, because an
 * operator who assumed otherwise would be binding customers to a placeholder.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  ErrorState,
  Field,
  Input,
  LinkButton,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { LANGUAGES } from '@/i18n/languages';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import {
  LEGAL_DOCUMENT_KINDS,
  legalDocumentPdfUrl,
  legalDocumentsApi,
  parseLegalBody,
  type LegalDocument,
  type LegalDocumentDraft,
  type LegalDocumentKind,
} from '@/lib/legal-documents';
import { Permission } from '@/lib/permissions';

const LIST_PATH = '/settings/legal-documents';
const QUERY_KEY = ['admin', 'legal-documents'] as const;

function languageName(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.endonym ?? code.toUpperCase();
}

function kindLabel(t: ReturnType<typeof useI18n>['t'], kind: LegalDocumentKind): string {
  return t(`legalDocs.kind.${kind}` as TranslationKey);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function LegalDocumentsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => legalDocumentsApi.list() });
  const documents = query.data;

  const inForce = (kind: LegalDocumentKind): boolean =>
    documents?.some((document) => document.kind === kind && document.isCurrentVersion) ?? true;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('legalDocs.title')}
        description={t('legalDocs.intro')}
        actions={
          can(Permission.LEGAL_DOCUMENT_WRITE) ? (
            <LinkButton to={`${LIST_PATH}/new`} variant="primary">
              {t('legalDocs.newVersion')}
            </LinkButton>
          ) : undefined
        }
      />

      <Callout tone="info" title={t('legalDocs.counselTitle')}>
        {t('legalDocs.counselBody')}
      </Callout>

      {documents !== undefined && !inForce('PLATFORM_TERMS') && (
        <Callout tone="danger" role="alert" title={t('legalDocs.noBuyerTermsTitle')}>
          {t('legalDocs.noBuyerTermsBody')}
        </Callout>
      )}
      {documents !== undefined && !inForce('LOGISTICS_PARTNER_TERMS') && (
        <Callout tone="warning" title={t('legalDocs.noCarrierTermsTitle')}>
          {t('legalDocs.noCarrierTermsBody')}
        </Callout>
      )}

      {query.isLoading && <LoadingState />}
      {query.error !== null && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {documents !== undefined &&
        LEGAL_DOCUMENT_KINDS.map((kind) => (
          <KindTable key={kind} kind={kind} documents={documents.filter((document) => document.kind === kind)} />
        ))}
    </div>
  );
}

function KindTable({ kind, documents }: { kind: LegalDocumentKind; documents: LegalDocument[] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();

  const columns: Column<LegalDocument>[] = [
    {
      key: 'version',
      header: t('legalDocs.column.version'),
      nowrap: true,
      render: (row) => (
        <Link to={`${LIST_PATH}/${row.id}`} className="font-mono text-sm text-accent hover:underline">
          {row.version}
        </Link>
      ),
    },
    {
      key: 'language',
      header: t('legalDocs.column.language'),
      render: (row) => <span className="text-sm text-ink">{languageName(row.locale)}</span>,
    },
    {
      key: 'status',
      header: t('legalDocs.column.status'),
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={row.status === 'PUBLISHED' ? 'neutral' : 'warning'}>
            {t(`legalDocs.status.${row.status}` as TranslationKey)}
          </Badge>
          {row.isCurrentVersion && <Badge tone="success">{t('legalDocs.inForce')}</Badge>}
        </div>
      ),
    },
    {
      key: 'effective',
      header: t('legalDocs.column.effective'),
      secondary: true,
      nowrap: true,
      render: (row) => <span className="text-xs text-ink-muted">{formatDateTime(row.effectiveAt)}</span>,
    },
    {
      key: 'published',
      header: t('legalDocs.column.published'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{row.publishedAt === null ? '—' : formatDate(row.publishedAt)}</span>
      ),
    },
    {
      key: 'accepted',
      header: t('legalDocs.column.acceptances'),
      align: 'right',
      render: (row) => <span className="text-sm text-ink">{formatNumber(row.acceptanceCount)}</span>,
    },
  ];

  return (
    <Card
      title={kindLabel(t, kind)}
      description={t(`legalDocs.kindHelp.${kind}` as TranslationKey)}
      actions={
        can(Permission.LEGAL_DOCUMENT_WRITE) ? (
          <LinkButton to={`${LIST_PATH}/new?kind=${kind}`} size="sm">
            {t('legalDocs.newVersion')}
          </LinkButton>
        ) : undefined
      }
    >
      <DataTable
        caption={kindLabel(t, kind)}
        columns={columns}
        rows={documents}
        rowKey={(row) => row.id}
        emptyTitle={t('legalDocs.emptyTitle')}
        emptyDescription={t('legalDocs.emptyBody')}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

/** `datetime-local` wants the reader's local time with no zone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function emptyDraft(kind: LegalDocumentKind): LegalDocumentDraft {
  return {
    kind,
    version: '',
    locale: 'en',
    title: '',
    body: '',
    changeSummary: null,
    effectiveAt: new Date().toISOString(),
  };
}

function draftOf(document: LegalDocument): LegalDocumentDraft {
  return {
    kind: document.kind,
    version: document.version,
    locale: document.locale,
    title: document.title,
    body: document.body,
    changeSummary: document.changeSummary,
    effectiveAt: document.effectiveAt,
  };
}

export function LegalDocumentEditorPage(): React.JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const query = useQuery({
    queryKey: [...QUERY_KEY, id],
    queryFn: () => legalDocumentsApi.get(id ?? ''),
    enabled: id !== undefined,
  });

  if (id === undefined) return <DraftEditor document={null} />;
  if (query.isLoading) return <LoadingState />;
  if (query.data === undefined) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return query.data.status === 'PUBLISHED' ? (
    <PublishedDocument document={query.data} />
  ) : (
    <DraftEditor key={query.data.id} document={query.data} />
  );
}

function DraftEditor({ document }: { document: LegalDocument | null }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [searchParams] = useSearchParams();

  const initialKind = LEGAL_DOCUMENT_KINDS.find((kind) => kind === searchParams.get('kind')) ?? 'PLATFORM_TERMS';
  const saved = useMemo(() => (document === null ? emptyDraft(initialKind) : draftOf(document)), [document, initialKind]);
  const [draft, setDraft] = useState<LegalDocumentDraft>(saved);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'publish' | 'delete' | null>(null);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const canWrite = can(Permission.LEGAL_DOCUMENT_WRITE);
  const canPublish = can(Permission.LEGAL_DOCUMENT_PUBLISH);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const onError = (error: unknown): void => {
    if (error instanceof ApiError) {
      const errors = error.fieldErrors();
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) return;
    }
    toast.error(errorMessage(t, error));
  };

  const save = useMutation({
    mutationFn: () =>
      document === null ? legalDocumentsApi.create(draft) : legalDocumentsApi.update(document.id, draft),
    onSuccess: async (result) => {
      setFieldErrors({});
      toast.success(t('legalDocs.saved'));
      await client.invalidateQueries({ queryKey: QUERY_KEY });
      if (document === null) void navigate(`${LIST_PATH}/${result.id}`, { replace: true });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => legalDocumentsApi.remove(document?.id ?? ''),
    onSuccess: async () => {
      toast.success(t('legalDocs.deleted'));
      await client.invalidateQueries({ queryKey: QUERY_KEY });
      void navigate(LIST_PATH);
    },
    onError,
  });

  const publish = useMutation({
    mutationFn: () => legalDocumentsApi.publish(document?.id ?? ''),
    onSuccess: async () => {
      setConfirm(null);
      toast.success(t('legalDocs.published'));
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => {
      setConfirm(null);
      onError(error);
    },
  });

  const set = <K extends keyof LegalDocumentDraft>(key: K, value: LegalDocumentDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={document === null ? t('legalDocs.newTitle') : `${kindLabel(t, document.kind)} · ${document.version}`}
        back={{ to: LIST_PATH, label: t('legalDocs.back') }}
        meta={<Badge tone="warning">{t('legalDocs.status.DRAFT')}</Badge>}
        actions={
          <>
            {document !== null && canWrite && (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirm('delete');
                }}
              >
                {t('legalDocs.deleteDraft')}
              </Button>
            )}
            {canWrite && (
              <Button
                isLoading={save.isPending}
                disabled={!isDirty && document !== null}
                onClick={() => {
                  save.mutate();
                }}
              >
                {t('legalDocs.saveDraft')}
              </Button>
            )}
            {document !== null && canPublish && (
              <Button
                variant="primary"
                disabled={isDirty}
                title={isDirty ? t('legalDocs.saveBeforePublish') : undefined}
                onClick={() => {
                  setConfirm('publish');
                }}
              >
                {t('legalDocs.publish')}
              </Button>
            )}
          </>
        }
      />

      {isDirty && document !== null && canPublish && (
        <Callout tone="neutral">{t('legalDocs.saveBeforePublish')}</Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('legalDocs.editorTitle')} bodyClassName="px-5 py-4">
          <fieldset disabled={!canWrite} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('legalDocs.field.kind')} required>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={draft.kind}
                    onChange={(event) => {
                      set('kind', event.target.value as LegalDocumentKind);
                    }}
                  >
                    {LEGAL_DOCUMENT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kindLabel(t, kind)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('legalDocs.field.language')} required error={fieldErrors['locale']}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={draft.locale}
                    onChange={(event) => {
                      set('locale', event.target.value);
                    }}
                  >
                    {LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.endonym}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label={t('legalDocs.field.version')}
                hint={t('legalDocs.field.versionHint')}
                required
                error={fieldErrors['version']}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={draft.version}
                    maxLength={32}
                    invalid={fieldErrors['version'] !== undefined}
                    onChange={(event) => {
                      set('version', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field
                label={t('legalDocs.field.effective')}
                hint={t('legalDocs.field.effectiveHint')}
                required
                error={fieldErrors['effectiveAt']}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="datetime-local"
                    aria-describedby={describedBy}
                    value={toLocalInput(draft.effectiveAt)}
                    onChange={(event) => {
                      if (event.target.value !== '') set('effectiveAt', fromLocalInput(event.target.value));
                    }}
                  />
                )}
              </Field>
            </div>
            <Field label={t('legalDocs.field.title')} required error={fieldErrors['title']}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.title}
                  maxLength={200}
                  invalid={fieldErrors['title'] !== undefined}
                  onChange={(event) => {
                    set('title', event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('legalDocs.field.changeSummary')} hint={t('legalDocs.field.changeSummaryHint')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  rows={2}
                  value={draft.changeSummary ?? ''}
                  onChange={(event) => {
                    set('changeSummary', event.target.value === '' ? null : event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={t('legalDocs.field.body')}
              hint={t('legalDocs.field.bodyHint')}
              required
              error={fieldErrors['body']}
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  rows={18}
                  className="font-mono text-xs"
                  value={draft.body}
                  invalid={fieldErrors['body'] !== undefined}
                  onChange={(event) => {
                    set('body', event.target.value);
                  }}
                />
              )}
            </Field>
          </fieldset>
        </Card>

        {/* Sticky beside a long text box, so the preview stays in view while the
            operator edits the clause they are looking at. */}
        <Card
          title={t('legalDocs.previewTitle')}
          description={t('legalDocs.previewHelp')}
          className="lg:sticky lg:top-20 lg:self-start"
          bodyClassName="relative max-h-[calc(100dvh-12rem)] overflow-y-auto px-5 py-4"
        >
          <LegalPreview title={draft.title} body={draft.body} changeSummary={draft.changeSummary} />
        </Card>
      </div>

      <ConfirmDialog
        isOpen={confirm === 'publish'}
        onClose={() => {
          setConfirm(null);
        }}
        onConfirm={() => {
          publish.mutate();
        }}
        isWorking={publish.isPending}
        title={t('legalDocs.publishConfirmTitle', { version: draft.version })}
        confirmLabel={t('legalDocs.publishConfirm')}
        body={
          <ul className="list-disc space-y-1.5 pl-5">
            <li>{t('legalDocs.publishWarnFrozen')}</li>
            <li>{t('legalDocs.publishWarnAccept')}</li>
            <li>{t('legalDocs.publishWarnDate')}</li>
          </ul>
        }
      />
      <ConfirmDialog
        isOpen={confirm === 'delete'}
        onClose={() => {
          setConfirm(null);
        }}
        onConfirm={() => {
          remove.mutate();
        }}
        isWorking={remove.isPending}
        isDangerous
        title={t('legalDocs.deleteConfirmTitle')}
        confirmLabel={t('legalDocs.deleteDraft')}
        body={t('legalDocs.deleteConfirmBody')}
      />
    </div>
  );
}

function PublishedDocument({ document }: { document: LegalDocument }): React.JSX.Element {
  const { t } = useI18n();
  const meta = (
    <>
      <Badge tone="neutral">{t('legalDocs.status.PUBLISHED')}</Badge>
      {document.isCurrentVersion && <Badge tone="success">{t('legalDocs.inForce')}</Badge>}
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${kindLabel(t, document.kind)} · ${document.version}`}
        back={{ to: LIST_PATH, label: t('legalDocs.back') }}
        meta={meta}
        actions={
          <a href={legalDocumentPdfUrl(document.id)} download className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-ink hover:bg-surface-hover">
            {t('legalDocs.downloadPdf')}
          </a>
        }
      />
      <Callout tone="neutral">{t('legalDocs.publishedFrozen')}</Callout>
      <Card bodyClassName="px-5 py-4">
        <DescriptionList
          columns={3}
          items={[
            { label: t('legalDocs.field.language'), value: languageName(document.locale) },
            { label: t('legalDocs.field.effective'), value: formatDateTime(document.effectiveAt) },
            { label: t('legalDocs.column.published'), value: formatDateTime(document.publishedAt) },
            { label: t('legalDocs.column.acceptances'), value: formatNumber(document.acceptanceCount) },
            {
              label: t('legalDocs.supersedes'),
              value:
                document.supersedesId === null ? (
                  t('legalDocs.supersedesNone')
                ) : (
                  <Link to={`${LIST_PATH}/${document.supersedesId}`} className="text-accent hover:underline">
                    {t('legalDocs.supersedesLink')}
                  </Link>
                ),
            },
            {
              label: 'SHA-256',
              value: <span className="break-all font-mono text-xxs">{document.contentSha256}</span>,
            },
          ]}
        />
      </Card>
      <Card title={document.title} bodyClassName="px-5 py-4">
        <LegalPreview title={null} body={document.body} changeSummary={document.changeSummary} />
      </Card>
    </div>
  );
}

/**
 * The text as a reader will see it. React text only: whatever is typed, even
 * something that looks like HTML, is shown as the characters it is.
 */
export function LegalPreview({
  title,
  body,
  changeSummary,
}: {
  title: string | null;
  body: string;
  changeSummary: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const blocks = parseLegalBody(body);

  return (
    <div className="space-y-4 text-sm leading-relaxed text-ink-muted" data-testid="legal-preview">
      {title !== null && title.trim() !== '' && <p className="text-base font-semibold text-ink">{title}</p>}
      {changeSummary !== null && changeSummary.trim() !== '' && (
        <div className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs">
          <p className="font-semibold text-ink">{t('legalDocs.changeSummaryLabel')}</p>
          <p className="mt-1 whitespace-pre-line">{changeSummary}</p>
        </div>
      )}
      {blocks.length === 0 && <p className="italic text-ink-subtle">{t('legalDocs.previewEmpty')}</p>}
      {blocks.map((block, index) => {
        const key = `${block.type}-${String(index)}`;
        if (block.type === 'heading') {
          return (
            <h3 key={key} className="pt-1 text-sm font-semibold text-ink">
              {block.text}
            </h3>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={key} className="list-disc space-y-1 pl-6">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${String(itemIndex)}`}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{block.text}</p>;
      })}
    </div>
  );
}
