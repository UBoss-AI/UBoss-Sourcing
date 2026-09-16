/**
 * Carriers — the register of every haulier this marketplace uses.
 *
 * Nobody signs themselves up. A carrier exists because somebody here created
 * it and invited its first owner by email, and that is the whole of this
 * screen: the list, and the form that adds one.
 *
 * The invitation is a one-time activation link. No password is typed here, no
 * password is emailed, and nothing on this screen ever shows one — the person
 * who receives the link chooses their own and is walked through setting up a
 * second factor before they can do anything. The dialog says so, because an
 * operator who expects to be handed a password will otherwise go looking for
 * one and invent a worse way of doing it.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  Callout,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDate, formatNumber } from '@/lib/format';
import {
  contractKey,
  createPartner,
  fetchPartners,
  partnerStatusTone,
  statusKey,
  type PartnerRow,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';

const STATUSES = ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;

/** Module-level so the search debounce survives a re-render without a ref. */
let searchTimer = 0;

export function LogisticsPartnersPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [isCreating, setIsCreating] = useState(false);

  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'partners', status, search],
    queryFn: () => {
      const next = new URLSearchParams();
      if (status.length > 0) next.set('status', status);
      if (search.length > 0) next.set('search', search);
      return fetchPartners(next);
    },
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const columns: Column<PartnerRow>[] = [
    {
      key: 'carrier',
      header: t('logistics.partners.column.carrier'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.displayName}</p>
          <p className="truncate text-xxs text-ink-subtle">
            {row.partnerCode} · {row.legalName}
          </p>
        </div>
      ),
    },
    {
      key: 'country',
      header: t('logistics.partners.column.registeredIn'),
      secondary: true,
      render: (row) => <span className="text-xs text-ink-muted">{row.registrationCountry}</span>,
    },
    {
      key: 'contract',
      header: t('logistics.partners.column.contract'),
      secondary: true,
      render: (row) => (
        <div>
          <p className="text-xs text-ink-muted">{t(contractKey(row.contractStatus))}</p>
          {row.contractEndsAt !== null && (
            <p className="text-xxs text-ink-subtle">
              {t('logistics.partners.until', { date: formatDate(row.contractEndsAt) })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'open',
      header: t('logistics.partners.column.openWork'),
      align: 'right',
      render: (row) => (
        <div className="ml-auto">
          <p className="text-sm text-ink">{formatNumber(row.openShipments)}</p>
          {row.maxOpenShipments !== null && (
            <p className="text-xxs text-ink-subtle">
              {t('logistics.partners.ceiling', { max: formatNumber(row.maxOpenShipments) })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'people',
      header: t('logistics.partners.column.people'),
      align: 'right',
      tertiary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{formatNumber(row.memberCount)}</span>
      ),
    },
    {
      key: 'regions',
      header: t('logistics.partners.column.regions'),
      align: 'right',
      tertiary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{formatNumber(row.regionCount)}</span>
      ),
    },
    {
      key: 'status',
      header: t('logistics.partners.column.status'),
      align: 'center',
      render: (row) => (
        <Badge tone={partnerStatusTone(row.status)} dot>
          {t(statusKey(row.status))}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logistics.partners.heading')}
        description={t('logistics.partners.intro')}
        actions={
          can(Permission.LOGISTICS_WRITE) ? (
            <Button
              onClick={() => {
                setIsCreating(true);
              }}
            >
              {t('logistics.partners.add')}
            </Button>
          ) : undefined
        }
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('logistics.partners.filter.status')} className="w-48">
            <Select
              value={status}
              onChange={(event) => {
                update('status', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.partners.filter.everyStatus')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(statusKey(value))}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              defaultValue={search}
              placeholder={t('logistics.partners.searchPlaceholder')}
              onChange={(event) => {
                const value = event.currentTarget.value;
                window.clearTimeout(searchTimer);
                searchTimer = window.setTimeout(() => {
                  update('search', value.trim());
                }, 350);
              }}
            />
          </ToolbarField>

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
          caption={t('logistics.partners.heading')}
          columns={columns}
          rows={query.data?.partners ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="56rem"
          emptyTitle={t('logistics.partners.emptyTitle')}
          emptyDescription={t('logistics.partners.emptyBody')}
          onRowClick={(row) => {
            void navigate(`/logistics/partners/${row.id}`);
          }}
        />
      </Card>

      <CreatePartnerDialog
        isOpen={isCreating}
        onClose={() => {
          setIsCreating(false);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adding one
// ---------------------------------------------------------------------------

function CreatePartnerDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [invited, setInvited] = useState<{ email: string; expiresAt: string } | null>(null);

  const schema = z.object({
    displayName: z.string().trim().min(2).max(160),
    legalName: z.string().trim().min(2).max(255),
    registrationCountry: z
      .string()
      .trim()
      .length(2, t('logistics.partners.validation.country'))
      .transform((value) => value.toUpperCase()),
    contactEmail: z
      .string()
      .trim()
      .min(1)
      .pipe(z.email(t('validation.emailInvalid'))),
    registrationNumber: z.string().trim().max(64).optional(),
    contractReference: z.string().trim().max(64).optional(),
    internalNotes: z.string().trim().max(4000).optional(),
    ownerFullName: z.string().trim().min(2).max(160),
    ownerEmail: z
      .string()
      .trim()
      .min(1)
      .pipe(z.email(t('validation.emailInvalid'))),
  });

  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      displayName: '',
      legalName: '',
      registrationCountry: '',
      contactEmail: '',
      ownerFullName: '',
      ownerEmail: '',
    },
  });

  const create = useMutation({
    mutationFn: (values: Values) =>
      createPartner({
        displayName: values.displayName,
        legalName: values.legalName,
        registrationCountry: values.registrationCountry,
        contactEmail: values.contactEmail,
        // `exactOptionalPropertyTypes` is on: an empty optional is absent, not
        // an empty string, or the backend stores "" as a registration number.
        ...(values.registrationNumber !== undefined && values.registrationNumber.length > 0
          ? { registrationNumber: values.registrationNumber }
          : {}),
        ...(values.contractReference !== undefined && values.contractReference.length > 0
          ? { contractReference: values.contractReference }
          : {}),
        ...(values.internalNotes !== undefined && values.internalNotes.length > 0
          ? { internalNotes: values.internalNotes }
          : {}),
        ownerEmail: values.ownerEmail,
        ownerFullName: values.ownerFullName,
      }),
    onSuccess: (result) => {
      setInvited({ email: result.invitedOwner, expiresAt: result.invitationExpiresAt });
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partners'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const close = (): void => {
    setInvited(null);
    form.reset();
    onClose();
  };

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values);
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={t('logistics.partners.add')}
      {...(invited === null ? { description: t('logistics.partners.addIntro') } : {})}
      size="lg"
      footer={
        invited === null ? (
          <>
            <Button variant="secondary" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void onSubmit();
              }}
              disabled={create.isPending}
            >
              {t('logistics.partners.createAndInvite')}
            </Button>
          </>
        ) : (
          <Button onClick={close}>{t('common.done')}</Button>
        )
      }
    >
      {invited !== null ? (
        <Callout tone="success" title={t('logistics.partners.invited.title')} role="status">
          <p>{t('logistics.partners.invited.body', { email: invited.email })}</p>
          <p className="mt-2">
            {t('logistics.partners.invited.expires', {
              date: formatDate(invited.expiresAt),
            })}
          </p>
          <p className="mt-2">{t('logistics.partners.invited.noPassword')}</p>
          {/*
            Said out loud because its absence was read as a bug. Creating a
            carrier here signs nobody in as that carrier, so an operator who
            opened the portal straight afterwards saw whichever carrier that
            browser had last signed in as - and reported the portal as having
            chosen the wrong company.
          */}
          <p className="mt-2">{t('logistics.partners.invited.notSignedIn')}</p>
        </Callout>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('logistics.partners.field.displayName')}
              error={form.formState.errors.displayName?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={form.formState.errors.displayName !== undefined}
                  {...form.register('displayName')}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partners.field.legalName')}
              error={form.formState.errors.legalName?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={form.formState.errors.legalName !== undefined}
                  {...form.register('legalName')}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partners.field.country')}
              hint={t('logistics.partners.field.countryHint')}
              error={form.formState.errors.registrationCountry?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  maxLength={2}
                  className="uppercase"
                  invalid={form.formState.errors.registrationCountry !== undefined}
                  {...form.register('registrationCountry')}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partners.field.contactEmail')}
              error={form.formState.errors.contactEmail?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="email"
                  aria-describedby={describedBy}
                  invalid={form.formState.errors.contactEmail !== undefined}
                  {...form.register('contactEmail')}
                />
              )}
            </Field>

            <Field label={t('logistics.partners.field.registrationNumber')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  {...form.register('registrationNumber')}
                />
              )}
            </Field>

            <Field label={t('logistics.partners.field.contractReference')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  {...form.register('contractReference')}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('logistics.partners.field.internalNotes')}
            hint={t('logistics.partners.field.internalNotesHint')}
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                rows={2}
                aria-describedby={describedBy}
                {...form.register('internalNotes')}
              />
            )}
          </Field>

          <fieldset className="rounded-lg border border-border bg-surface-sunken p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('logistics.partners.ownerLegend')}
            </legend>

            <p className="mb-3 text-xs leading-relaxed text-ink-muted">
              {t('logistics.partners.ownerHint')}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('logistics.partners.field.ownerName')}
                error={form.formState.errors.ownerFullName?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={form.formState.errors.ownerFullName !== undefined}
                    {...form.register('ownerFullName')}
                  />
                )}
              </Field>

              <Field
                label={t('logistics.partners.field.ownerEmail')}
                error={form.formState.errors.ownerEmail?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="email"
                    aria-describedby={describedBy}
                    invalid={form.formState.errors.ownerEmail !== undefined}
                    {...form.register('ownerEmail')}
                  />
                )}
              </Field>
            </div>
          </fieldset>
        </form>
      )}
    </Modal>
  );
}
