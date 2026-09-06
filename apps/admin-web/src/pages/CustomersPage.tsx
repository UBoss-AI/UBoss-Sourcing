/**
 * Customers.
 *
 * These are business accounts, not shoppers. Two things follow from that and
 * shape this screen:
 *
 *   - **Nobody self-registers.** An account is created here and activated by
 *     the invitation the customer accepts. So the list shows an account's
 *     stage — invited, active, suspended — not just a name.
 *   - **Limits are money.** Per-order minimum and maximum, monthly cap and
 *     approval threshold are typed in major units and sent in minor units, by
 *     digit shifting. Blank means "no limit", which is not the same as zero —
 *     zero would block every order.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
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
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatDateTime, formatNumber, humanise, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { customerStatusTone } from '@/lib/customers';
import type { CustomerListItem } from '@/lib/customers';
import type { Pagination } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

const createSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'An email address is required.')
    .pipe(z.email('Enter a valid email address.')),
  fullName: z.string().trim().min(1, 'A contact name is required.').max(255),
  organization: z.string().trim().max(255),
  department: z.string().trim().max(128),
  phone: z.string().trim().max(32),
  gstin: z.string().trim().max(32),
  sendInvitation: z.boolean(),
});

type CreateForm = z.output<typeof createSchema>;

const CREATE_FIELDS = [
  'email',
  'fullName',
  'organization',
  'department',
  'phone',
  'gstin',
] as const;

function NewCustomerDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      email: '',
      fullName: '',
      organization: '',
      department: '',
      phone: '',
      gstin: '',
      sendInvitation: true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateForm) =>
      api.post<{ id: string }>('/admin/customers', {
        email: values.email,
        fullName: values.fullName,
        organization: nullIfBlank(values.organization),
        department: nullIfBlank(values.department),
        phone: nullIfBlank(values.phone),
        gstin: nullIfBlank(values.gstin),
        sendInvitation: values.sendInvitation,
      }),
    onSuccess: async (result) => {
      toast.success('Customer created.');
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
      void navigate(`/customers/${result.id}`);
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, CREATE_FIELDS));
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => mutation.mutateAsync(values))();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('customers.newCustomer')}
      description={t('customers.theAccountIsCreatedHere')}
      footer={
        <>
          <Button onClick={onClose}>{t('customers.cancel')}</Button>
          <Button variant="primary" isLoading={mutation.isPending} onClick={submit}>
            {t('customers.createCustomer')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('customers.emailAddress')} error={errors.email?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="email"
                aria-describedby={describedBy}
                invalid={errors.email !== undefined}
                {...register('email')}
              />
            )}
          </Field>

          <Field label={t('customers.contactName')} error={errors.fullName?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.fullName !== undefined}
                {...register('fullName')}
              />
            )}
          </Field>

          <Field label={t('customers.organisation')} error={errors.organization?.message}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} {...register('organization')} />
            )}
          </Field>

          <Field label={t('customers.department')} error={errors.department?.message}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} {...register('department')} />
            )}
          </Field>

          <Field label={t('customers.phone')} error={errors.phone?.message}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="tel"
                aria-describedby={describedBy}
                {...register('phone')}
              />
            )}
          </Field>

          <Field label="GSTIN" error={errors.gstin?.message}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                aria-describedby={describedBy}
                {...register('gstin')}
              />
            )}
          </Field>
        </div>

        <div className="border-t border-border-subtle pt-4">
          <CheckboxField
            boxed
            label={t('customers.sendAnInvitationNow')}
            description={t('customers.theCustomerSetsTheirOwn')}
            {...register('sendInvitation')}
          />
        </div>
      </form>
    </Modal>
  );
}

export function CustomersPage(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const q = searchParams.get('q') ?? '';
  const [searchText, setSearchText] = useState(q);
  const [isCreating, setIsCreating] = useState(false);

  const hasFilters = status !== '' || q !== '';

  useEffect(() => {
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    if (searchText === q) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (searchText === '') next.delete('q');
          else next.set('q', searchText);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText, q, setSearchParams]);

  const query = useQuery({
    queryKey: ['customers', { page, status, q }],
    queryFn: () =>
      api.get<{ customers: CustomerListItem[]; pagination: Pagination }>('/admin/customers', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          q: q === '' ? undefined : q,
        },
      }),
  });

  const newCustomerButton = (
    <Button
      variant="primary"
      onClick={() => {
        setIsCreating(true);
      }}
    >
      {t('customers.newCustomer')}
    </Button>
  );

  const columns: Column<CustomerListItem>[] = [
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (
        <div className="min-w-48">
          <Link
            to={`/customers/${row.id}`}
            className="font-medium text-ink hover:text-accent hover:underline"
          >
            {row.fullName ?? row.email}
          </Link>
          <p className="truncate text-xxs text-ink-subtle">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'organization',
      header: 'Organisation',
      render: (row) => (
        <div className="min-w-36">
          <p className="text-ink">
            {row.organization ?? <span className="text-ink-subtle">—</span>}
          </p>
          {row.department !== null && <p className="text-xxs text-ink-subtle">{row.department}</p>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge dot tone={customerStatusTone(row.status)}>
          {humanise(row.status)}
        </Badge>
      ),
    },
    {
      key: 'approval',
      header: 'Approvals',
      secondary: true,
      render: (row) =>
        row.limits.requiresOrderApproval ? (
          // Thresholds are per currency now, so the list shows each market's
          // rather than one number that would be true in only one of them.
          <Badge tone="warning">
            {row.limits.perCurrency.every((entry) => entry.approvalThresholdMinor === null)
              ? 'All orders'
              : row.limits.perCurrency
                  .filter((entry) => entry.approvalThresholdMinor !== null)
                  .map(
                    (entry) =>
                      `Over ${entry.currencyCode} ${minorToMajor(entry.approvalThresholdMinor ?? '0')}`,
                  )
                  .join(', ')}
          </Badge>
        ) : (
          <span className="text-ink-subtle">{t('customers.notRequired')}</span>
        ),
    },
    {
      key: 'orders',
      header: 'Orders',
      align: 'right',
      render: (row) =>
        row.orderCount === 0 ? (
          <span className="text-ink-subtle">0</span>
        ) : (
          formatNumber(row.orderCount)
        ),
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      secondary: true,
      tertiary: true,
      nowrap: true,
      render: (row) =>
        row.lastLoginAt === null ? (
          <span className="text-ink-subtle">{t('customers.never')}</span>
        ) : (
          <span className="text-ink-muted">{formatDateTime(row.lastLoginAt)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('customers.customers')}
        description={t('customers.businessAccountsCreatedHereActivated')}
        actions={can(Permission.CUSTOMER_WRITE) ? newCustomerButton : undefined}
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('customers.search')} grow>
            <Input
              type="search"
              value={searchText}
              placeholder={t('customers.nameEmailOrOrganisation')}
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('customers.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setSearchParams((current) => {
                  const next = new URLSearchParams(current);
                  if (event.target.value === '') next.delete('status');
                  else next.set('status', event.target.value);
                  next.delete('page');
                  return next;
                });
              }}
              className="w-44"
            >
              {/* The values are `UserStatus` from the schema. They were once
                  INVITED/SUSPENDED, which the backend's enum rejects outright -
                  so picking either filter answered 400 rather than filtering. */}
              <option value="">{t('customers.anyStatus')}</option>
              <option value="ACTIVE">{t('customers.active')}</option>
              <option value="PENDING_INVITATION">{t('customers.invited')}</option>
              <option value="PENDING_APPROVAL">{t('customers.awaitingApproval')}</option>
              <option value="DEACTIVATED">{t('customers.suspended')}</option>
            </Select>
          </ToolbarField>

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('customers.clearFilters')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption="Customers"
          columns={columns}
          rows={query.data?.customers}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading customers"
          minWidth="62rem"
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/customers/${row.id}`);
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No customers yet'}
          emptyDescription={
            hasFilters
              ? 'Try a different search, or clear the filters.'
              : 'Create an account and send an invitation; the customer sets their own password.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('customers.clearFilters')}
              </Button>
            ) : can(Permission.CUSTOMER_WRITE) ? (
              newCustomerButton
            ) : undefined
          }
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>

      {isCreating && (
        <NewCustomerDialog
          onClose={() => {
            setIsCreating(false);
          }}
        />
      )}
    </>
  );
}
