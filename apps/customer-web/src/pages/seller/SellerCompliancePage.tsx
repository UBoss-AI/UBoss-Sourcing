/**
 * Seller Hub -> Compliance.
 *
 * For each category the seller sells in: whether an approved requirement
 * reaches it, whether they are qualified, and what the deployment's
 * enforcement setting (off, warn, enforce) means for a new listing there.
 * Then their qualification cases - status in words, the reviewer's message to
 * them, and requirement by requirement what is satisfied and what is not -
 * and their compliance documents with every version.
 *
 * What the screen promises, and the server enforces:
 *   - Only a reviewer in the Audit Console approves or rejects. Nothing here
 *     can qualify a seller, and a case in a category no approved rule reaches
 *     is never "qualified by default".
 *   - An approved document has been REVIEWED. It is never called authentic.
 *   - Inspection findings belong to the inspector. Nothing here edits them.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, Textarea, type BadgeTone } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { newIdempotencyKey } from '@/lib/api';
import {
  canSubmitDocument,
  caseStatusLabel,
  complianceKeys,
  documentStatusLabel,
  documentTypeLabel,
  fetchComplianceCase,
  fetchComplianceDocument,
  fetchComplianceOverview,
  marketLabel,
  requirementStateLabel,
  respondToCase,
  submitComplianceDocument,
  supplyRoleLabel,
  type CategoryGate,
  type ComplianceCase,
  type ComplianceDocument,
  type EnforcementMode,
} from '@/lib/compliance';
import { errorMessage } from '@/lib/errors';
import { fetchFactories, type Factory } from '@/lib/factories';
import { formatDate, formatDateTime } from '@/lib/format';
import { CaseRequestForm, ComplianceDocumentForm } from './ComplianceForms';
import { FACTORIES_KEY } from './factory-query-keys';

const CASE_TONES: Record<string, BadgeTone> = {
  REQUESTED: 'brand',
  UNDER_REVIEW: 'brand',
  CHANGES_REQUESTED: 'warning',
  QUALIFIED: 'success',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
  EXPIRED: 'warning',
  REREVIEW_REQUIRED: 'warning',
  WITHDRAWN: 'neutral',
};
const DOCUMENT_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'brand',
  UNDER_REVIEW: 'brand',
  CHANGES_REQUESTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
  SUSPENDED: 'danger',
};
const STATE_TONES: Record<string, BadgeTone> = {
  SATISFIED: 'success',
  MISSING: 'danger',
  EXPIRED: 'danger',
  WRONG_SCOPE: 'warning',
  PENDING_REVIEW: 'brand',
  NOT_APPLICABLE: 'neutral',
  NEEDS_DETERMINATION: 'warning',
  UNRESOLVED: 'warning',
  OPTIONAL_NOT_HELD: 'neutral',
};
/** A case the seller may still withdraw: nothing has been decided. */
const WITHDRAWABLE = new Set(['REQUESTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED']);
const QUALIFIED = new Set(['QUALIFIED', 'REREVIEW_REQUIRED']);

