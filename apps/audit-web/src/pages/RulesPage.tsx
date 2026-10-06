/**
 * Compliance rules: what each category requires, and how much of the
 * catalogue the approved rules actually cover.
 *
 * Two tabs. "Coverage by category" is every live category with the rules that
 * reach it - approved, waiting, unresolved, conditional - and a plain NEEDS
 * REVIEW where nothing approved reaches it, because a seller in such a
 * category cannot be qualified. "Rules" is the matrix itself.
 *
 * The banner at the top is the one thing nobody may miss: a draft decides
 * nothing, and a rule is used only after a second person - a supervisor who
 * did not draft it - approves it.
 *
 *   GET  /audit/rules, /audit/rules/coverage, /audit/rules/:id
 *   POST /audit/rules, /audit/rules/import-research, /audit/rules/:id/{submit,approve,reject,revise,retire}
 *   PUT  /audit/rules/:id
 *
 * `?rule=<id>` opens that rule (notifications link here); `?status=` opens the
 * Rules tab with that status chosen (the dashboard links here).
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, Input, PageHeader, Select, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { CardField, EnumBadge, MutationError, QueryBoundary, ResponsiveTable, Tabs } from '@/components/console';
import { ConfirmDialog } from '@/components/Modal';
import type { Column } from '@/components/DataTable';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchCoverage, fetchRules, importResearchRules } from '@/lib/console-api';
import { RULE_STATUSES, type CoverageRow, type RuleView } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { useDebounced } from '@/lib/use-debounced';
import { RuleDetail } from './standards/RuleDetail';
import { RuleForm } from './standards/RuleForm';
import { categoryNames } from './standards/standards-helpers';

type TabKey = 'coverage' | 'rules';

export function RulesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const initialStatus = params.get('status') ?? '';
  const [tab, setTab] = useState<TabKey>(initialStatus !== '' ? 'rules' : 'coverage');
  const [creating, setCreating] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const openRuleId = params.get('rule');

  const coverage = useQuery({ queryKey: consoleKeys.coverage(), queryFn: fetchCoverage });
  const categories = coverage.data?.categories ?? [];

  const importDrafts = useConsoleMutation({
    mutationFn: (_variables, key) => importResearchRules(key),
    invalidate: [consoleKeys.rulesAll(), consoleKeys.coverage()],
    onSuccess: () => {
      setConfirmImport(false);
    },
  });

  const openRule = (id: string): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('rule', id);
        return next;
      },
      { replace: false },
    );
  };
  const closeRule = (): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('rule');
      return next;
    });
  };

  const mayDraft = can(Permission.RULE_DRAFT);

  return (
    <>
      <PageHeader
        title={t('screens.rules.title')}
        description={t('screens.rules.description')}
        actions={
          mayDraft ? (
            <>
              <Button
                onClick={() => {
                  setConfirmImport(true);
                }}
              >
                {t('rules.import.button')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setCreating(true);
                }}
              >
                {t('rules.newRule')}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="space-y-6">
        <Callout tone="warning" title={t('rules.banner.title')}>
          <p>{t('rules.banner.drafts')}</p>
          <p className="mt-1">{t('rules.banner.makerChecker')}</p>
        </Callout>

        {importDrafts.isSuccess && (
          <Callout tone="success" role="status" title={t('rules.import.doneTitle')}>
            <p>{t('rules.import.doneBody', { created: formatNumber(importDrafts.data.created), skipped: formatNumber(importDrafts.data.skipped.length) })}</p>
            {importDrafts.data.skipped.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs">
                {importDrafts.data.skipped.map((entry) => (
                  <li key={entry.code}>
                    <span className="font-mono">{entry.code}</span>: {entry.reason}
                  </li>
                ))}
              </ul>
            )}
          </Callout>
        )}
        {importDrafts.isError && <MutationError error={importDrafts.error} />}

        <Card bodyClassName="px-5 py-4">
          <Tabs<TabKey>
            label={t('rules.tabs.label')}
            selected={tab}
            onSelect={setTab}
            tabs={[
              { key: 'coverage', label: t('rules.tabs.coverage') },
              { key: 'rules', label: t('rules.tabs.rules') },
            ]}
          >
            {tab === 'coverage' ? (
              <QueryBoundary query={coverage}>{(data) => <CoverageTable rows={data.categories} />}</QueryBoundary>
            ) : (
              <RulesList categories={categories} initialStatus={initialStatus} onOpen={openRule} />
            )}
          </Tabs>
        </Card>
      </div>

      {openRuleId !== null && openRuleId !== '' && (
        <RuleDetail ruleId={openRuleId} categories={categories} onClose={closeRule} onOpenRule={openRule} />
      )}
      {creating && (
        <RuleForm
          isOpen
          categories={categories}
          onClose={() => {
            setCreating(false);
          }}
          onSaved={(id) => {
            if (id !== '') openRule(id);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={confirmImport}
        onClose={() => {
          setConfirmImport(false);
        }}
        onConfirm={() => {
          importDrafts.mutate();
        }}
        isWorking={importDrafts.isPending}
        title={t('rules.import.title')}
        confirmLabel={t('rules.import.confirm')}
        body={
          <div className="space-y-2">
            <p>{t('rules.import.body')}</p>
            <p>{t('rules.import.bodyDrafts')}</p>
          </div>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function CoverageTable({ rows }: { rows: CoverageRow[] }): React.JSX.Element {
  const { t } = useI18n();
  const [onlyGaps, setOnlyGaps] = useState(false);
  const shown = onlyGaps ? rows.filter((row) => row.needsReview) : rows;
  const gaps = rows.filter((row) => row.needsReview).length;

  const needsReview = (row: CoverageRow): React.JSX.Element =>
    row.needsReview ? (
      <Badge tone="danger" dot>
        {t('rules.coverage.needsReview')}
      </Badge>
    ) : (
      <Badge tone="success" dot>
        {t('rules.coverage.covered')}
      </Badge>
    );

  const columns: Column<CoverageRow>[] = [
    {
      key: 'name',
      header: t('rules.coverage.category'),
      render: (row) => (
        <span className="flex items-center" style={{ paddingLeft: `${String(Math.max(0, row.depth) * 1.25)}rem` }}>
          {row.depth > 0 && (
            <span aria-hidden="true" className="mr-1.5 text-ink-subtle">
              └
            </span>
          )}
          <span className={row.depth === 0 ? 'font-semibold text-ink' : 'text-ink'}>{row.name}</span>
        </span>
      ),
    },
    { key: 'products', header: t('rules.coverage.products'), align: 'right', render: (row) => formatNumber(row.products), secondary: true },
    { key: 'approved', header: t('rules.coverage.approved'), align: 'right', render: (row) => formatNumber(row.approved) },
    { key: 'mandatory', header: t('rules.coverage.approvedMandatory'), align: 'right', render: (row) => formatNumber(row.approvedMandatory), secondary: true },
    { key: 'awaiting', header: t('rules.coverage.awaiting'), align: 'right', render: (row) => formatNumber(row.awaitingApproval) },
    { key: 'unresolved', header: t('rules.coverage.unresolved'), align: 'right', render: (row) => formatNumber(row.unresolved), secondary: true },
    { key: 'conditional', header: t('rules.coverage.conditional'), align: 'right', render: (row) => formatNumber(row.conditional), secondary: true },
    { key: 'state', header: t('rules.coverage.state'), render: needsReview, nowrap: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-ink-muted">{t('rules.coverage.explain')}</p>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={onlyGaps}
            onChange={(event) => {
              setOnlyGaps(event.target.checked);
            }}
          />
          {t('rules.coverage.onlyGaps', { gaps: formatNumber(gaps) })}
        </label>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <ResponsiveTable
          caption={t('rules.tabs.coverage')}
          columns={columns}
          rows={shown}
          rowKey={(row) => row.categoryId}
          minWidth="52rem"
          emptyTitle={t('rules.coverage.empty')}
          rowClassName={(row) => (row.needsReview ? 'bg-danger-soft/40' : undefined)}
          card={(row) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink" style={{ paddingLeft: `${String(Math.min(3, row.depth) * 0.75)}rem` }}>
                  {row.name}
                </p>
                {needsReview(row)}
              </div>
              <CardField label={t('rules.coverage.approved')}>{formatNumber(row.approved)}</CardField>
              <CardField label={t('rules.coverage.awaiting')}>{formatNumber(row.awaitingApproval)}</CardField>
              <CardField label={t('rules.coverage.unresolved')}>{formatNumber(row.unresolved)}</CardField>
              <CardField label={t('rules.coverage.conditional')}>{formatNumber(row.conditional)}</CardField>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

function RulesList({
  categories,
  initialStatus,
  onOpen,
}: {
  categories: CoverageRow[];
  initialStatus: string;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState(RULE_STATUSES.includes(initialStatus as never) ? initialStatus : '');
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const filters = { status, categoryId, search: debounced };
  const names = useMemo(() => categoryNames(categories), [categories]);

  const query = useQuery({
    queryKey: consoleKeys.rules(filters),
    queryFn: () =>
      fetchRules({
        ...(status === '' ? {} : { status }),
        ...(categoryId === '' ? {} : { categoryId }),
        ...(debounced === '' ? {} : { search: debounced }),
      }),
    placeholderData: (previous) => previous,
  });

  const source = (rule: RuleView): React.JSX.Element => (
    <a
      href={rule.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline-offset-2 hover:underline"
      title={rule.sourceTitle}
    >
      {rule.sourcePublisher}
      <span className="sr-only">
        {' '}
        — {rule.sourceTitle} {t('rules.opensInNewTab')}
      </span>
    </a>
  );

  const codeButton = (rule: RuleView): React.JSX.Element => (
    <button
      type="button"
      className="text-left font-mono text-sm font-medium text-accent underline-offset-2 hover:underline"
      onClick={() => {
        onOpen(rule.id);
      }}
    >
      {rule.code}
    </button>
  );

  const columns: Column<RuleView>[] = [
    {
      key: 'code',
      header: t('rules.field.code'),
      render: (rule) => (
        <div className="min-w-0">
          {codeButton(rule)}
          <p className="mt-0.5 max-w-xs truncate text-xs text-ink-muted">{rule.name}</p>
        </div>
      ),
    },
    { key: 'version', header: t('rules.field.version'), align: 'right', render: (rule) => `v${String(rule.ruleVersion)}`, nowrap: true },
    { key: 'status', header: t('common.status'), render: (rule) => <EnumBadge family="ruleStatus" value={rule.status} />, nowrap: true },
    { key: 'obligation', header: t('rules.field.obligation'), render: (rule) => enumLabel(t, 'obligation', rule.obligation), secondary: true },
    { key: 'applicability', header: t('rules.field.applicability'), render: (rule) => <EnumBadge family="applicability" value={rule.applicability} dot={false} />, nowrap: true },
    { key: 'confidence', header: t('rules.field.confidence'), render: (rule) => enumLabel(t, 'confidence', rule.confidence), secondary: true },
    { key: 'source', header: t('rules.field.source'), render: source, secondary: true },
    { key: 'reviewed', header: t('rules.field.lastReviewedOn'), render: (rule) => formatCalendarDate(rule.lastReviewedOn), nowrap: true, tertiary: true },
  ];

  const filtered = status !== '' || categoryId !== '' || search !== '';

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Toolbar>
        <ToolbarField label={t('common.search')} grow>
          <Input
            type="search"
            value={search}
            placeholder={t('rules.list.searchPlaceholder')}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('common.status')}>
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          >
            <option value="">{t('rules.list.allInForceOrDraft')}</option>
            {RULE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {enumLabel(t, 'ruleStatus', value)}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('rules.list.category')}>
          <Select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          >
            <option value="">{t('common.all')}</option>
            {categories.map((category) => (
              <option key={category.categoryId} value={category.categoryId}>
                {`${'  '.repeat(Math.max(0, category.depth))}${category.name}`}
              </option>
            ))}
          </Select>
        </ToolbarField>
        {filtered && (
          <ToolbarActions>
            <Button
              variant="ghost"
              onClick={() => {
                setStatus('');
                setCategoryId('');
                setSearch('');
              }}
            >
              {t('common.clearFilters')}
            </Button>
          </ToolbarActions>
        )}
      </Toolbar>
      <QueryBoundary query={query}>
        {(data) => (
          <ResponsiveTable
            caption={t('rules.tabs.rules')}
            columns={columns}
            rows={data.rules}
            rowKey={(rule) => rule.id}
            minWidth="56rem"
            isRefreshing={query.isFetching}
            emptyTitle={filtered ? t('rules.list.emptyFiltered') : t('rules.list.empty')}
            emptyDescription={filtered ? t('rules.list.emptyFilteredBody') : t('rules.list.emptyBody')}
            card={(rule) => (
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {codeButton(rule)}
                    <p className="text-xs text-ink-muted">{rule.name}</p>
                  </div>
                  <EnumBadge family="ruleStatus" value={rule.status} />
                </div>
                <CardField label={t('rules.field.version')}>v{rule.ruleVersion}</CardField>
                <CardField label={t('rules.field.obligation')}>{enumLabel(t, 'obligation', rule.obligation)}</CardField>
                <CardField label={t('rules.field.applicability')}>{enumLabel(t, 'applicability', rule.applicability)}</CardField>
                <CardField label={t('rules.field.categories')}>
                  {rule.categoryIds.map((id) => names.get(id) ?? id).join(', ')}
                </CardField>
                <CardField label={t('rules.field.source')}>{source(rule)}</CardField>
              </div>
            )}
          />
        )}
      </QueryBoundary>
    </div>
  );
}
