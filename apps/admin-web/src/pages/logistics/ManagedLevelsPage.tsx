/**
 * Every seller's four-level logistics policy, one row each.
 *
 * Who controls L1-L4, and whether each level UBOSS controls has a published
 * price - a seller whose UBOSS level has none cannot sell to that route, so
 * "missing UBOSS price" is the filter the desk starts from.
 *
 * Also the one presentation switch the operator has over the checkout: show
 * buyers each level's price, or one delivery total. The order keeps every
 * level's amount either way.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, CheckboxField, Input, PageHeader, Toolbar, ToolbarActions, ToolbarField, ToolbarToggle } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { LEVELS, fetchManagedLevels, fetchPresentation, savePresentation, type ManagedLevelRow } from '@/lib/logistics-levels';

export function ManagedLevelsPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [ubossOnly, setUbossOnly] = useState(true);
  const [missingOnly, setMissingOnly] = useState(false);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['admin', 'managed-levels', ubossOnly, missingOnly, search],
    queryFn: () => fetchManagedLevels({ ubossOnly, missingOnly, search }),
  });

  const columns: Column<ManagedLevelRow>[] = [
    {
      key: 'seller',
      header: t('levels.column.seller'),
      render: (row) => <span className="font-medium text-ink">{row.sellerName}</span>,
    },
    {
      key: 'mode',
      header: t('levels.column.mode'),
      render: (row) => (
        <span className="text-sm text-ink">
          {row.mode === null ? '—' : t(`levels.mode.${row.mode}`)}
          {row.versionNumber !== null && <span className="ml-1 text-xxs text-ink-subtle">v{row.versionNumber}</span>}
        </span>
      ),
    },
    ...LEVELS.map(
      (level): Column<ManagedLevelRow> => ({
        key: level,
        header: level,
        align: 'center',
        render: (row) => {
          const cell = row.levels.find((candidate) => candidate.level === level);
          if (cell === undefined) return '—';
          return (
            <Badge tone={cell.hasPublishedPrice ? (cell.owner === 'UBOSS' ? 'brand' : 'success') : 'warning'}>
              {cell.owner === 'UBOSS' ? 'UBOSS' : t('levels.seller')}
              {!cell.hasPublishedPrice && ' !'}
            </Badge>
          );
        },
      }),
    ),
    {
      key: 'missing',
      header: t('levels.column.missing'),
      align: 'center',
      render: (row) =>
        row.missingUbossPrices > 0 ? (
          <Badge tone="warning">{t('levels.missingUboss', { count: row.missingUbossPrices })}</Badge>
        ) : (
          <span className="text-xs text-ink-subtle">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={t('levels.heading')} description={t('levels.intro')} />

      <PresentationCard />

      <Card>
        <Toolbar>
          <ToolbarField label={t('levels.filter.search')} className="w-64">
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
              }}
            />
          </ToolbarField>
          <ToolbarToggle label={t('levels.filter.ubossOnly')} checked={ubossOnly} onChange={setUbossOnly} />
          <ToolbarToggle label={t('levels.filter.missingOnly')} checked={missingOnly} onChange={setMissingOnly} />
          <ToolbarActions>
            <Button
              variant="secondary"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
          </ToolbarActions>
        </Toolbar>
        <DataTable
          caption={t('levels.heading')}
          columns={columns}
          rows={query.data?.sellers ?? []}
          rowKey={(row) => row.sellerAccountId}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="56rem"
          emptyTitle={t('levels.emptyTitle')}
          emptyDescription={t('levels.emptyBody')}
          onRowClick={(row) => {
            void navigate(`/logistics/managed-levels/${row.sellerAccountId}`);
          }}
        />
      </Card>
    </div>
  );
}

function PresentationCard(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const query = useQuery({ queryKey: ['admin', 'logistics', 'presentation'], queryFn: fetchPresentation });
  const save = useMutation({
    mutationFn: savePresentation,
    onSuccess: (result) => {
      client.setQueryData(['admin', 'logistics', 'presentation'], result);
      toast.success(t('levels.presentationSaved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Card title={t('levels.presentationTitle')} description={t('levels.presentationBody')}>
      <div className="px-5 pb-5">
        <CheckboxField
          label={t('levels.presentationToggle')}
          description={t('levels.presentationHint')}
          checked={query.data?.showLevelBreakdown ?? true}
          disabled={!can(Permission.SETTINGS_WRITE) || query.isPending || save.isPending}
          onChange={(event) => {
            save.mutate(event.currentTarget.checked);
          }}
        />
      </div>
    </Card>
  );
}