function dateOnly(value: string | null): string {
  return value === null ? '—' : formatDate(value.length === 10 ? `${value}T12:00:00` : value);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoryRow({ category, qualified, onRequest }: { category: CategoryGate; qualified: boolean; onRequest: () => void }): React.JSX.Element {
  const { t } = useI18n();
  let badge: { tone: BadgeTone; text: string };
  let sentence: string;
  if (qualified) {
    badge = { tone: 'success', text: t('compliance.category.qualified') };
    sentence = t('compliance.category.qualifiedBody');
  } else if (category.mode === 'OFF') {
    badge = { tone: 'neutral', text: t('compliance.category.notChecked') };
    sentence = t('compliance.category.notCheckedBody');
  } else if (!category.missing) {
    badge = { tone: 'neutral', text: t('compliance.category.noRule') };
    sentence = t('compliance.category.noRuleBody');
  } else if (category.allowed) {
    badge = { tone: 'warning', text: t('compliance.category.neededWarn') };
    sentence = t('compliance.category.neededWarnBody');
  } else {
    badge = { tone: 'danger', text: t('compliance.category.neededEnforce') };
    sentence = t('compliance.category.neededEnforceBody');
  }
  return (
    <li className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {category.name} <Badge tone={badge.tone}>{badge.text}</Badge>
        </p>
        <p className="mt-0.5 text-ink-muted">{sentence}</p>
      </div>
      {!qualified && (
        <Button size="sm" variant="secondary" onClick={onRequest}>
          {t('compliance.category.request')}
        </Button>
      )}
    </li>
  );
}

function modeSentence(mode: EnforcementMode | undefined): 'compliance.mode.OFF' | 'compliance.mode.WARN' | 'compliance.mode.ENFORCE' {
  return mode === 'ENFORCE' ? 'compliance.mode.ENFORCE' : mode === 'WARN' ? 'compliance.mode.WARN' : 'compliance.mode.OFF';
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

function CaseDetailPanel({ caseId }: { caseId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const detail = useQuery({ queryKey: complianceKeys.case(caseId), queryFn: () => fetchComplianceCase(caseId) });
  const [answer, setAnswer] = useState('');
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);

  const respond = useMutation({
    mutationFn: (action: 'RESUBMIT' | 'WITHDRAW') => respondToCase(caseId, { action, message: answer.trim() === '' ? null : answer.trim() }, attemptKey),
    onSuccess: async (_ok, action) => {
      setAttemptKey(newIdempotencyKey());
      setAnswer('');
      toast.success(action === 'WITHDRAW' ? t('compliance.case.withdrawn') : t('compliance.case.answered'));
      await Promise.all([cache.invalidateQueries({ queryKey: complianceKeys.overview }), cache.invalidateQueries({ queryKey: complianceKeys.case(caseId) })]);
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  if (detail.isPending) return <LoadingState label={t('compliance.loading')} />;
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  const { evaluation, history } = detail.data;
  const current = detail.data.case;
  const blocking = evaluation.outcomes.filter((outcome) => outcome.blocking).length;

  return (
    <div className="mt-3 space-y-4 rounded-md border border-border-subtle p-4">
      <div>
        <p className="font-medium text-ink">{t('compliance.case.checklist')}</p>
        {evaluation.noApprovedRules ? (
          <p className="mt-1 text-ink-muted">{t('compliance.case.noApprovedRules')}</p>
        ) : (
          <p className="mt-1 text-ink-muted">
            {evaluation.ready ? t('compliance.case.ready') : t('compliance.case.notReady', { blocking: String(blocking) })}
          </p>
        )}
        {evaluation.outcomes.length > 0 && (
          <ul className="mt-2 divide-y divide-border-subtle" aria-label={t('compliance.case.checklist')}>
            {evaluation.outcomes.map((outcome) => (
              <li key={outcome.requirementId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  {outcome.name} <span className="text-ink-muted">({outcome.code})</span>
                  {outcome.obligation === 'OPTIONAL_QUALIFICATION' && <span className="text-ink-muted"> · {t('compliance.case.optional')}</span>}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATE_TONES[outcome.state] ?? 'neutral'}>{requirementStateLabel(t, outcome.state)}</Badge>
                  {outcome.blocking && <span className="text-xs font-medium text-danger">{t('compliance.case.blocks')}</span>}
                  {outcome.validUntil !== null && <span className="text-xs text-ink-muted">{t('compliance.case.validUntil', { date: dateOnly(outcome.validUntil) })}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {current.status === 'CHANGES_REQUESTED' && (
        <div className="space-y-2">
          <Textarea
            aria-label={t('compliance.case.answerLabel')}
            placeholder={t('compliance.case.answerLabel')}
            rows={2}
            maxLength={2000}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
              setAttemptKey(newIdempotencyKey());
            }}
          />
          <p className="text-xs text-ink-muted">{t('compliance.case.answerHint')}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {current.status === 'CHANGES_REQUESTED' && (
          <Button
            size="sm"
            variant="primary"
            disabled={respond.isPending}
            onClick={() => {
              respond.mutate('RESUBMIT');
            }}
          >
            {t('compliance.case.resubmit')}
          </Button>
        )}
        {WITHDRAWABLE.has(current.status) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={respond.isPending}
            onClick={() => {
              respond.mutate('WITHDRAW');
            }}
          >
            {t('compliance.case.withdraw')}
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-muted">{t('compliance.case.onlyReviewer')}</p>

      {history.length > 0 && (
        <div>
          <p className="font-medium text-ink">{t('compliance.history')}</p>
          <ol className="mt-1 space-y-1">
            {history.map((event, index) => (
              <li key={`${event.at}-${String(index)}`} className="flex flex-wrap justify-between gap-2 text-xs">
                <span>
                  {event.summary}
                  {event.actorLabel !== null && <span className="text-ink-muted"> — {event.actorLabel}</span>}
                </span>
                <span className="text-ink-muted">{formatDateTime(event.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function CaseItem({ item, categoryName, factories }: { item: ComplianceCase; categoryName: string; factories: Factory[] }): React.JSX.Element {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const site = item.factoryId === null ? null : factories.find((factory) => factory.id === item.factoryId)?.name ?? null;
  return (
    <li className="px-5 py-4 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
            {item.caseNumber}
            <Badge tone={CASE_TONES[item.status] ?? 'neutral'}>{caseStatusLabel(t, item.status)}</Badge>
          </p>
          <p className="text-ink-muted">
            {t('compliance.case.scope', {
              category: categoryName,
              role: supplyRoleLabel(t, item.supplyRole),
              market: marketLabel(t, item.destinationMarket, language),
            })}
            {site !== null && ` · ${t('compliance.case.site', { site })}`}
          </p>
          {item.expiresAt !== null && <p className="text-ink-muted">{t('compliance.case.expires', { date: dateOnly(item.expiresAt) })}</p>}
          {item.sellerMessage !== null && item.sellerMessage.trim() !== '' && (
            <p className="rounded-md bg-surface-sunken px-3 py-2">
              <span className="font-medium">{t('compliance.reviewerMessage')}</span> {item.sellerMessage}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t('compliance.hideDetails') : t('compliance.showDetails')}
        </Button>
      </div>
      {open && <CaseDetailPanel caseId={item.id} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

function DocumentHistory({ documentId }: { documentId: string }): React.JSX.Element {
  const { t } = useI18n();
  const detail = useQuery({ queryKey: complianceKeys.document(documentId), queryFn: () => fetchComplianceDocument(documentId) });
  if (detail.isPending) return <LoadingState label={t('compliance.loading')} />;
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  const { versions, history, file, document } = detail.data;
  const allVersions = [...versions, { id: document.id, revision: document.revision, reviewStatus: document.reviewStatus, supersededAt: document.supersededAt }].sort(
    (a, b) => a.revision - b.revision,
  );
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border-subtle p-4 text-sm">
      {file !== null && <p className="text-ink-muted">{t('compliance.doc.fileName', { name: file.fileName })}</p>}
      <div>
        <p className="font-medium text-ink">{t('compliance.doc.versions')}</p>
        <ul className="mt-1 space-y-1">
          {allVersions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center gap-2">
              <span>{t('compliance.doc.revision', { revision: String(version.revision) })}</span>
              <Badge tone={DOCUMENT_TONES[version.reviewStatus] ?? 'neutral'}>{documentStatusLabel(t, version.reviewStatus)}</Badge>
              {version.supersededAt !== null && <span className="text-xs text-ink-muted">{t('compliance.doc.replacedOn', { date: dateOnly(version.supersededAt) })}</span>}
              {version.id === document.id && <span className="text-xs text-ink-muted">{t('compliance.doc.thisVersion')}</span>}
            </li>
          ))}
        </ul>
      </div>
      {history.length > 0 && (
        <div>
          <p className="font-medium text-ink">{t('compliance.history')}</p>
          <ol className="mt-1 space-y-1">
            {history.map((event, index) => (
              <li key={`${event.at}-${String(index)}`} className="flex flex-wrap justify-between gap-2 text-xs">
                <span>
                  {event.summary}
                  {event.actorLabel !== null && <span className="text-ink-muted"> — {event.actorLabel}</span>}
                </span>
                <span className="text-ink-muted">{formatDateTime(event.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function badgeSentence(badge: ComplianceDocument['badge']): 'compliance.doc.badge.VERIFIED_WITH_ISSUER_OR_REGISTER' | 'compliance.doc.badge.EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE' | 'compliance.doc.badge.EVIDENCE_REVIEWED' {
  if (badge === 'VERIFIED_WITH_ISSUER_OR_REGISTER') return 'compliance.doc.badge.VERIFIED_WITH_ISSUER_OR_REGISTER';
  if (badge === 'EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE') return 'compliance.doc.badge.EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE';
  return 'compliance.doc.badge.EVIDENCE_REVIEWED';
}

function DocumentItem({ document, categoryNames, onReplace }: { document: ComplianceDocument; categoryNames: Map<string, string>; onReplace: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const submit = useMutation({
    mutationFn: () => submitComplianceDocument(document.id, attemptKey),
    onSuccess: async () => {
      setAttemptKey(newIdempotencyKey());
      toast.success(t('compliance.doc.sent'));
      await cache.invalidateQueries({ queryKey: complianceKeys.overview });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });
  const scopeNames = document.categoryScopeIds.map((id) => categoryNames.get(id) ?? id);

  return (
    <li className="px-5 py-4 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
            {document.standard}
            <Badge tone={DOCUMENT_TONES[document.reviewStatus] ?? 'neutral'}>{documentStatusLabel(t, document.reviewStatus)}</Badge>
            <span className="text-xs font-normal text-ink-muted">{t('compliance.doc.revision', { revision: String(document.revision) })}</span>
          </p>
          <p className="text-ink-muted">
            {documentTypeLabel(t, document.documentType)} · {t('compliance.doc.issuedBy', { issuer: document.issuer })}
            {document.certificateNumber !== null && ` · ${document.certificateNumber}`}
          </p>
          <p className="text-ink-muted">
            {document.expiresOn !== null
              ? t('compliance.doc.validUntil', { date: dateOnly(document.expiresOn) })
              : t('compliance.doc.noExpiry', { reason: document.noExpiryReason ?? '—' })}
          </p>
          {scopeNames.length > 0 && <p className="text-ink-muted">{t('compliance.doc.coversCategories', { categories: scopeNames.join(', ') })}</p>}
          {document.requirementCodes.length > 0 && <p className="text-ink-muted">{t('compliance.doc.coversRequirements', { codes: document.requirementCodes.join(', ') })}</p>}
          {document.reviewStatus === 'APPROVED' && <p className="text-ink">{t(badgeSentence(document.badge))}</p>}
          {document.suspendedReason !== null && document.suspendedReason.trim() !== '' && (
            <p className="text-danger">{t('compliance.doc.suspendedReason', { reason: document.suspendedReason })}</p>
          )}
          {document.reviewMessage !== null && document.reviewMessage.trim() !== '' && (
            <p className="rounded-md bg-surface-sunken px-3 py-2">
              <span className="font-medium">{t('compliance.reviewerMessage')}</span> {document.reviewMessage}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canSubmitDocument(document.reviewStatus) && (
            <Button
              size="sm"
              variant="primary"
              disabled={submit.isPending}
              onClick={() => {
                submit.mutate();
              }}
            >
              {t('compliance.doc.submitExisting')}
            </Button>
          )}
          {document.supersededAt === null && (
            <Button size="sm" variant="secondary" onClick={onReplace}>
              {t('compliance.doc.replace')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? t('compliance.hideDetails') : t('compliance.doc.versionsButton')}
          </Button>
        </div>
      </div>
      {open && <DocumentHistory documentId={document.id} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Panel = { kind: 'request'; categoryId: string } | { kind: 'document'; replacing: ComplianceDocument | null } | null;

export function SellerCompliancePage(): React.JSX.Element {
  const { t } = useI18n();
  const overview = useQuery({ queryKey: complianceKeys.overview, queryFn: fetchComplianceOverview });
  const factoriesQuery = useQuery({ queryKey: FACTORIES_KEY, queryFn: fetchFactories });
  const [panel, setPanel] = useState<Panel>(null);
  const [formVersion, setFormVersion] = useState(0);
  const open = (next: Panel): void => {
    setFormVersion((value) => value + 1);
    setPanel(next);
  };
  const close = (): void => {
    setPanel(null);
  };

  const factories = factoriesQuery.data?.factories ?? [];

  if (overview.isPending) return <LoadingState label={t('compliance.loading')} />;
  if (overview.isError) {
    return (
      <ErrorState
        error={overview.error}
        onRetry={() => {
          void overview.refetch();
        }}
      />
    );
  }

  const { categories, cases, documents, approvedRuleCount } = overview.data;
  const mode = categories[0]?.mode;
  const categoryNames = new Map(categories.map((category) => [category.categoryId, category.name]));
  const qualifiedIn = new Set(cases.filter((item) => item.level === 'SELLER_CATEGORY' && QUALIFIED.has(item.status)).map((item) => item.categoryId));
  const currentDocuments = documents.filter((document) => document.supersededAt === null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('compliance.title')}
        description={t('compliance.intro')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={categories.length === 0}
              onClick={() => {
                open({ kind: 'request', categoryId: '' });
              }}
            >
              {t('compliance.request.open')}
            </Button>
            <Button
              variant="secondary"
              disabled={categories.length === 0}
              onClick={() => {
                open({ kind: 'document', replacing: null });
              }}
            >
              {t('compliance.doc.add')}
            </Button>
          </div>
        }
      />

      <Card title={t('compliance.honesty.title')} bodyClassName="px-5 py-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>{t('compliance.honesty.reviewer')}</li>
          <li>{t('compliance.honesty.reviewed')}</li>
          <li>{t('compliance.honesty.narrow')}</li>
          <li>{t('compliance.honesty.inspections')}</li>
        </ul>
      </Card>

      {panel?.kind === 'request' && (
        <Card
          title={t('compliance.request.title')}
          description={t('compliance.request.intro')}
          bodyClassName="px-5 py-4"
          actions={
            <Button size="sm" variant="ghost" onClick={close}>
              {t('compliance.cancel')}
            </Button>
          }
        >
          <CaseRequestForm key={formVersion} categories={categories} factories={factories} initialCategoryId={panel.categoryId} onDone={close} />
        </Card>
      )}
      {panel?.kind === 'document' && (
        <Card
          title={panel.replacing === null ? t('compliance.doc.addTitle') : t('compliance.doc.replaceTitle', { standard: panel.replacing.standard })}
          description={t('compliance.doc.intro')}
          bodyClassName="px-5 py-4"
          actions={
            <Button size="sm" variant="ghost" onClick={close}>
              {t('compliance.cancel')}
            </Button>
          }
        >
          <ComplianceDocumentForm key={formVersion} categories={categories} factories={factories} replacing={panel.replacing} onDone={close} />
        </Card>
      )}

      <Card title={t('compliance.categories.title')} description={t(modeSentence(mode))}>
        {approvedRuleCount === 0 && <p className="px-5 pt-3 text-sm text-ink-muted">{t('compliance.categories.noRulesAnywhere')}</p>}
        {categories.length === 0 ? (
          <EmptyState title={t('compliance.categories.emptyTitle')} description={t('compliance.categories.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {categories.map((category) => (
              <CategoryRow
                key={category.categoryId}
                category={category}
                qualified={qualifiedIn.has(category.categoryId)}
                onRequest={() => {
                  open({ kind: 'request', categoryId: category.categoryId });
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('compliance.cases.title')}>
        {cases.length === 0 ? (
          <EmptyState title={t('compliance.cases.emptyTitle')} description={t('compliance.cases.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {cases.map((item) => (
              <CaseItem key={item.id} item={item} categoryName={item.categoryName ?? categoryNames.get(item.categoryId) ?? item.categoryId} factories={factories} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('compliance.documents.title')} description={t('compliance.documents.intro')}>
        {currentDocuments.length === 0 ? (
          <EmptyState title={t('compliance.documents.emptyTitle')} description={t('compliance.documents.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {currentDocuments.map((document) => (
              <DocumentItem
                key={document.id}
                document={document}
                categoryNames={categoryNames}
                onReplace={() => {
                  open({ kind: 'document', replacing: document });
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
