/**
 * Staff and roles.
 *
 * The role picker is filled from `/admin/staff/assignable-roles`, not from a
 * list in this file. That endpoint answers "which roles may *you* grant", and
 * the backend checks the same rule again on save — in both directions, so
 * removing a role you could not have granted is refused too. Hard-coding the
 * six roles here would show a Business Owner option to someone who cannot
 * grant it, and the only feedback would be a 403 after the click.
 *
 * Two guards the server enforces and this screen explains up front:
 *   - The last active Business Owner cannot be demoted or deactivated.
 *   - Nobody can deactivate their own account.
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
  CheckboxField,
  Field,
  Input,
  PageHeader,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, humanise } from '@/lib/format';
import { Permission, roleLabel } from '@/lib/permissions';

interface StaffRole {
  key: string;
  name: string;
  assignedAt: string;
  assignedById: string | null;
}

interface StaffMember {
  id: string;
  email: string;
  status: string;
  roles: StaffRole[];
  permissions: string[];
  mfaEnabled: boolean;
  /** Still on the emailed temporary password - has never signed in and set one. */
  mustChangePassword: boolean;
  /** Never signed in and has no password of its own. Gates "Resend password". */
  owesAPassword: boolean;
  temporaryPasswordExpiresAt: string | null;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  archivedAt: string | null;
  createdAt: string;
}

interface AssignableRole {
  key: string;
  name: string;
  description?: string;
}

/**
 * The role checklist, shared by the create and edit dialogs.
 *
 * Boxed rather than a bare column of ticks: choosing roles *is* the decision
 * on both of these screens, and a role's description is as much a part of the
 * choice as its name.
 */
