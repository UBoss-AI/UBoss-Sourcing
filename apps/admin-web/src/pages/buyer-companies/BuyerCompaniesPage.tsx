/**
 * Buyer companies - the verification queue.
 *
 * Oldest submission first by default, for the reason the seller queue gives:
 * a queue sorted newest-first starves whoever has waited longest. Risk,
 * duplicates and failed registry checks are on the row so a reviewer can
 * triage without opening anything.
 *
 * The filters live in the URL, so a filtered view can be bookmarked or sent
 * to a colleague, and the last one used is remembered on this device and
 * restored when the page is opened bare - "my unassigned, high risk" is a
 * view somebody opens every morning.
 */
import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Input, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { STATUSES, fetchQueue, fetchReviewers, riskTone, statusTone, type QueueRow } from '@/lib/buyer-companies';
import { formatDate } from '@/lib/format';

const PAGE_SIZE = 25;
const SAVED_FILTERS_KEY = 'uboss.admin.buyerCompanies.filters';
const FILTER_KEYS = ['status', 'country', 'search', 'assignee', 'risk', 'sort'] as const;

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(SAVED_FILTERS_KEY);
  } catch {
    return null;
  }
}

function writeSaved(value: string): void {
  try {
    window.localStorage.setItem(SAVED_FILTERS_KEY, value);
  } catch {
    // Storage off: the URL still carries the filters.
  }
}

