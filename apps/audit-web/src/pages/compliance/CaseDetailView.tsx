/**
 * One qualification or product case: what it covers, the live evaluation
 * requirement by requirement, the decisions a reviewer can take, and what has
 * happened so far.
 *
 * The evaluation is the server's, computed against the rules in force at the
 * moment of reading. Nothing here decides whether a line is satisfied; it
 * shows the state the server gives and, for a line whose applicability is
 * conditional or unresolved, offers the form that records a decision.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EnumBadge, HistoryList, MutationError, QueryBoundary } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { DataTable } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { Badge, Button, Callout, Card, DescriptionList, Field, PageHeader, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { ApiError } from '@/lib/api';
import { consoleKeys, decideCase, fetchCase, recordDetermination, type CaseActionName } from '@/lib/console-api';
import type { CaseDetail, Determination, RequirementOutcome } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import type { TranslationKey } from '@/i18n/i18n-context';
import { caseActionNeedsMessage, caseActionsFor, mayDetermine } from './compliance-rules';

const ACTION_LABEL: Record<CaseActionName, TranslationKey> = {
  start: 'case.action.start',
  'request-changes': 'case.action.requestChanges',
  approve: 'case.action.approve',
  reject: 'case.action.reject',
  suspend: 'case.action.suspend',
};

const ACTION_EXPLAIN: Record<CaseActionName, TranslationKey> = {
  start: 'case.actionExplain.start',
  'request-changes': 'case.actionExplain.requestChanges',
  approve: 'case.actionExplain.approve',
  reject: 'case.actionExplain.reject',
  suspend: 'case.actionExplain.suspend',
};

export function CaseDetailView({
  caseId,
  back,
}: {
  caseId: string;
  back: { to: string; label: string };
}): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: consoleKeys.case(caseId), queryFn: () => fetchCase(caseId) });

  return (
    <>
      {query.isPending || query.isError ? <PageHeader back={back} title={t('screens.caseDetail.title')} /> : null}
      <QueryBoundary query={query}>{(detail) => <CaseScreen detail={detail} back={back} />}</QueryBoundary>
    </>
  );
}

function CaseScreen({ detail, back }: { detail: CaseDetail; back: { to: string; label: string } }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canReview = can(Permission.CASE_REVIEW);
  const record = detail.case;
  const [action, setAction] = useState<CaseActionName | null>(null);
  const [determining, setDetermining] = useState<RequirementOutcome | null>(null);

  const actions = canReview ? caseActionsFor(record.status) : [];

  return (
    <>
      <PageHeader
        back={back}
        title={t('case.title', { number: record.caseNumber })}
        description={
          record.level === 'PRODUCT'
            ? t('case.productDescription', { seller: detail.seller.name, product: detail.product?.name ?? '—' })
            : t('case.categoryDescription', { seller: detail.seller.name, category: detail.categoryName })
        }
        meta={
          <>
            <EnumBadge family="caseStatus" value={record.status} />
            <EnumBadge family="caseLevel" value={record.level} dot={false} />
          </>
        }
        actions={
          actions.length === 0 ? undefined : (
            <>
              {actions.map((name) => (
                <Button
                  key={name}
                  size="md"
                  variant={name === 'approve' ? 'primary' : name === 'reject' || name === 'suspend' ? 'danger' : 'secondary'}
                  onClick={() => {
                    setAction(name);
                  }}
                >
                  {t(ACTION_LABEL[name])}
                </Button>
              ))}
            </>
          )
        }
      />

      <div className="space-y-6">
        <Card title={t('case.summary')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                label: t('case.seller'),
                value: (
                  <Link className="font-medium text-accent hover:underline" to={`/sellers/${detail.seller.id}`}>
                    {detail.seller.name}
                  </Link>
                ),
              },
              { label: t('case.category'), value: detail.categoryName },
              ...(detail.product === null ? [] : [{ label: t('case.product'), value: detail.product.name }]),
              { label: t('case.supplyRole'), value: enumLabel(t, 'supplyRole', record.supplyRole) },
              {
                label: t('case.destinationMarket'),
                value: record.destinationMarket === '' ? t('case.anyMarket') : record.destinationMarket,
              },
              { label: t('case.reviewer'), value: record.reviewerLabel ?? t('case.noReviewer') },
              { label: t('case.decidedAt'), value: formatDateTime(record.decidedAt) },
              { label: t('case.expiresAt'), value: formatDateTime(record.expiresAt) },
            ]}
          />

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <MessageBox kind="seller" text={record.sellerMessage} />
            <MessageBox kind="internal" text={record.internalNote ?? null} />
          </div>
        </Card>

        <EvaluationCard
          detail={detail}
          canDetermine={canReview && mayDetermine(record.status)}
          onDetermine={setDetermining}
        />

        <Card title={t('common.history')} bodyClassName="px-5 py-4">
          <HistoryList entries={detail.history} />
        </Card>
      </div>

      {action !== null && (
        <DecisionDialog
          detail={detail}
          action={action}
          onClose={() => {
            setAction(null);
          }}
        />
      )}
      {determining !== null && (
        <DeterminationDialog
          caseId={record.id}
          outcome={determining}
          existing={record.determinations?.[determining.code] ?? null}
          onClose={() => {
            setDetermining(null);
          }}
        />
      )}
    </>
  );
}

/** The seller's words and the team's own note, never styled alike. */
function MessageBox({ kind, text }: { kind: 'seller' | 'internal'; text: string | null }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className={
        kind === 'seller'
          ? 'rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5'
          : 'rounded-md border border-dashed border-border-strong bg-surface-sunken px-3 py-2.5'
      }
    >
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
        {kind === 'seller' ? t('case.sellerMessage') : t('case.internalNote')}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">
        {kind === 'seller' ? t('case.sellerMessageHint') : t('case.internalNoteHint')}
      </p>
      <p className="mt-1.5 whitespace-pre-line text-sm text-ink">{text ?? t('common.none')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live evaluation
// ---------------------------------------------------------------------------

export function EvaluationCard({
  detail,
  canDetermine,
  onDetermine,
}: {
  detail: CaseDetail;
  canDetermine: boolean;
  onDetermine: (outcome: RequirementOutcome) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { evaluation } = detail;
  const determinations = detail.case.determinations ?? {};

  const columns: Column<RequirementOutcome>[] = [
    {
      key: 'requirement',
      header: t('case.eval.requirement'),
      render: (row) => (
        <div className="min-w-0">
          <p className="font-mono text-xs font-semibold text-ink">
            {row.code} <span className="font-sans font-normal text-ink-subtle">{t('case.eval.version', { version: row.ruleVersion })}</span>
          </p>
          <p className="text-sm text-ink">{row.name}</p>
        </div>
      ),
    },
    {
      key: 'state',
      header: t('case.eval.state'),
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <EnumBadge family="requirementState" value={row.state} />
          {row.blocking && <span className="text-xxs font-semibold text-danger">{t('case.eval.blocking')}</span>}
        </div>
      ),
    },
    {
      key: 'obligation',
      header: t('case.eval.obligation'),
      render: (row) => <EnumBadge family="obligation" value={row.obligation} dot={false} />,
    },
    {
      key: 'applicability',
      header: t('case.eval.applicability'),
      render: (row) => {
        const determination: Determination | undefined = determinations[row.code];
        return (
          <div className="space-y-1">
            <p className="text-sm text-ink">{enumLabel(t, 'applicability', row.applicability)}</p>
            {determination !== undefined && (
              <p className="text-xs text-ink-muted">
                {enumLabel(t, 'determination', determination.decision)}: {determination.reason}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'document',
      header: t('case.eval.document'),
      render: (row) =>
        row.documentId === null ? (
          <span className="text-ink-subtle">{t('case.eval.noDocument')}</span>
        ) : (
          <Link className="text-accent hover:underline" to={`/documents?document=${row.documentId}`}>
            {t('case.eval.openDocument')}
          </Link>
        ),
    },
    {
      key: 'validUntil',
      header: t('case.eval.validUntil'),
      nowrap: true,
      render: (row) => formatCalendarDate(row.validUntil),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      align: 'right',
      render: (row) =>
        canDetermine && row.applicability !== 'APPLIES' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onDetermine(row);
            }}
            aria-label={t('case.eval.decideFor', { code: row.code })}
          >
            {t('case.eval.decide')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Card title={t('case.eval.title')} description={t('case.eval.description')}>
      <div className="space-y-3 px-5 pt-4">
        {evaluation.noApprovedRules ? (
          <Callout tone="warning" title={t('case.eval.noRulesTitle')}>
            {t('case.eval.noRulesBody')}
          </Callout>
        ) : evaluation.ready ? (
          <Callout tone="success" title={t('case.eval.readyTitle')}>
            {evaluation.expiresAt === null
              ? t('case.eval.readyBody')
              : t('case.eval.readyBodyUntil', { date: formatCalendarDate(evaluation.expiresAt) })}
          </Callout>
        ) : (
          <Callout tone="warning" title={t('case.eval.notReadyTitle')}>
            {t('case.eval.notReadyBody', {
              lines: String(evaluation.outcomes.filter((outcome) => outcome.blocking).length),
            })}
          </Callout>
        )}
      </div>
      <div className="pt-4">
        <DataTable
          caption={t('case.eval.title')}
          columns={columns}
          rows={evaluation.outcomes}
          rowKey={(row) => `${row.code}-${String(row.ruleVersion)}`}
          minWidth="56rem"
          emptyTitle={t('case.eval.empty')}
          rowClassName={(row) => (row.blocking ? 'bg-danger-soft/40' : undefined)}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function DecisionDialog({
  detail,
  action,
  onClose,
}: {
  detail: CaseDetail;
  action: CaseActionName;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const record = detail.case;
  const needsMessage = caseActionNeedsMessage(action);
  const [sellerMessage, setSellerMessage] = useState('');
  const [internalNote, setInternalNote] = useState(record.internalNote ?? '');
  const [touched, setTouched] = useState(false);

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) =>
      decideCase(
        record.id,
        action,
        {
          expectedLockVersion: record.lockVersion,
          ...(action === 'start' || sellerMessage.trim() === '' ? {} : { sellerMessage: sellerMessage.trim() }),
          internalNote: internalNote.trim() === '' ? null : internalNote.trim(),
        },
        key,
      ),
    invalidate: [consoleKeys.case(record.id), consoleKeys.casesAll(), consoleKeys.seller(detail.seller.id), consoleKeys.sellersAll()],
    successMessage: t('case.decided'),
    onSuccess: onClose,
  });

  const messageError =
    needsMessage && touched && sellerMessage.trim().length < 10 ? t('case.messageTooShort') : undefined;

  const describe = (detailRow: ApiError['details'][number]): string => {
    if (detailRow.code === 'NO_APPROVED_RULES') return t('case.refusal.noApprovedRules');
    if (detailRow.code === 'NOT_UNDER_REVIEW') return t('case.refusal.notUnderReview');
    const requirement = detailRow.meta?.['requirement'];
    if (typeof requirement === 'string' && detailRow.code !== undefined) {
      return t('case.refusal.line', { code: requirement, state: enumLabel(t, 'requirementState', detailRow.code) });
    }
    return detailRow.message ?? detailRow.code ?? '';
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t(ACTION_LABEL[action])}
      description={t(ACTION_EXPLAIN[action])}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant={action === 'reject' || action === 'suspend' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            onClick={() => {
              setTouched(true);
              if (needsMessage && sellerMessage.trim().length < 10) return;
              mutation.mutate(undefined);
            }}
          >
            {t(ACTION_LABEL[action])}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {action !== 'start' && (
          <div className="rounded-md border border-accent/30 bg-accent-soft p-3">
            <Field
              label={t('case.sellerMessage')}
              hint={t('case.sellerMessageHint')}
              required={needsMessage}
              error={messageError}
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={messageError !== undefined}
                  value={sellerMessage}
                  maxLength={4000}
                  onChange={(event) => {
                    setSellerMessage(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        )}
        <div className="rounded-md border border-dashed border-border-strong bg-surface-sunken p-3">
          <Field label={t('case.internalNote')} hint={t('case.internalNoteHint')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                value={internalNote}
                maxLength={4000}
                onChange={(event) => {
                  setInternalNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        {mutation.isError && (
          <MutationError
            error={mutation.error}
            describeDetail={describe}
            {...(action === 'approve' ? { title: t('case.refusal.title') } : {})}
          />
        )}
      </div>
    </Modal>
  );
}

const DECISIONS = ['APPLIES', 'NOT_APPLICABLE', 'UNRESOLVED'] as const;

function DeterminationDialog({
  caseId,
  outcome,
  existing,
  onClose,
}: {
  caseId: string;
  outcome: RequirementOutcome;
  existing: Determination | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [decision, setDecision] = useState<(typeof DECISIONS)[number]>(existing?.decision ?? 'APPLIES');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [touched, setTouched] = useState(false);

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) => recordDetermination(caseId, { code: outcome.code, decision, reason: reason.trim() }, key),
    invalidate: [consoleKeys.case(caseId)],
    successMessage: t('case.determination.saved'),
    onSuccess: onClose,
  });

  const reasonError = touched && reason.trim().length < 10 ? t('common.reasonHint') : undefined;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('case.determination.title', { code: outcome.code })}
      description={t('case.determination.description')}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            onClick={() => {
              setTouched(true);
              if (reason.trim().length < 10) return;
              mutation.mutate(undefined);
            }}
          >
            {t('case.determination.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink">
          <span className="font-mono font-semibold">{outcome.code}</span> · {outcome.name}
        </p>
        <p className="text-xs text-ink-muted">
          {t('case.eval.applicability')}: {enumLabel(t, 'applicability', outcome.applicability)}
        </p>
        <Field label={t('case.determination.decision')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={decision}
              onChange={(event) => {
                setDecision(event.target.value as (typeof DECISIONS)[number]);
              }}
            >
              {DECISIONS.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'determination', value)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('case.determination.reason')} hint={t('common.reasonHint')} required error={reasonError}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={reasonError !== undefined}
              value={reason}
              maxLength={2000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
        <Badge tone="neutral">{t('case.determination.internalOnly')}</Badge>
        {mutation.isError && <MutationError error={mutation.error} />}
      </div>
    </Modal>
  );
}
