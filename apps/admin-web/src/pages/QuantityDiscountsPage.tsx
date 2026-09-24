/**
 * Quantity discounts: "buy more, save more" on every product the store sells
 * itself.
 *
 * A short ladder of rules - "from 10 pieces, 3% off", "from 50, 5% off" -
 * applied to all of the store's own products in every currency. The
 * storefront shows the next rule the moment a buyer raises the quantity ("add
 * 6 more and save 30.00 per piece"), and the basket charges exactly that,
 * because both are priced by the same function on the server.
 *
 * Never on a seller's product: a seller is paid what their line sells for,
 * and sets their own quantity prices in Seller Hub. The page says so, because
 * "every product" is the first thing somebody will assume.
 *
 * The worked example beside each rule is arithmetic on a round price in the
 * base currency, rounded the way the server rounds (the discount down), so
 * the admin can see what a buyer will read before saving it.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  Field,
  Input,
  PageHeader,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatMoney, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

interface StoreDiscountRow {
  id: string;
  minQuantity: number;
  discountBasisPoints: number;
  isActive: boolean;
}

interface StoreDiscountsResponse {
  maxDiscountBasisPoints: number;
  baseCurrency: string;
  discounts: StoreDiscountRow[];
}

/** One rule as typed: text, so "2.5" is never a float on its way to basis points. */
interface Draft {
  key: string;
  minQuantity: string;
  percent: string;
  isActive: boolean;
}

const MAX_RULES = 10;

/** "2.5" -> 250. Null for anything that is not a percentage with up to two decimals. */
function percentToBasisPoints(text: string): number | null {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + fraction;
}

function basisPointsToPercent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

function toDrafts(rows: StoreDiscountRow[]): Draft[] {
  return rows.map((row) => ({
    key: row.id,
    minQuantity: String(row.minQuantity),
    percent: basisPointsToPercent(row.discountBasisPoints),
    isActive: row.isActive,
  }));
}

let nextKey = 0;
function newDraft(previous: Draft | undefined): Draft {
  nextKey += 1;
  const from = previous === undefined ? 10 : Math.max(2, Number(previous.minQuantity) * 5 || 10);
  const percent = previous === undefined ? '3' : previous.percent;
  return { key: `new-${String(nextKey)}`, minQuantity: String(from), percent, isActive: true };
}

/** What the server reports, as the sentence shown under the rule it names. */
const PROBLEM_KEYS: Record<string, TranslationKey> = {
  MIN_TOO_LOW: 'quantityDiscounts.problem.MIN_TOO_LOW',
  DISCOUNT_OUT_OF_RANGE: 'quantityDiscounts.problem.DISCOUNT_OUT_OF_RANGE',
  DUPLICATE_MINIMUM: 'quantityDiscounts.problem.DUPLICATE_MINIMUM',
  DISCOUNT_NOT_INCREASING: 'quantityDiscounts.problem.DISCOUNT_NOT_INCREASING',
  TOO_MANY: 'quantityDiscounts.problem.TOO_MANY',
};