function RoleChecklist({
  assignable,
  selected,
  onToggle,
}: {
  assignable: AssignableRole[];
  selected: string[];
  onToggle: (key: string, checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {assignable.map((role) => (
        <CheckboxField
          key={role.key}
          boxed
          label={role.name}
          {...(role.description === undefined ? {} : { description: role.description })}
          checked={selected.includes(role.key)}
          onChange={(event) => {
            onToggle(role.key, event.target.checked);
          }}
        />
      ))}
    </div>
  );
}

function RoleDialog({
  member,
  assignable,
  onClose,
}: {
  member: StaffMember;
  assignable: AssignableRole[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>(member.roles.map((role) => role.key));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.patch(`/admin/staff/${member.id}/roles`, { roleKeys: selected }),
    onSuccess: async () => {
      toast.success('Roles updated.');
      await queryClient.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
    onError: (apiError) => {
      // The escalation guard's refusal names the role it refused, which is the
      // whole point of showing the server's message rather than a generic one.
      setError(apiError instanceof ApiError ? apiError.message : 'The roles could not be changed.');
    },
  });

  const assignableKeys = new Set(assignable.map((role) => role.key));

  // A role the current user cannot grant is still shown when the member already
  // has it - hiding it would make the checkbox list look like the full picture
  // while silently dropping that role on save.
  const held = member.roles.filter((role) => !assignableKeys.has(role.key));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Roles for ${member.email}`}
      description="A role is a set of permissions. Give the narrowest set that does the job."
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={selected.length === 0}
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            Save roles
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        <fieldset>
          <legend className="sr-only">Roles</legend>
          <RoleChecklist
            assignable={assignable}
            selected={selected}
            onToggle={(key, checked) => {
              setSelected((current) =>
                checked ? [...current, key] : current.filter((existing) => existing !== key),
              );
            }}
          />
        </fieldset>

        {held.length > 0 && (
          <Callout tone="warning" title={`This account also holds ${held.map((role) => role.name).join(', ')}.`}>
            You cannot grant or remove that role, so it is left unchanged.
          </Callout>
        )}

        {selected.length === 0 && (
          <Callout tone="danger" role="alert">
            An account needs at least one role. Deactivate it instead if it should have no access.
          </Callout>
        )}
      </div>
    </Modal>
  );
}

function NewStaffDialog({
  assignable,
  onClose,
}: {
  assignable: AssignableRole[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/admin/staff', { email: email.trim(), roleKeys: selected }),
    onSuccess: async () => {
      toast.success(
        'Account created. A temporary password has been emailed; they choose their own the first time they sign in.',
      );
      await queryClient.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
    onError: (apiError) => {
      setError(apiError instanceof ApiError ? apiError.message : 'The account could not be created.');
    },
  });

  const isValid = /^\S+@\S+\.\S+$/.test(email.trim()) && selected.length > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="New staff account"
      description="An account with no roles can sign in and see nothing, so at least one is required."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!isValid}
            isLoading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            Create account
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        <Field
          label="Email address"
          hint="A one-time password is emailed here, good for 72 hours. Signing in with it forces them to choose their own — which nobody else, including you, ever sees."
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="email"
              value={email}
              aria-describedby={describedBy}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>

        <fieldset className="border-t border-border-subtle pt-4">
          <legend className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            Roles
          </legend>
          <div className="mt-3">
            <RoleChecklist
              assignable={assignable}
              selected={selected}
              onToggle={(key, checked) => {
                setSelected((current) =>
                  checked ? [...current, key] : current.filter((existing) => existing !== key),
                );
              }}
            />
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

export function StaffPage(): React.JSX.Element {
  const { can, user } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [rolesFor, setRolesFor] = useState<StaffMember | null>(null);
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => api.get<{ staff: StaffMember[] }>('/admin/staff'),
  });

  const assignable = useQuery({
    queryKey: ['assignable-roles'],
    queryFn: () => api.get<{ roles: AssignableRole[] }>('/admin/staff/assignable-roles'),
    enabled: can(Permission.ROLE_ASSIGN),
  });

  const setStatus = useMutation({
    mutationFn: ({ member, active }: { member: StaffMember; active: boolean }) =>
      api.patch(`/admin/staff/${member.id}/status`, { active }),
    onSuccess: async (_result, variables) => {
      setDeactivating(null);
      toast.success(variables.active ? 'Account reactivated.' : 'Account deactivated.');
      await queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (error) => {
      setDeactivating(null);
      // Covers both server guards: the last Business Owner, and self-deactivation.
      toast.error(error instanceof ApiError ? error.message : 'The status could not be changed.');
    },
  });

  const canAssign = can(Permission.ROLE_ASSIGN);
  const canWrite = can(Permission.STAFF_WRITE);

  const reissue = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<{ temporaryPasswordExpiresAt: string }>(`/admin/staff/${id}/temporary-password`),
    onSuccess: async () => {
      toast.success('A new temporary password has been emailed. The previous one no longer works.');
      await queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? error.message : 'The password could not be sent. Try again.',
      );
    },
  });

  const columns: Column<StaffMember>[] = [
    {
      key: 'email',
      header: 'Account',
      render: (row) => (
        <div className="min-w-48">
          <p className="font-medium text-ink">{row.email}</p>
          {row.id === user?.id && <p className="text-xxs text-ink-subtle">That&rsquo;s you</p>}
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.roles.map((role) => (
            <Badge key={role.key} tone={role.key === 'business_owner' ? 'accent' : 'neutral'}>
              {roleLabel(role.key)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="min-w-32">
          {row.archivedAt !== null ? (
            <Badge dot tone="danger">
              Deactivated
            </Badge>
          ) : row.lockedUntil !== null ? (
            <Badge dot tone="warning">
              Locked
            </Badge>
          ) : row.owesAPassword ? (
            // May well be ACTIVE in the database, but it has never been used: the
            // account is still holding the temporary password we emailed, or an
            // invitation nobody clicked. Saying "Active" would hide the one thing
            // an administrator needs to notice.
            <Badge dot tone="warning">
              Awaiting first sign-in
            </Badge>
          ) : row.status === 'ACTIVE' ? (
            <Badge dot tone="success">
              Active
            </Badge>
          ) : (
            // Every other status here reads as English; this one should too.
            <Badge dot tone="warning">
              {humanise(row.status)}
            </Badge>
          )}
          {row.owesAPassword && row.temporaryPasswordExpiresAt !== null && (
            <p className="mt-1 text-xxs text-ink-subtle">
              Temporary password expires {formatDateTime(row.temporaryPasswordExpiresAt)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'mfa',
      header: 'Two-factor',
      secondary: true,
      render: (row) =>
        row.mfaEnabled ? (
          <Badge tone="success">On</Badge>
        ) : (
          <span className="text-ink-subtle">Off</span>
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
          <span className="text-ink-subtle">Never</span>
        ) : (
          <span className="text-ink-muted">{formatDateTime(row.lastLoginAt)}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          {/* Only while the account still owes a password. Once the holder has
              one of their own, the way back in is the reset they start
              themselves - not a fresh credential handed out by somebody else,
              and the API refuses it either way. */}
          {canWrite && canAssign && row.owesAPassword && row.archivedAt === null && (
            <Button
              size="sm"
              variant="ghost"
              isLoading={reissue.isPending && reissue.variables.id === row.id}
              onClick={() => {
                reissue.mutate({ id: row.id });
              }}
            >
              Resend password
              <span className="sr-only"> to {row.email}</span>
            </Button>
          )}
          {canAssign && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRolesFor(row);
              }}
            >
              Roles
              <span className="sr-only"> for {row.email}</span>
            </Button>
          )}
          {canWrite && row.id !== user?.id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (row.archivedAt === null) setDeactivating(row);
                else setStatus.mutate({ member: row, active: true });
              }}
            >
              {row.archivedAt === null ? 'Deactivate' : 'Reactivate'}
              <span className="sr-only"> {row.email}</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Staff"
        description="Who can sign in, and what each of them may do. Nobody here is given a password — an account is emailed a one-time credential and chooses its own."
        actions={
          canWrite && canAssign ? (
            <Button
              variant="primary"
              onClick={() => {
                setIsCreating(true);
              }}
            >
              New staff account
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-4">
        <Card>
          <DataTable
            caption="Staff accounts"
            columns={columns}
            rows={staff.data?.staff}
            rowKey={(row) => row.id}
            isLoading={staff.isPending}
            isRefreshing={staff.isFetching && !staff.isPending}
            error={staff.isError ? staff.error : undefined}
            loadingLabel="Loading staff accounts"
            minWidth="62rem"
            // A locked account cannot sign in right now, which is the thing
            // somebody opening this page is usually here to find.
            rowClassName={(row) =>
              row.archivedAt === null && row.lockedUntil !== null
                ? 'bg-warning-soft/60 hover:bg-warning-soft'
                : undefined
            }
            onRetry={() => {
              void staff.refetch();
            }}
            emptyTitle="No staff accounts"
            emptyDescription="There is at least one Business Owner, so an empty list here means the request was filtered."
          />
        </Card>

        <Callout tone="neutral" title="Two rules this screen cannot break">
          The last active Business Owner cannot be demoted or deactivated, and nobody can deactivate
          their own account. Both are enforced by the server, so a button that looks available will
          still be refused.
        </Callout>
      </div>

      {rolesFor !== null && (
        <RoleDialog
          member={rolesFor}
          assignable={assignable.data?.roles ?? []}
          onClose={() => {
            setRolesFor(null);
          }}
        />
      )}

      {isCreating && (
        <NewStaffDialog
          assignable={assignable.data?.roles ?? []}
          onClose={() => {
            setIsCreating(false);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={deactivating !== null}
        onClose={() => {
          setDeactivating(null);
        }}
        onConfirm={() => {
          if (deactivating !== null) setStatus.mutate({ member: deactivating, active: false });
        }}
        title={`Deactivate ${deactivating?.email ?? 'this account'}?`}
        confirmLabel="Deactivate account"
        isDangerous
        isWorking={setStatus.isPending}
        body="Their sessions end immediately and they can no longer sign in. Everything they did stays in the audit log."
      />
    </>
  );
}