export function BuyerCompaniesPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const timer = useRef(0);

  // Opened bare: bring back the last view used on this device. Once, on
  // arrival - a later "clear all filters" must stay cleared.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (params.toString().length > 0) return;
    const saved = readSaved();
    if (saved !== null && saved.length > 0) setParams(new URLSearchParams(saved), { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    const kept = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value !== null && value.length > 0) kept.set(key, value);
    }
    writeSaved(kept.toString());
  }, [params]);

  const page = Math.max(1, Number(params.get('page') ?? '1'));
  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';
  const assignee = params.get('assignee') ?? '';
  const risk = params.get('risk') ?? '';
  const sort = params.get('sort') ?? 'oldest';
  const country = params.get('country') ?? '';

  const query = useQuery({
    queryKey: ['admin', 'buyer-companies', params.toString()],
    queryFn: () => {
      const next = new URLSearchParams(params);
      next.set('page', String(page));
      next.set('pageSize', String(PAGE_SIZE));
      return fetchQueue(next);
    },
  });

  const reviewers = useQuery({ queryKey: ['admin', 'buyer-company-reviewers'], queryFn: fetchReviewers });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: Column<QueueRow>[] = [
    {
      key: 'company',
      header: t('buyerCompanies.col.company'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.legalName ?? row.tradingName ?? '—'}</p>
          <p className="truncate font-mono text-xxs text-ink-subtle">{row.reference}</p>
        </div>
      ),
    },
    {
      key: 'country',
      header: t('buyerCompanies.col.country'),
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {row.registrationCountry ?? '—'}
          {row.entityType !== null && ` · ${t(`buyerCompanies.entity.${row.entityType}` as TranslationKey)}`}
        </span>
      ),
    },
    {
      key: 'registration',
      header: t('buyerCompanies.col.registration'),
      tertiary: true,
      nowrap: true,
      render: (row) => <span className="font-mono text-xs text-ink-muted">{row.registrationNumber ?? '—'}</span>,
    },
    {
      key: 'applicant',
      header: t('buyerCompanies.col.applicant'),
      secondary: true,
      render: (row) => (
        <div className="min-w-0 text-xs">
          <p className="truncate text-ink">{row.applicant?.fullName ?? '—'}</p>
          <p className="truncate text-ink-subtle">{row.applicant?.email ?? ''}</p>
        </div>
      ),
    },
    {
      key: 'submitted',
      header: t('buyerCompanies.col.submitted'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <div className="text-xs">
          <p className="text-ink-muted">{row.submittedAt === null ? '—' : formatDate(row.submittedAt)}</p>
          <p className="text-ink-subtle">{t('buyerCompanies.ageDays', { count: row.ageDays })}</p>
        </div>
      ),
    },
    {
      key: 'flags',
      header: t('buyerCompanies.col.flags'),
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={riskTone(row.riskLevel)}>{t(`buyerCompanies.risk.${row.riskLevel}` as TranslationKey)}</Badge>
          {row.flags.duplicates > 0 && <Badge tone="warning">{t('buyerCompanies.flag.duplicates', { count: row.flags.duplicates })}</Badge>}
          {row.flags.failed > 0 && <Badge tone="danger">{t('buyerCompanies.flag.failed', { count: row.flags.failed })}</Badge>}
        </div>
      ),
    },
    {
      key: 'reviewer',
      header: t('buyerCompanies.col.reviewer'),
      tertiary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{row.assignedReviewer?.email ?? t('buyerCompanies.unassigned')}</span>
      ),
    },
    {
      key: 'activity',
      header: t('buyerCompanies.col.activity'),
      tertiary: true,
      nowrap: true,
      render: (row) => <span className="text-xs text-ink-subtle">{formatDate(row.lastActivityAt)}</span>,
    },
    {
      key: 'status',
      header: t('buyerCompanies.col.status'),
      align: 'center',
      render: (row) => <Badge tone={statusTone(row.status)}>{t(`buyerCompanies.status.${row.status}` as TranslationKey)}</Badge>,
    },
  ];

  const counts = query.data?.counts ?? {};
  const waiting = (counts.SUBMITTED ?? 0) + (counts.AUTOMATED_CHECK_IN_PROGRESS ?? 0) + (counts.UNDER_REVIEW ?? 0) + (counts.RESUBMITTED ?? 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('buyerCompanies.title')}
        description={waiting === 0 ? t('buyerCompanies.description') : t('buyerCompanies.waiting', { count: waiting })}
      />

      {/* The counters are buttons: pressing one filters the queue to it. */}
      <ul className="flex flex-wrap gap-2" aria-label={t('buyerCompanies.countersLabel')}>
        {(['SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'RESUBMITTED', 'REVERIFICATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const).map((key) => (
          <li key={key}>
            <button
              type="button"
              aria-pressed={status === key}
              onClick={() => {
                update('status', status === key ? '' : key);
              }}
              className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-brand aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand"
            >
              {t(`buyerCompanies.status.${key}` as TranslationKey)}
              <span className="font-semibold tabular-nums text-ink">{counts[key] ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>

      <Toolbar>
        <ToolbarField label={t('buyerCompanies.filter.search')}>
          <Input
            type="search"
            defaultValue={search}
            placeholder={t('buyerCompanies.filter.searchPlaceholder')}
            onChange={(event) => {
              const value = event.currentTarget.value;
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => {
                update('search', value.trim());
              }, 350);
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('buyerCompanies.filter.status')}>
          <Select value={status} onChange={(event) => { update('status', event.currentTarget.value); }}>
            <option value="">{t('buyerCompanies.filter.inQueue')}</option>
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>{t(`buyerCompanies.status.${entry}` as TranslationKey)}</option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('buyerCompanies.filter.country')}>
          <Input
            maxLength={2}
            defaultValue={country}
            placeholder="PL"
            onChange={(event) => {
              const value = event.currentTarget.value.trim().toUpperCase();
              if (value.length === 0 || value.length === 2) update('country', value);
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('buyerCompanies.filter.reviewer')}>
          <Select value={assignee} onChange={(event) => { update('assignee', event.currentTarget.value); }}>
            <option value="">{t('buyerCompanies.filter.anyone')}</option>
            <option value="me">{t('buyerCompanies.filter.me')}</option>
            <option value="unassigned">{t('buyerCompanies.unassigned')}</option>
            {(reviewers.data?.reviewers ?? []).map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>{reviewer.email}</option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('buyerCompanies.filter.risk')}>
          <Select value={risk} onChange={(event) => { update('risk', event.currentTarget.value); }}>
            <option value="">{t('buyerCompanies.filter.anyRisk')}</option>
            {(['HIGH', 'ELEVATED', 'LOW', 'NONE'] as const).map((level) => (
              <option key={level} value={level}>{t(`buyerCompanies.risk.${level}` as TranslationKey)}</option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('buyerCompanies.filter.sort')}>
          <Select value={sort} onChange={(event) => { update('sort', event.currentTarget.value === 'oldest' ? '' : event.currentTarget.value); }}>
            <option value="oldest">{t('buyerCompanies.sort.oldest')}</option>
            <option value="newest">{t('buyerCompanies.sort.newest')}</option>
            <option value="recent_activity">{t('buyerCompanies.sort.recentActivity')}</option>
            <option value="risk">{t('buyerCompanies.sort.risk')}</option>
          </Select>
        </ToolbarField>
      </Toolbar>

      <DataTable
        caption={t('buyerCompanies.caption')}
        columns={columns}
        rows={query.data?.rows}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        isRefreshing={query.isFetching && !query.isPending}
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle={t('buyerCompanies.emptyTitle')}
        emptyDescription={t('buyerCompanies.emptyDescription')}
        onRowClick={(row) => {
          void navigate(`/buyer-companies/${row.id}`);
        }}
      />

      {query.data !== undefined && query.data.total > PAGE_SIZE && (
        <Pager
          page={page}
          limit={PAGE_SIZE}
          total={query.data.total}
          totalPages={Math.ceil(query.data.total / PAGE_SIZE)}
          onPageChange={(next: number) => {
            update('page', String(next));
          }}
        />
      )}
    </div>
  );
}
