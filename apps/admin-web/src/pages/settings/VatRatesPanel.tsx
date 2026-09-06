/**
 * EU VAT rates, per member state and band.
 *
 * The panel exists because member states change their rates with a few
 * months' notice and no codebase can ship a live feed. What it is careful
 * about is the shape of that change: **a rate is added, never edited.**
 *
 * Germany's standard rate was 16% for six months in 2020, and an invoice
 * raised in that window is still correct at 16% forever. So each row carries
 * the date it starts, the lookup takes the latest period that has begun, and
 * correcting a rate means adding a period rather than overwriting one. The
 * only mutation offered here is closing a period — and even that only moves
 * the end date, because the percentage is stated on every invoice already
 * raised under it.
 *
 * There is deliberately no delete.
 *
 * The seeded figures are a starting point, not a feed. The panel says so at
 * the top rather than in a tooltip: an operator who assumes these track
 * reality will invoice at a stale rate, and that is their liability, not a
 * display bug.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type VatCategory = 'STANDARD' | 'REDUCED' | 'SUPER_REDUCED' | 'ZERO' | 'EXEMPT';

const CATEGORIES: VatCategory[] = ['STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT'];

interface VatRate {
  id: string;
  countryCode: string;
  category: VatCategory;
  ratePercent: string;
  label: string | null;
  validFrom: string;
  validTo: string | null;
  /** Which row a sale today would actually use. */
  inForce: boolean;
}

interface VatRatesResponse {
  rates: VatRate[];
  euCountries: { code: string; name: string }[];
  seller: { vatCountry: string | null; vatNumber: string | null; euVatActive: boolean };
}

/** A blank new-period form. */
function emptyDraft(): {
  countryCode: string;
  category: VatCategory;
  ratePercent: string;
  label: string;
  validFrom: string;
} {
  return {
    countryCode: '',
    category: 'STANDARD',
    ratePercent: '',
    label: '',
    // Today, in the format the API's `z.string().date()` expects.
    validFrom: new Date().toISOString().slice(0, 10),
  };
}

