/**
 * Manufacturers, importers and EU responsible persons.
 *
 * GPSR Art. 19 requires a listing to name the manufacturer — with a postal
 * address and an electronic address — before the product is offered online,
 * and Art. 16 requires a responsible person inside the Union whenever that
 * manufacturer is established outside it.
 *
 * These live on their own screen rather than as fields on a product because
 * one manufacturer supplies dozens of lines, its registered address changes as
 * a company detail rather than as a catalogue edit, and the EU representative
 * is a legal role several manufacturers commonly share — an EU rep acting for
 * a group of Asian suppliers is the ordinary case, not the exception.
 *
 * Two things the screen refuses to do:
 *
 *   - **No delete while a product still names one.** The API refuses and says
 *     how many; a listing whose manufacturer row vanished would be offering a
 *     product with nobody named, which is the exact state the article forbids.
 *   - **No optional email.** Art. 19(a) calls it the "electronic address" and
 *     does not make it optional. A manufacturer a buyer cannot write to has
 *     not really been named.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type OperatorRole = 'MANUFACTURER' | 'EU_RESPONSIBLE_PERSON' | 'IMPORTER';

const ROLES: OperatorRole[] = ['MANUFACTURER', 'EU_RESPONSIBLE_PERSON', 'IMPORTER'];

interface OperatorAddress {
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string | null;
  postalCode?: string | null;
}

interface EconomicOperator {
  id: string;
  role: OperatorRole;
  legalName: string;
  tradeName: string | null;
  address: OperatorAddress | null;
  countryCode: string;
  email: string;
  phone: string | null;
  website: string | null;
  /** MDR Art. 31, and only ever set on a manufacturer. */
  eudamedSrn: string | null;
  isActive: boolean;
  /** How many listings name this operator, as manufacturer or as EU rep. */
  productCount: number;
}

interface Draft {
  role: OperatorRole;
  legalName: string;
  tradeName: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  email: string;
  phone: string;
  website: string;
  eudamedSrn: string;
}

function emptyDraft(): Draft {
  return {
    role: 'MANUFACTURER',
    legalName: '',
    tradeName: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
    email: '',
    phone: '',
    website: '',
    eudamedSrn: '',
  };
}

