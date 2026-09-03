/**
 * Coupons.
 *
 * A percentage off, optionally narrowed to categories, that unlocks once the
 * cart is worth enough.
 *
 * The part that surprises people is the qualifying amount: it is set **per
 * currency**, not once. "Works above 5,000" cannot mean the same thing in
 * rupees and dollars, and converting one into the other would make the rule
 * drift with the exchange rate. A currency left blank here is a market the
 * coupon simply does not apply in, and the form says so rather than filling in
 * a converted guess.
 *
 * Nothing on this screen deletes a coupon. Redemptions reference it so an
 * order stays explicable years later; archiving retires it and keeps the trail.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { DataTable, type Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
}

interface CouponMinimum {
  currencyCode: string;
  minOrderMinor: string;
}

interface Coupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  scope: 'ALL_PRODUCTS' | 'CATEGORIES';
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED';
  isPubliclyListed: boolean;
  validFrom: string | null;
  validUntil: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usageCount: number;
  categoryIds: string[];
  includeDescendants: boolean;
  minimums: CouponMinimum[];
  archivedAt: string | null;
}

interface DraftMinimum {
  /** Major units as typed, e.g. "5000.00". Empty means "not offered here". */
  amount: string;
}

interface Draft {
  code: string;
  name: string;
  description: string;
  discountPercent: string;
  scope: 'ALL_PRODUCTS' | 'CATEGORIES';
  categoryIds: string[];
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED';
  isPubliclyListed: boolean;
  validFrom: string;
  validUntil: string;
  usageLimit: string;
  perCustomerLimit: string;
  minimums: Record<string, DraftMinimum>;
}

const EMPTY_DRAFT: Draft = {
  code: '',
  name: '',
  description: '',
  discountPercent: '10',
  scope: 'ALL_PRODUCTS',
  categoryIds: [],
  status: 'DRAFT',
  isPubliclyListed: true,
  validFrom: '',
  validUntil: '',
  usageLimit: '',
  perCustomerLimit: '',
  minimums: {},
};

const STATUS_TONE: Record<Coupon['status'], 'success' | 'neutral' | 'warning'> = {
  ACTIVE: 'success',
  DRAFT: 'neutral',
  DISABLED: 'warning',
};

