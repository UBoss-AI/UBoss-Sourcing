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
import { Badge, Button, Card, Field, Input, PageHeader } from '@/components/ui';
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
          <Button onClick={onClose}>Cancel</Button>
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
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <fieldset>
          <legend className="sr-only">Roles</legend>
          <div className="space-y-2">
            {assignable.map((role) => (
              <label
                key={role.key}
                className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent"
                  checked={selected.includes(role.key)}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, role.key]
                        : current.filter((key) => key !== role.key),
                    );
                  }}
                />
                <span>
                  <span className="text-sm font-medium text-ink">{role.name}</span>
                  {role.description !== undefined && (
                    <span className="mt-0.5 block text-xs text-ink-muted">{role.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {held.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs">
            <p className="font-medium text-warning">
              This account also holds {held.map((role) => role.name).join(', ')}.
            </p>
            <p className="mt-0.5 text-ink-muted">
              You cannot grant or remove that role, so it is left unchanged.
            </p>
          </div>
        )}

        {selected.length === 0 && (
          <p role="alert" className="text-xs font-medium text-danger">
            An account needs at least one role. Deactivate it instead if it should have no access.
          </p>
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
      toast.success('Staff account created. They set their own password from the invitation.');
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
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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
      <div className="space-y-4">
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <Field
          label="Email address"
          hint="An invitation is sent here. No password is set by anyone but the account holder."
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

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Roles</legend>
          <div className="space-y-2">
            {assignable.map((role) => (
              <label
                key={role.key}
                className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent"
                  checked={selected.includes(role.key)}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, role.key]
                        : current.filter((key) => key !== role.key),
                    );
                  }}
                />
                <span>
                  <span className="text-sm font-medium text-ink">{role.name}</span>
                  {role.description !== undefined && (
                    <span className="mt-0.5 block text-xs text-ink-muted">{role.description}</span>
                  )}
                </span>
              </label>
            ))}
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

  const columns: Column<StaffMember>[] = [
    {
      key: 'email',
      header: 'Account',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.email}</p>
          {row.id === user?.id && <p className="text-xxs text-ink-subtle">That's you</p>}
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
      render: (row) =>
        row.archivedAt !== null ? (
          <Badge tone="danger">Deactivated</Badge>
        ) : row.lockedUntil !== null ? (
          <Badge tone="warning">Locked</Badge>
        ) : row.status === 'ACTIVE' ? (
          <Badge tone="success">Active</Badge>
        ) : (
          // Every other status here reads as English; this one should too.
          <Badge tone="warning">{humanise(row.status)}</Badge>
        ),
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      secondary: true,
      render: (row) =>
        row.lastLoginAt === null ? (
          <span className="text-ink-subtle">Never</span>
        ) : (
          <span className="whitespace-nowrap">{formatDateTime(row.lastLoginAt)}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          {canAssign && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRolesFor(row);
              }}
            >
              Roles
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
        description="Who can sign in, and what each of them may do."
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

      <Card>
        <DataTable
          caption="Staff accounts"
          columns={columns}
          rows={staff.data?.staff}
          rowKey={(row) => row.id}
          isLoading={staff.isPending}
          error={staff.isError ? staff.error : undefined}
          onRetry={() => {
            void staff.refetch();
          }}
          emptyTitle="No staff accounts"
        />
      </Card>

      <p className="mt-3 text-xs text-ink-muted">
        The last active Business Owner cannot be demoted or deactivated, and nobody can deactivate
        their own account. Both rules are enforced by the server, not by this page.
      </p>

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
