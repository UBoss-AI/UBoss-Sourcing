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
 * The editor is grouped rather than run as one column of twenty inputs:
 * identity, what it takes off, who it applies to, when it runs, how often. The
 * category picker only appears once the scope calls for it, because on the
 * common setting — all products — it is a list of choices that do nothing.
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
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
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

const STATUS_TONE: Record<Coupon['status'], BadgeTone> = {
  ACTIVE: 'success',
  DRAFT: 'neutral',
  DISABLED: 'warning',
};

const STATUS_LABEL: Record<Coupon['status'], string> = {
  ACTIVE: 'Active',
  DRAFT: 'Draft',
  DISABLED: 'Disabled',
};

/** Flattens the category tree for a multi-select, keeping the depth indent. */
function flattenCategories(
  nodes: CategoryNode[],
  depth = 0,
): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${'  '.repeat(depth)}${node.name}` },
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

  const newCouponButton = (
    <Button variant="primary" onClick={openCreate}>
      New coupon
    </Button>
  );

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Code',
      render: (row) => (
        <div className="min-w-40">
          <p className="font-mono text-sm font-semibold text-ink">{row.code}</p>
          <p className="text-xs text-ink-muted">{row.name}</p>
        </div>
      ),
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      nowrap: true,
      render: (row) => <span className="font-medium text-ink">{row.discountPercent}%</span>,
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
      align: 'right',
      secondary: true,
      render: (row) => (
        <div className="space-y-0.5">
          {row.minimums.map((entry) => (
            <p key={entry.currencyCode} className="whitespace-nowrap text-xs text-ink-muted">
              <span className="text-ink-subtle">{entry.currencyCode}</span>{' '}
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
      tertiary: true,
      nowrap: true,
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
        <span className="text-ink-muted">
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
          {row.archivedAt === null ? (
            <Badge dot tone={STATUS_TONE[row.status]}>
              {STATUS_LABEL[row.status]}
            </Badge>
          ) : (
            <Badge dot tone="danger">
              Archived
            </Badge>
          )}
          {!row.isPubliclyListed && <Badge tone="neutral">Code only</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) =>
        canWrite ? (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                openEdit(row);
              }}
            >
              Edit
              <span className="sr-only"> {row.code}</span>
            </Button>
            {can(Permission.COUPON_ARCHIVE) && row.archivedAt === null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setArchiving(row);
                }}
              >
                Archive
                <span className="sr-only"> {row.code}</span>
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Percentage discounts, optionally limited to categories, that unlock at a cart value set per currency."
        actions={canWrite ? newCouponButton : undefined}
      />

      <Card>
        <DataTable
          caption="Coupons"
          columns={columns}
          rows={coupons.data?.coupons}
          rowKey={(row) => row.id}
          isLoading={coupons.isPending}
          isRefreshing={coupons.isFetching && !coupons.isPending}
          error={coupons.isError ? coupons.error : undefined}
          loadingLabel="Loading coupons"
          minWidth="68rem"
          onRetry={() => {
            void coupons.refetch();
          }}
          emptyTitle="No coupons yet"
          emptyDescription="Create one to offer a discount on the storefront."
          {...(canWrite ? { emptyAction: newCouponButton } : {})}
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
          <>
            <Button
              onClick={() => {
                setIsOpen(false);
              }}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} isLoading={save.isPending}>
              {editing === null ? 'Create coupon' : 'Save coupon'}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          {formError !== null && (
            <Callout tone="danger" role="alert">
              {formError}
            </Callout>
          )}

          <FieldGroup legend="Identity">
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
            </div>
          </FieldGroup>

          <FieldGroup
            legend="What it takes off, and where"
            hint="A draft coupon never matches, whatever else is set here."
            className="border-t border-border-subtle pt-5"
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Discount %" required>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      inputMode="decimal"
                      className="tabular"
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

              {/* Only asked for once the answer above makes it a question. */}
              {draft.scope === 'CATEGORIES' && (
                <Field
                  label="Categories"
                  required
                  hint="Products in these categories, and everything beneath them, get the discount. Hold Ctrl (or Cmd) to choose more than one."
                >
                  {({ inputId, describedBy }) => (
                    <MultiSelect
                      id={inputId}
                      aria-describedby={describedBy}
                      size={Math.min(8, Math.max(3, categoryOptions.length))}
                      value={draft.categoryIds}
                      invalid={draft.categoryIds.length === 0}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          categoryIds: [...event.target.selectedOptions].map((option) => option.value),
                        });
                      }}
                    >
                      {categoryOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </MultiSelect>
                  )}
                </Field>
              )}
            </div>
          </FieldGroup>

          <FieldGroup
            legend="Qualifying cart value"
            hint="Set per currency, because a threshold converted between currencies would move with the exchange rate. Leave one blank and the coupon does not apply in that market at all — at least one is required."
            className="border-t border-border-subtle pt-5"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {currencies.map((currency) => (
                <label key={currency.code} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs font-medium text-ink-muted">
                    {currency.code}
                    <span className="ml-1 text-ink-subtle">{currency.symbol}</span>
                  </span>
                  <Input
                    inputMode="decimal"
                    className="tabular"
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
          </FieldGroup>

          <FieldGroup
            legend="When it runs, and how often"
            className="border-t border-border-subtle pt-5"
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" hint="Blank means immediately.">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="date"
                      aria-describedby={describedBy}
                      value={draft.validFrom}
                      onChange={(event) => {
                        setDraft({ ...draft, validFrom: event.target.value });
                      }}
                    />
                  )}
                </Field>

                <Field label="Ends" hint="Blank means open-ended.">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="date"
                      aria-describedby={describedBy}
                      value={draft.validUntil}
                      onChange={(event) => {
                        setDraft({ ...draft, validUntil: event.target.value });
                      }}
                    />
                  )}
                </Field>

                <Field label="Total uses" hint="Blank means unlimited.">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      className="tabular"
                      aria-describedby={describedBy}
                      value={draft.usageLimit}
                      onChange={(event) => {
                        setDraft({ ...draft, usageLimit: event.target.value });
                      }}
                    />
                  )}
                </Field>

                <Field label="Uses per customer" hint="Blank means unlimited.">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      className="tabular"
                      aria-describedby={describedBy}
                      value={draft.perCustomerLimit}
                      onChange={(event) => {
                        setDraft({ ...draft, perCustomerLimit: event.target.value });
                      }}
                    />
                  )}
                </Field>
              </div>

              <CheckboxField
                boxed
                label="Advertise on the cart"
                description="Off makes it code-only: it still works when typed, it is just not listed."
                checked={draft.isPubliclyListed}
                onChange={(event) => {
                  setDraft({ ...draft, isPubliclyListed: event.target.checked });
                }}
              />
            </div>
          </FieldGroup>
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
    </>
  );
}