/** Flattens the category tree for a multi-select, keeping the depth indent. */
function flattenCategories(
  nodes: CategoryNode[],
  depth = 0,
): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${'  '.repeat(depth)}${node.name}` },
    ...flattenCategories(node.children, depth + 1),
  ]);
}

export function CouponsPage(): React.JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<Coupon | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<Coupon | null>(null);

  const canWrite = can(Permission.COUPON_WRITE);

  const coupons = useQuery({
    queryKey: ['coupons'],
    queryFn: () => api.get<{ coupons: Coupon[] }>('/admin/coupons'),
  });

  // The currency list comes from the public config: it is the same list the
  // storefront prices in, so the two cannot drift apart.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () =>
      api.get<{ localisation: { currencies: CurrencyRow[]; baseCurrency: string } }>('/config'),
    staleTime: 5 * 60_000,
  });

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
    enabled: isOpen,
  });

  const currencies = useMemo(() => config.data?.localisation.currencies ?? [], [config.data]);
  const categoryOptions = useMemo(
    () => flattenCategories(categories.data?.categories ?? []),
    [categories.data],
  );

  const exponentFor = (code: string): number =>
    currencies.find((entry) => entry.code === code)?.exponent ?? 2;

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['coupons'] });
  };

  const save = useMutation({
    mutationFn: (body: unknown) =>
      editing === null
        ? api.post<{ coupon: Coupon }>('/admin/coupons', body)
        : api.put<{ coupon: Coupon }>(`/admin/coupons/${editing.id}`, body),
    onSuccess: async ({ coupon }) => {
      toast.success(
        editing === null ? `Coupon ${coupon.code} created.` : `Coupon ${coupon.code} saved.`,
      );
      setIsOpen(false);
      await invalidate();
    },
    onError: (cause: unknown) => {
      setFormError(cause instanceof ApiError ? cause.message : 'That could not be saved.');
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.delete<null>(`/admin/coupons/${id}`),
    onSuccess: async () => {
      toast.success('Coupon archived.');
      setArchiving(null);
      await invalidate();
    },
    onError: (cause: unknown) => {
      toast.error(cause instanceof ApiError ? cause.message : 'That could not be archived.');
    },
  });

  // A suggestion, so a new coupon opens with a code already filled in.
  const suggestion = useQuery({
    queryKey: ['coupon-code-suggestion'],
    queryFn: () => api.get<{ code: string }>('/admin/coupons/suggest-code'),
    enabled: false,
  });

  useEffect(() => {
    if (isOpen && editing === null && draft.code === '' && suggestion.data !== undefined) {
      setDraft((current) => ({ ...current, code: suggestion.data.code }));
    }
  }, [draft.code, editing, isOpen, suggestion.data]);

  const openCreate = (): void => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
    setIsOpen(true);
    void suggestion.refetch();
  };

  const openEdit = (coupon: Coupon): void => {
    setEditing(coupon);
    setFormError(null);
    setDraft({
      code: coupon.code,
      name: coupon.name,
      description: coupon.description ?? '',
      discountPercent: coupon.discountPercent,
      scope: coupon.scope,
      categoryIds: coupon.categoryIds,
      status: coupon.status,
      isPubliclyListed: coupon.isPubliclyListed,
      validFrom: coupon.validFrom?.slice(0, 10) ?? '',
      validUntil: coupon.validUntil?.slice(0, 10) ?? '',
      usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
      perCustomerLimit: coupon.perCustomerLimit === null ? '' : String(coupon.perCustomerLimit),
      minimums: Object.fromEntries(
        coupon.minimums.map((row) => [
          row.currencyCode,
          { amount: minorToMajor(row.minOrderMinor, exponentFor(row.currencyCode)) },
        ]),
      ),
    });
    setIsOpen(true);
  };

  const submit = (): void => {
    setFormError(null);

    // Only currencies with a figure typed become thresholds. A blank is a
    // market the coupon is not offered in, which is a real answer.
    const minimums: { currencyCode: string; minOrderMinor: string }[] = [];

    for (const [code, entry] of Object.entries(draft.minimums)) {
      const typed = entry.amount.trim();
      if (typed === '') continue;

      const minor = majorToMinor(typed, exponentFor(code));
      if (minor === null) {
        setFormError(`The ${code} qualifying amount is not a valid number.`);
        return;
      }
      minimums.push({ currencyCode: code, minOrderMinor: minor });
    }

    if (minimums.length === 0) {
      setFormError(
        'Set a qualifying amount in at least one currency, or the coupon can never apply.',
      );
      return;
    }

    if (draft.scope === 'CATEGORIES' && draft.categoryIds.length === 0) {
      setFormError('Choose at least one category, or set the coupon to apply to all products.');
      return;
    }

    save.mutate({
      code: draft.code.trim() === '' ? null : draft.code.trim(),
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      discountPercent: draft.discountPercent.trim(),
      scope: draft.scope,
      categoryIds: draft.scope === 'CATEGORIES' ? draft.categoryIds : [],
      minimums,
      status: draft.status,
      isPubliclyListed: draft.isPubliclyListed,
      validFrom: draft.validFrom === '' ? null : new Date(draft.validFrom).toISOString(),
      validUntil: draft.validUntil === '' ? null : new Date(draft.validUntil).toISOString(),
      usageLimit: draft.usageLimit === '' ? null : Number(draft.usageLimit),
      perCustomerLimit: draft.perCustomerLimit === '' ? null : Number(draft.perCustomerLimit),
    });
  };

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Code',
      render: (row) => (
        <div>
          <p className="font-mono text-sm font-semibold text-ink">{row.code}</p>
          <p className="text-xs text-ink-muted">{row.name}</p>
        </div>
      ),
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      render: (row) => <span className="tabular">{row.discountPercent}%</span>,
    },
    {
      key: 'scope',
      header: 'Applies to',
      secondary: true,
      render: (row) =>
        row.scope === 'ALL_PRODUCTS'
          ? 'All products'
          : `${String(row.categoryIds.length)} categor${row.categoryIds.length === 1 ? 'y' : 'ies'}`,
    },
    {
      key: 'minimums',
      header: 'Qualifies above',
      secondary: true,
      render: (row) => (
        <div className="space-y-0.5">
          {row.minimums.map((entry) => (
            <p key={entry.currencyCode} className="text-xs tabular text-ink-muted">
              {entry.currencyCode}{' '}
              {minorToMajor(entry.minOrderMinor, exponentFor(entry.currencyCode))}
            </p>
          ))}
        </div>
      ),
    },
    {
      key: 'window',
      header: 'Live',
      secondary: true,
      render: (row) =>
        row.validFrom === null && row.validUntil === null ? (
          <span className="text-xs text-ink-muted">Always</span>
        ) : (
          <span className="text-xs text-ink-muted">
            {row.validFrom === null ? '—' : formatDate(row.validFrom)} to{' '}
            {row.validUntil === null ? '—' : formatDate(row.validUntil)}
          </span>
        ),
    },
    {
      key: 'used',
      header: 'Used',
      align: 'right',
      render: (row) => (
        <span className="tabular text-ink-muted">
          {row.usageCount}
          {row.usageLimit === null ? '' : ` / ${String(row.usageLimit)}`}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
          {!row.isPubliclyListed && <Badge tone="neutral">Code only</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        canWrite ? (
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                openEdit(row);
              }}
              className="text-sm font-medium text-brand hover:underline"
            >
              Edit
            </button>
            {can(Permission.COUPON_ARCHIVE) && row.archivedAt === null && (
              <button
                type="button"
                onClick={() => {
                  setArchiving(row);
                }}
                className="text-sm font-medium text-ink-muted hover:underline"
              >
                Archive
              </button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coupons"
        description="Percentage discounts, optionally limited to categories, that unlock at a cart value you set per currency."
        actions={canWrite ? <Button onClick={openCreate}>New coupon</Button> : undefined}
      />

      <Card>
        <DataTable
          caption="Coupons"
          columns={columns}
          rows={coupons.data?.coupons ?? []}
          rowKey={(row) => row.id}
          isLoading={coupons.isLoading}
          error={coupons.error}
          onRetry={() => void coupons.refetch()}
          emptyTitle="No coupons yet"
          emptyDescription="Create one to offer a discount on the storefront."
          {...(canWrite ? { emptyAction: <Button onClick={openCreate}>New coupon</Button> } : {})}
        />
      </Card>

      <Modal
        isOpen={isOpen}
        onClose={() => {
          setIsOpen(false);
        }}
        size="lg"
        title={editing === null ? 'New coupon' : `Edit ${editing.code}`}
        description="The code is what a customer types. Everything else decides when it applies."
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setIsOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save coupon'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" required hint="Generated for you. Change it if you would rather.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.code}
                  onChange={(event) => {
                    setDraft({ ...draft, code: event.target.value.toUpperCase() });
                  }}
                  className="font-mono uppercase"
                />
              )}
            </Field>

            <Field label="Internal name" required hint="Shown here, never to a customer.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.name}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label="Customer-facing description"
            hint="Appears beside the code in the storefront's coupon list."
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                value={draft.description}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                }}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Discount %" required>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={draft.discountPercent}
                  onChange={(event) => {
                    setDraft({ ...draft, discountPercent: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label="Status">
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.status}
                  onChange={(event) => {
                    setDraft({ ...draft, status: event.target.value as Draft['status'] });
                  }}
                >
                  <option value="DRAFT">Draft — never matches</option>
                  <option value="ACTIVE">Active</option>
                  <option value="DISABLED">Disabled</option>
                </Select>
              )}
            </Field>

            <Field label="Applies to">
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.scope}
                  onChange={(event) => {
                    setDraft({ ...draft, scope: event.target.value as Draft['scope'] });
                  }}
                >
                  <option value="ALL_PRODUCTS">All products</option>
                  <option value="CATEGORIES">Chosen categories</option>
                </Select>
              )}
            </Field>
          </div>

          {draft.scope === 'CATEGORIES' && (
            <Field
              label="Categories"
              required
              hint="Products in these categories, and everything beneath them, get the discount."
            >
              {({ inputId, describedBy }) => (
                <select
                  id={inputId}
                  aria-describedby={describedBy}
                  multiple
                  size={Math.min(8, Math.max(3, categoryOptions.length))}
                  value={draft.categoryIds}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      categoryIds: [...event.target.selectedOptions].map((option) => option.value),
                    });
                  }}
                  className="block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
                >
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          <fieldset className="rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium text-ink">Qualifying cart value</legend>
            <p className="mb-3 text-xs text-ink-muted">
              Set per currency, because a threshold converted between currencies would move with the
              exchange rate. Leave one blank and the coupon does not apply in that market at all.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {currencies.map((currency) => (
                <label key={currency.code} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs font-medium text-ink-muted">
                    {currency.code}
                  </span>
                  <Input
                    inputMode="decimal"
                    placeholder="Not offered"
                    value={draft.minimums[currency.code]?.amount ?? ''}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        minimums: {
                          ...draft.minimums,
                          [currency.code]: { amount: event.target.value },
                        },
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" hint="Blank means immediately.">
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="date"
                  value={draft.validFrom}
                  onChange={(event) => {
                    setDraft({ ...draft, validFrom: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label="Ends" hint="Blank means open-ended.">
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="date"
                  value={draft.validUntil}
                  onChange={(event) => {
                    setDraft({ ...draft, validUntil: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total uses" hint="Blank means unlimited.">
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="numeric"
                  value={draft.usageLimit}
                  onChange={(event) => {
                    setDraft({ ...draft, usageLimit: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label="Uses per customer" hint="Blank means unlimited.">
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="numeric"
                  value={draft.perCustomerLimit}
                  onChange={(event) => {
                    setDraft({ ...draft, perCustomerLimit: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.isPubliclyListed}
              onChange={(event) => {
                setDraft({ ...draft, isPubliclyListed: event.target.checked });
              }}
              className="mt-0.5"
            />
            <span className="text-sm text-ink">
              Advertise on the cart
              <span className="block text-xs text-ink-muted">
                Off makes it code-only: it still works when typed, it is just not listed.
              </span>
            </span>
          </label>

          {formError !== null && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={archiving !== null}
        onClose={() => {
          setArchiving(null);
        }}
        onConfirm={() => {
          if (archiving !== null) archive.mutate(archiving.id);
        }}
        title={`Archive ${archiving?.code ?? ''}?`}
        body="It stops applying immediately and disappears from every list. Orders that already used it keep their record."
        confirmLabel="Archive coupon"
        isDangerous
        isWorking={archive.isPending}
      />
    </div>
  );
}