function draftFrom(operator: EconomicOperator): Draft {
  const address = operator.address ?? {};

  return {
    role: operator.role,
    legalName: operator.legalName,
    tradeName: operator.tradeName ?? '',
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    region: address.region ?? '',
    postalCode: address.postalCode ?? '',
    countryCode: operator.countryCode,
    email: operator.email,
    phone: operator.phone ?? '',
    website: operator.website ?? '',
    eudamedSrn: operator.eudamedSrn ?? '',
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function addressLine(operator: EconomicOperator): string {
  const address = operator.address ?? {};

  return [address.line1, address.city, address.postalCode, operator.countryCode]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(', ');
}

export function ManufacturersPage(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [roleFilter, setRoleFilter] = useState('');
  const [editing, setEditing] = useState<EconomicOperator | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<EconomicOperator | null>(null);

  const canWrite = can(Permission.PRODUCT_WRITE);

  const query = useQuery({
    queryKey: ['economic-operators', roleFilter],
    queryFn: () =>
      api.get<{ operators: EconomicOperator[] }>('/admin/economic-operators', {
        query: roleFilter === '' ? {} : { role: roleFilter },
      }),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['economic-operators'] });
  };

  const body = (): Record<string, unknown> => ({
    role: draft.role,
    legalName: draft.legalName,
    tradeName: blankToNull(draft.tradeName),
    address: {
      line1: draft.line1,
      line2: blankToNull(draft.line2),
      city: draft.city,
      region: blankToNull(draft.region),
      postalCode: blankToNull(draft.postalCode),
    },
    countryCode: draft.countryCode,
    email: draft.email,
    phone: blankToNull(draft.phone),
    website: blankToNull(draft.website),
    eudamedSrn: blankToNull(draft.eudamedSrn),
  });

  const close = (): void => {
    setIsCreating(false);
    setEditing(null);
    setFormError(null);
    setDraft(emptyDraft());
  };

  const save = useMutation({
    mutationFn: () =>
      editing === null
        ? api.post('/admin/economic-operators', body())
        : api.patch(`/admin/economic-operators/${editing.id}`, body()),
    onSuccess: async () => {
      toast.success(editing === null ? t('operators.created') : t('operators.updated'));
      close();
      await invalidate();
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : t('operators.couldNotSave'));
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/economic-operators/${id}`),
    onSuccess: async () => {
      toast.success(t('operators.archived'));
      setConfirmArchive(null);
      await invalidate();
    },
    onError: (error) => {
      // The API says how many listings are in the way, which is the question
      // the operator is about to ask.
      toast.error(error instanceof ApiError ? error.message : t('operators.couldNotArchive'));
      setConfirmArchive(null);
    },
  });

  const columns: Column<EconomicOperator>[] = [
    {
      key: 'name',
      header: t('operators.company'),
      render: (row) => (
        <div className="min-w-48">
          <p className="font-medium text-ink">{row.legalName}</p>
          {row.tradeName !== null && (
            <p className="text-xxs text-ink-subtle">{row.tradeName}</p>
          )}
          <p className="mt-0.5 text-xxs text-ink-muted">{addressLine(row)}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: t('operators.role'),
      nowrap: true,
      render: (row) => (
        <Badge tone={row.role === 'EU_RESPONSIBLE_PERSON' ? 'operational' : 'neutral'}>
          {t(`operators.role.${row.role}` as 'operators.role.MANUFACTURER')}
        </Badge>
      ),
    },
    {
      key: 'contact',
      header: t('operators.contact'),
      secondary: true,
      render: (row) => (
        <div className="min-w-40">
          {/* Art. 19(a)'s "electronic address". Shown as a link because the
              point of the field is that somebody can actually use it. */}
          <a
            className="break-all text-ink underline underline-offset-2 hover:no-underline"
            href={`mailto:${row.email}`}
          >
            {row.email}
          </a>
          {row.phone !== null && <p className="text-xxs text-ink-subtle">{row.phone}</p>}
        </div>
      ),
    },
    {
      key: 'products',
      header: t('operators.listings'),
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) => <span className="text-ink-muted">{row.productCount}</span>,
    },
    {
      key: 'actions',
      header: t('operators.action'),
      align: 'right',
      render: (row) => {
        if (!canWrite) return <span className="text-ink-subtle">—</span>;

        return (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                setEditing(row);
                setDraft(draftFrom(row));
                setFormError(null);
              }}
            >
              {t('operators.edit')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setConfirmArchive(row);
              }}
            >
              {t('operators.retire')}
            </Button>
          </div>
        );
      },
    },
  ];

  const isFormOpen = isCreating || editing !== null;

  return (
    <>
      <PageHeader title={t('operators.title')} description={t('operators.description')} />

      <Card>
        <div className="px-5 pt-4">
          <Callout tone="neutral" title={t('operators.whyTitle')}>
            {t('operators.whyBody')}
          </Callout>
        </div>

        <Toolbar>
          <ToolbarField label={t('operators.role')}>
            <Select
              value={roleFilter}
              onChange={(event) => {
                setRoleFilter(event.target.value);
              }}
              className="w-64"
            >
              <option value="">{t('operators.anyRole')}</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`operators.role.${role}` as 'operators.role.MANUFACTURER')}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {canWrite && (
            <ToolbarActions>
              <Button
                variant="primary"
                onClick={() => {
                  setDraft(emptyDraft());
                  setEditing(null);
                  setFormError(null);
                  setIsCreating(true);
                }}
              >
                {t('operators.add')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption={t('operators.title')}
          columns={columns}
          rows={query.data?.operators}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel={t('operators.loading')}
          minWidth="60rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={t('operators.emptyTitle')}
          emptyDescription={t('operators.emptyDescription')}
        />
      </Card>

      {isFormOpen && (
        <Modal
          isOpen
          onClose={close}
          size="lg"
          title={editing === null ? t('operators.add') : t('operators.editTitle')}
          description={t('operators.formHint')}
          footer={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                isLoading={save.isPending}
                onClick={() => {
                  setFormError(null);
                  save.mutate();
                }}
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {formError !== null && (
              <Callout tone="danger" role="alert">
                {formError}
              </Callout>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('operators.role')} required>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={draft.role}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        role: event.target.value as OperatorRole,
                      }));
                    }}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`operators.role.${role}` as 'operators.role.MANUFACTURER')}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field
                label={t('operators.countryCode')}
                hint={t('operators.countryCodeHint')}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono sm:w-32"
                    maxLength={2}
                    placeholder="NL"
                    aria-describedby={describedBy}
                    value={draft.countryCode}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        countryCode: event.target.value.toUpperCase(),
                      }));
                    }}
                  />
                )}
              </Field>

              <Field
                label={t('operators.legalName')}
                hint={t('operators.legalNameHint')}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={draft.legalName}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, legalName: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.tradeName')} hint={t('operators.tradeNameHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={draft.tradeName}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, tradeName: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('operators.line1')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={draft.line1}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, line1: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.line2')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={draft.line2}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, line2: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.city')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={draft.city}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, city: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.postalCode')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={draft.postalCode}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, postalCode: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('operators.email')} hint={t('operators.emailHint')} required>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="email"
                    aria-describedby={describedBy}
                    value={draft.email}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, email: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.phone')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="tel"
                    value={draft.phone}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, phone: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label={t('operators.website')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="url"
                    placeholder="https://"
                    value={draft.website}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, website: event.target.value }));
                    }}
                  />
                )}
              </Field>

              {/* Only a manufacturer registers with Eudamed, so the field only
                  appears for one. Asking an importer for an SRN it cannot have
                  would train an operator to type something into it. */}
              {draft.role === 'MANUFACTURER' && (
                <Field label={t('operators.eudamedSrn')} hint={t('operators.eudamedSrnHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={draft.eudamedSrn}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, eudamedSrn: event.target.value }));
                      }}
                    />
                  )}
                </Field>
              )}
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        isOpen={confirmArchive !== null}
        title={t('operators.retireTitle')}
        // Names the count, because that is the whole answer to "can I?".
        body={
          confirmArchive === null
            ? ''
            : t('operators.retireBody', {
                name: confirmArchive.legalName,
                count: confirmArchive.productCount,
              })
        }
        confirmLabel={t('operators.retire')}
        isDangerous
        isWorking={archive.isPending}
        onClose={() => {
          setConfirmArchive(null);
        }}
        onConfirm={() => {
          if (confirmArchive !== null) archive.mutate(confirmArchive.id);
        }}
      />
    </>
  );
}