export function QuantityDiscountsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(Permission.COUPON_WRITE);

  const query = useQuery({
    queryKey: ['quantity-discounts'],
    queryFn: () => api.get<StoreDiscountsResponse>('/admin/quantity-discounts'),
  });

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [problems, setProblems] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    if (query.data !== undefined) setDrafts(toDrafts(query.data.discounts));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (rows: { minQuantity: number; discountBasisPoints: number; isActive: boolean }[]) =>
      api.put<StoreDiscountsResponse>('/admin/quantity-discounts', { discounts: rows }),
    onSuccess: (data) => {
      queryClient.setQueryData(['quantity-discounts'], data);
      setProblems(new Map());
      toast.success(t('quantityDiscounts.saved'));
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.code === 'STORE_QUANTITY_DISCOUNTS_INVALID') {
        const found = new Map<number, string>();
        for (const detail of cause.details) {
          const index = typeof detail.meta?.index === 'number' ? detail.meta.index : -1;
          const key = PROBLEM_KEYS[detail.code ?? ''];
          if (key !== undefined && !found.has(index)) found.set(index, t(key));
        }
        setProblems(found);
        toast.error(t('quantityDiscounts.fixProblems'));
        return;
      }
      toast.error(errorMessage(t, cause, t('quantityDiscounts.saveFailed')));
    },
  });

  const update = (key: string, patch: Partial<Draft>): void => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const submit = (): void => {
    const local = new Map<number, string>();
    const rows = drafts.map((draft, index) => {
      const minQuantity = Number(draft.minQuantity);
      const basisPoints = percentToBasisPoints(draft.percent);
      if (!Number.isInteger(minQuantity) || minQuantity < 2)
        local.set(index, t('quantityDiscounts.problem.MIN_TOO_LOW'));
      else if (basisPoints === null || basisPoints < 1)
        local.set(index, t('quantityDiscounts.problem.DISCOUNT_OUT_OF_RANGE'));
      return { minQuantity, discountBasisPoints: basisPoints ?? 0, isActive: draft.isActive };
    });
    if (local.size > 0) {
      setProblems(local);
      return;
    }
    save.mutate(rows);
  };

  const currency = query.data?.baseCurrency ?? 'INR';
  // A round example price: 1,000 in the base currency's major unit.
  const exampleMinor = 1000n * 10n ** BigInt(currencyExponent(currency));
  const money = (minor: bigint) => formatMoney({ minor: minor.toString(), formatted: '', currency });

  const sorted = [...drafts]
    .map((draft) => ({ draft, basisPoints: percentToBasisPoints(draft.percent) }))
    .filter((row) => row.draft.isActive && row.basisPoints !== null && Number(row.draft.minQuantity) >= 2)
    .sort((a, b) => Number(a.draft.minQuantity) - Number(b.draft.minQuantity));
  const firstRule = sorted[0];
  const anyActive = sorted.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('quantityDiscounts.title')}
        description={t('quantityDiscounts.description')}
        meta={
          <Badge tone={anyActive ? 'success' : 'neutral'} dot>
            {anyActive ? t('quantityDiscounts.statusOn') : t('quantityDiscounts.statusOff')}
          </Badge>
        }
      />

      <Callout tone="info" title={t('quantityDiscounts.scopeTitle')}>
        {t('quantityDiscounts.scopeBody')}
      </Callout>

      {query.isError && (
        <Callout tone="danger" role="alert">
          {errorMessage(t, query.error, t('quantityDiscounts.loadFailed'))}
        </Callout>
      )}

      <Card
        title={t('quantityDiscounts.rulesTitle')}
        description={t('quantityDiscounts.rulesHint')}
        bodyClassName="px-5 py-4"
      >
        {query.isPending ? (
          <p className="text-sm text-ink-muted">{t('quantityDiscounts.loading')}</p>
        ) : (
          <div className="space-y-4">
            {drafts.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-ink-muted">
                {t('quantityDiscounts.none')}
              </p>
            )}

            <ol className="space-y-3">
              {drafts.map((draft, index) => {
                const basisPoints = percentToBasisPoints(draft.percent);
                const off =
                  basisPoints === null ? null : (exampleMinor * BigInt(basisPoints)) / 10_000n;
                const problem = problems.get(index);
                return (
                  <li
                    key={draft.key}
                    className="grid gap-3 rounded-lg border border-border bg-surface-sunken/40 p-4 sm:grid-cols-[8rem_8rem_1fr_auto] sm:items-end"
                  >
                    <Field label={t('quantityDiscounts.from')} error={problem}>
                      {({ inputId, describedBy }) => (
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          inputMode="numeric"
                          value={draft.minQuantity}
                          disabled={!canWrite}
                          invalid={problem !== undefined}
                          onChange={(event) => {
                            update(draft.key, { minQuantity: event.target.value.replace(/\D/g, '') });
                          }}
                        />
                      )}
                    </Field>
                    <Field label={t('quantityDiscounts.percentOff')}>
                      {({ inputId, describedBy }) => (
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          inputMode="decimal"
                          value={draft.percent}
                          disabled={!canWrite}
                          onChange={(event) => {
                            update(draft.key, { percent: event.target.value });
                          }}
                        />
                      )}
                    </Field>
                    <div className="space-y-2 text-sm">
                      <p className="tabular text-ink-muted">
                        {off === null || off <= 0n
                          ? t('quantityDiscounts.exampleInvalid')
                          : t('quantityDiscounts.example', {
                              list: money(exampleMinor),
                              price: money(exampleMinor - off),
                              saving: money(off),
                            })}
                      </p>
                      <CheckboxField
                        label={t('quantityDiscounts.active')}
                        checked={draft.isActive}
                        disabled={!canWrite}
                        onChange={(event) => {
                          update(draft.key, { isActive: event.target.checked });
                        }}
                      />
                    </div>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('quantityDiscounts.remove', { number: index + 1 })}
                        onClick={() => {
                          setDrafts((current) => current.filter((row) => row.key !== draft.key));
                          setProblems(new Map());
                        }}
                      >
                        {t('quantityDiscounts.removeShort')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>

            {problems.get(-1) !== undefined && (
              <p role="alert" className="text-sm font-medium text-danger">
                {problems.get(-1)}
              </p>
            )}

            {canWrite && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <Button
                  variant="secondary"
                  disabled={drafts.length >= MAX_RULES}
                  onClick={() => {
                    setDrafts((current) => [...current, newDraft(current[current.length - 1])]);
                  }}
                >
                  {t('quantityDiscounts.add')}
                </Button>
                <Button variant="primary" isLoading={save.isPending} onClick={submit}>
                  {t('quantityDiscounts.save')}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {firstRule !== undefined && (
        <Card title={t('quantityDiscounts.previewTitle')} bodyClassName="px-5 py-4">
          <p className="rounded-md bg-success-soft px-4 py-3 text-sm text-success">
            {t('quantityDiscounts.previewBody', {
              more: formatNumber(Math.max(1, Number(firstRule.draft.minQuantity) - 1)),
              saving: money(
                (exampleMinor * BigInt(firstRule.basisPoints ?? 0)) / 10_000n,
              ),
            })}
          </p>
          <p className="mt-2 text-xs text-ink-muted">{t('quantityDiscounts.previewNote')}</p>
        </Card>
      )}
    </div>
  );
}