export function VatRatesPanel(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [country, setCountry] = useState('');
  const [draft, setDraft] = useState(emptyDraft);
  const [isAdding, setIsAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canWrite = can(Permission.SETTINGS_WRITE);

  const query = useQuery({
    queryKey: ['vat-rates', country],
    queryFn: () =>
      api.get<VatRatesResponse>('/admin/vat-rates', {
        query: country === '' ? {} : { countryCode: country },
      }),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['vat-rates'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post('/admin/vat-rates', {
        countryCode: draft.countryCode,
        category: draft.category,
        ratePercent: draft.ratePercent,
        label: draft.label.trim() === '' ? null : draft.label.trim(),
        validFrom: draft.validFrom,
      }),
    onSuccess: async () => {
      setFormError(null);
      setIsAdding(false);
      setDraft(emptyDraft());
      toast.success(t('vatRates.added'));
      await invalidate();
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : t('vatRates.couldNotAdd'));
    },
  });

  const close = useMutation({
    mutationFn: (input: { id: string; validTo: string | null }) =>
      api.patch(`/admin/vat-rates/${input.id}`, { validTo: input.validTo }),
    onSuccess: async () => {
      toast.success(t('vatRates.periodClosed'));
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('vatRates.couldNotClose'));
    },
  });

  const seller = query.data?.seller;

  const columns: Column<VatRate>[] = [
    {
      key: 'country',
      header: t('vatRates.country'),
      nowrap: true,
      render: (row) => <span className="font-mono text-ink">{row.countryCode}</span>,
    },
    {
      key: 'category',
      header: t('vatRates.band'),
      nowrap: true,
      render: (row) => (
        <div>
          <Badge tone={row.category === 'STANDARD' ? 'accent' : 'neutral'}>
            {t(`vatRates.category.${row.category}` as 'vatRates.category.STANDARD')}
          </Badge>
          {row.label !== null && (
            <p className="mt-1 text-xxs text-ink-subtle">{row.label}</p>
          )}
        </div>
      ),
    },
    {
      key: 'rate',
      header: t('vatRates.rate'),
      align: 'right',
      nowrap: true,
      // Trailing zeros off a Decimal column read as noise on a rate table.
      render: (row) => <span className="text-ink">{Number(row.ratePercent)}%</span>,
    },
    {
      key: 'period',
      header: t('vatRates.period'),
      nowrap: true,
      render: (row) => (
        <div>
          <p className="text-ink">
            {formatDate(row.validFrom)} —{' '}
            {row.validTo === null ? t('vatRates.open') : formatDate(row.validTo)}
          </p>
          {row.inForce && (
            <p className="mt-0.5 text-xxs font-medium text-success">{t('vatRates.inForce')}</p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: t('vatRates.action'),
      align: 'right',
      render: (row) => {
        // Already closed, or the user cannot write. Nothing to offer.
        if (!canWrite || row.validTo !== null) return <span className="text-ink-subtle">—</span>;

        return (
          <Button
            size="sm"
            isLoading={close.isPending && close.variables.id === row.id}
            onClick={() => {
              // Ends today. A rate that stops applying stops today, not
              // retroactively - anything already invoiced under it stands.
              close.mutate({ id: row.id, validTo: new Date().toISOString().slice(0, 10) });
            }}
          >
            {t('vatRates.closePeriod')}
          </Button>
        );
      },
    },
  ];

  return (
    <Card title={t('vatRates.title')} description={t('vatRates.description')}>
      <div className="space-y-4 px-5 py-4">
        {/* Loud, and at the top. An operator who assumes these track reality
            will invoice at a stale rate, and that is their liability. */}
        <Callout tone="warning" title={t('vatRates.verifyTitle')}>
          {t('vatRates.verifyBody')}
        </Callout>

        {seller !== undefined && !seller.euVatActive && (
          <Callout tone="neutral" title={t('vatRates.inactiveTitle')}>
            {t('vatRates.inactiveBody')}
          </Callout>
        )}

        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <Toolbar>
          <ToolbarField label={t('vatRates.country')}>
            <Select
              value={country}
              onChange={(event) => {
                setCountry(event.target.value);
              }}
              className="w-56"
            >
              <option value="">{t('vatRates.allCountries')}</option>
              {(query.data?.euCountries ?? []).map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} — {entry.name}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {canWrite && (
            <ToolbarActions>
              <Button
                variant="primary"
                onClick={() => {
                  setFormError(null);
                  setIsAdding((open) => !open);
                }}
              >
                {isAdding ? t('common.cancel') : t('vatRates.addPeriod')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        {isAdding && (
          <form
            className="rounded-md border border-border bg-surface-sunken p-4"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <p className="mb-3 text-xs text-ink-muted">{t('vatRates.addHint')}</p>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('vatRates.country')} required>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    required
                    value={draft.countryCode}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, countryCode: event.target.value }));
                    }}
                  >
                    <option value="">{t('vatRates.choose')}</option>
                    {(query.data?.euCountries ?? []).map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.code} — {entry.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label={t('vatRates.band')} required>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={draft.category}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        category: event.target.value as VatCategory,
                      }));
                    }}
                  >
                    {CATEGORIES.map((value) => (
                      <option key={value} value={value}>
                        {t(`vatRates.category.${value}` as 'vatRates.category.STANDARD')}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label={t('vatRates.rate')} hint={t('vatRates.rateHint')} required>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    required
                    // A string all the way to the Decimal column. A tax rate
                    // must never pass through binary floating point.
                    inputMode="decimal"
                    placeholder="19"
                    aria-describedby={describedBy}
                    value={draft.ratePercent}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, ratePercent: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('vatRates.startsOn')} hint={t('vatRates.startsOnHint')} required>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    required
                    type="date"
                    aria-describedby={describedBy}
                    value={draft.validFrom}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, validFrom: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="mt-4">
              <Field label={t('vatRates.label')} hint={t('vatRates.labelHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    maxLength={128}
                    aria-describedby={describedBy}
                    value={draft.label}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, label: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="mt-4 flex gap-2">
              <Button type="submit" variant="primary" isLoading={add.isPending}>
                {t('vatRates.addPeriod')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setFormError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>

      <DataTable
        caption={t('vatRates.title')}
        columns={columns}
        rows={query.data?.rates}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        isRefreshing={query.isFetching && !query.isPending}
        error={query.isError ? query.error : undefined}
        loadingLabel={t('vatRates.loading')}
        minWidth="48rem"
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle={t('vatRates.emptyTitle')}
        emptyDescription={t('vatRates.emptyDescription')}
      />
    </Card>
  );
}
