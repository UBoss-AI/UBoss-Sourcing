/**
 * Your business, your places, and who else can get in.
 *
 * Three panels rather than three pages, because a seller opens this section
 * once a quarter and going looking for "where do I add a warehouse" across
 * three menu items is worse than one page they scroll.
 *
 * The team panel is the one with teeth: `MEMBER_WRITE` is the permission that
 * grants permissions, so only an owner or an admin sees the controls, and the
 * server refuses anyway - see `canGrantSellerRole`.
 */
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { useStorefront } from '@/app/storefront-context';
import {
  archiveLocation,
  changeMemberRole,
  createLocation,
  fetchBusinessProfile,
  fetchLocations,
  fetchMembers,
  removeMember,
  removeSellerLogo,
  updateLocation,
  uploadSellerLogo,
  type SellerLocation,
} from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';

interface TeamMember {
  id: string;
  role: string;
  joinedAt: string;
  name: string;
  email: string;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  CATALOGUE_MANAGER: 'Catalogue manager',
  INVENTORY_MANAGER: 'Inventory manager',
  ORDER_MANAGER: 'Order manager',
  FINANCE_VIEWER: 'Finance viewer',
  SUPPORT_MEMBER: 'Support',
};

export function SellerProfilePage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const [isAdding, setIsAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [editing, setEditing] = useState<SellerLocation | null>(null);
  const [closing, setClosing] = useState<SellerLocation | null>(null);

  const profile = useQuery({
    queryKey: ['seller', 'business-profile'],
    queryFn: fetchBusinessProfile,
  });

  const locations = useQuery({ queryKey: ['seller', 'locations'], queryFn: fetchLocations });

  const team = useQuery({
    queryKey: ['seller', 'members'],
    queryFn: fetchMembers,
    // A Support Member cannot read the team, and that is a 403 rather than an
    // empty list. Retrying it would be three more 403s on a page they can
    // otherwise use perfectly well.
    retry: false,
    enabled: seller.permissions.includes('seller.member.read'),
  });

  const canManageTeam = seller.permissions.includes('seller.member.write');
  const canManageLocations = seller.permissions.includes('seller.location.write');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seller profile"
        description="Your business details, where you ship from, and who else can use this account."
      />

      {/* ---- The business ------------------------------------------------- */}
      <Card
        title="Your business"
        description="Reviewed by the marketplace. Contact us if any of it needs to change."
      >
        <div className="px-6 py-5">
          {profile.isPending && <LoadingState label="Loading" />}

          {profile.isError && (
            <ErrorState
              error={profile.error}
              onRetry={() => {
                void profile.refetch();
              }}
            />
          )}

          {profile.data !== undefined && (
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Detail label="Registered name" value={profile.data.account?.legalName ?? null} />
              <Detail label="Shop name" value={profile.data.account?.displayName ?? null} />
              <Detail
                label="Registered in"
                value={profile.data.account?.registrationCountry ?? null}
              />
              <Detail
                label="Seller type"
                value={
                  profile.data.account === null
                    ? null
                    : profile.data.account.kind.replace(/_/g, ' ').toLowerCase()
                }
                sentenceCase
              />
              <Detail
                label="Company registration number"
                value={profile.data.profile?.companyRegistrationNumber ?? null}
              />
              <Detail
                label="Tax registration"
                value={profile.data.profile?.taxRegistrationNumber ?? null}
              />
              <Detail
                label="Authorised representative"
                value={profile.data.profile?.representativeName ?? null}
              />
              <Detail label="Support email" value={profile.data.profile?.supportEmail ?? null} />
            </dl>
          )}
        </div>
      </Card>

      {/* ---- The mark on your shop ----------------------------------------- */}
      <ShopLogoCard
        logoUrl={profile.data?.account?.logoUrl ?? null}
        displayName={profile.data?.account?.displayName ?? seller.displayName}
        canManage={seller.permissions.includes('seller.account.write')}
      />

      {/* ---- Places -------------------------------------------------------- */}
      <Card
        title="Where you ship from"
        description="Each address has its own dispatch cut-off and handling time."
        actions={
          canManageLocations ? (
            <Button
              onClick={() => {
                setIsAdding(true);
              }}
            >
              Add an address
            </Button>
          ) : undefined
        }
      >
        {locations.isPending && <LoadingState label="Loading your addresses" />}

        {locations.isError && (
          <ErrorState
            error={locations.error}
            onRetry={() => {
              void locations.refetch();
            }}
          />
        )}

        {locations.data !== undefined && locations.data.locations.length === 0 && (
          <EmptyState
            title="No addresses yet"
            description="Add at least one place that can dispatch orders and take returns back."
            action={
              canManageLocations ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setIsAdding(true);
                  }}
                >
                  Add an address
                </Button>
              ) : undefined
            }
          />
        )}

        {locations.data !== undefined && locations.data.locations.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {locations.data.locations.map((location) => (
              <li key={location.id} className="px-6 py-4">
                <LocationRow
                  location={location}
                  canManage={canManageLocations}
                  onEdit={() => {
                    setEditing(location);
                  }}
                  onClose={() => {
                    setClosing(location);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- People --------------------------------------------------------- */}
      {seller.permissions.includes('seller.member.read') && (
        <Card
          title="Your team"
          description="Everybody who can use this seller account, and what each of them may do."
        >
          {team.isPending && <LoadingState label="Loading your team" />}

          {team.data !== undefined && (
            <ul className="divide-y divide-border-subtle">
              {team.data.members.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                    <p className="truncate text-xxs text-ink-subtle">{member.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>
                      {ROLE_LABELS[member.role] ?? member.role}
                    </Badge>
                    {canManageTeam && member.role !== 'OWNER' && (
                      <>
                        <RoleSelect memberId={member.id} current={member.role} />
                        <Button
                          onClick={() => {
                            setRemoving(member);
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canManageTeam && (
            <p className="border-t border-border-subtle px-6 py-4 text-xxs leading-relaxed text-ink-muted">
              A person here holds exactly the role you choose and nothing more, and you cannot grant
              a role carrying more than your own. Only the owner can accept agreements, and the
              owner cannot be removed or have their role changed from this screen — that is what
              stops an administrator making themselves one.
            </p>
          )}
        </Card>
      )}

      {isAdding && (
        <AddLocationDialog
          onClose={() => {
            setIsAdding(false);
          }}
        />
      )}

      {removing !== null && (
        <RemoveMemberDialog
          member={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}

      {editing !== null && (
        <EditLocationDialog
          location={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}

      {closing !== null && (
        <CloseLocationDialog
          location={closing}
          onClose={() => {
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Correct an address that is already in use.
 *
 * Only the fields a seller genuinely changes after the fact: the name people
 * read it by, the cut-off, the handling time, and what it is for. The code is
 * not editable — it appears on stock movements and pick lists already printed,
 * and changing it would silently rename history.
 */
function EditLocationDialog({
  location,
  onClose,
}: {
  location: SellerLocation;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [form, setForm] = useState({
    name: location.name,
    dispatchCutoff: location.dispatchCutoff ?? '17:00',
    handlingTimeDays: String(location.handlingTimeDays),
    isPickupLocation: location.isPickupLocation,
    isReturnLocation: location.isReturnLocation,
  });

  const mutation = useMutation({
    mutationFn: () =>
      updateLocation(location.id, {
        name: form.name.trim(),
        dispatchCutoff: form.dispatchCutoff,
        handlingTimeDays: Number(form.handlingTimeDays),
        isPickupLocation: form.isPickupLocation,
        isReturnLocation: form.isReturnLocation,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'locations'] });
      toast.success('Address updated.');
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That address could not be saved.'));
    },
  });

  return (
    <Modal isOpen title={`Edit ${location.code}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name" hint="What your team calls it. Buyers never see this.">
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.name}
              onChange={(event) => {
                setForm((previous) => ({ ...previous, name: event.currentTarget.value }));
              }}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Dispatch cut-off"
            hint={`Local time at this address (${location.timezone}).`}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="time"
                value={form.dispatchCutoff}
                onChange={(event) => {
                  setForm((previous) => ({
                    ...previous,
                    dispatchCutoff: event.currentTarget.value,
                  }));
                }}
              />
            )}
          </Field>

          <Field label="Working days to pick" hint="0 means you dispatch the same day.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="number"
                min={0}
                max={30}
                value={form.handlingTimeDays}
                onChange={(event) => {
                  setForm((previous) => ({
                    ...previous,
                    handlingTimeDays: event.currentTarget.value,
                  }));
                }}
              />
            )}
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">What is it used for?</legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.isPickupLocation}
              onChange={(event) => {
                setForm((previous) => ({
                  ...previous,
                  isPickupLocation: event.currentTarget.checked,
                }));
              }}
            />
            Orders are dispatched from here
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.isReturnLocation}
              onChange={(event) => {
                setForm((previous) => ({
                  ...previous,
                  isReturnLocation: event.currentTarget.checked,
                }));
              }}
            />
            Returns come back here
          </label>
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={form.name.trim().length === 0}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CloseLocationDialog({
  location,
  onClose,
}: {
  location: SellerLocation;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => archiveLocation(location.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'locations'] });
      await client.invalidateQueries({ queryKey: ['seller', 'inventory'] });
      toast.success(`${location.name} is closed.`);
      onClose();
    },
    onError: (error: unknown) => {
      // The server refuses while orders are still being dispatched from it, and
      // says which. That sentence is the useful one.
      toast.error(errorMessage(t, error, 'That address could not be closed.'));
    },
  });

  return (
    <Modal isOpen title={`Close ${location.name}?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          No new order can be dispatched from here and it stops being offered when you accept one.
          Nothing is deleted: the stock it holds, the movements against it and every order it has
          already shipped stay exactly as they are.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Keep it open</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Close it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Take somebody off the account.
 *
 * Asked for by name, because the list is alphabetical-ish and two rows apart is
 * all it takes to remove the wrong person. What it does is stated rather than
 * implied: their access stops, and what they already did stays on the record —
 * removing a person must never quietly rewrite the audit trail.
 */
function RemoveMemberDialog({
  member,
  onClose,
}: {
  member: TeamMember;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => removeMember(member.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'members'] });
      toast.success(`${member.name} no longer has access.`);
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That person could not be removed.'));
    },
  });

  return (
    <Modal isOpen title={`Remove ${member.name}?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          They lose access to this seller account straight away. Everything they have already done —
          listings, orders, decisions — stays exactly as it is, with their name on it.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Keep them</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Remove
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The mark on your own shop front.
 *
 * Only meaningful where this deployment gives sellers their own web address, so
 * the panel says where the logo actually appears rather than leaving a seller to
 * guess. Without one their shop shows their initial, which is a working shop
 * rather than a broken one — so this is an improvement to offer, never a task to
 * nag about.
 *
 * The preview is the real file at the real size the header renders it, because
 * a logo that looks right at 200px and illegible at 40 is the mistake this
 * panel exists to catch before a buyer does.
 */
function ShopLogoCard({
  logoUrl,
  displayName,
  canManage,
}: {
  logoUrl: string | null;
  displayName: string;
  canManage: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => uploadSellerLogo(file),
    onSuccess: async () => {
      setError(null);
      await client.invalidateQueries({ queryKey: ['seller', 'business-profile'] });
      toast.success('Your logo is up.');
    },
    onError: (cause: unknown) => {
      // The server names the rule that was broken — too large, or a file type
      // it will not serve inline. Replacing that with "upload failed" throws
      // away the only thing that says what to change.
      setError(errorMessage(t, cause, 'That logo could not be uploaded.'));
    },
  });

  const remove = useMutation({
    mutationFn: removeSellerLogo,
    onSuccess: async () => {
      setError(null);
      await client.invalidateQueries({ queryKey: ['seller', 'business-profile'] });
      toast.success('Logo removed. Your shop shows your initial again.');
    },
    onError: (cause: unknown) => {
      setError(errorMessage(t, cause, 'That logo could not be removed.'));
    },
  });

  const isBusy = upload.isPending || remove.isPending;

  return (
    <Card
      title="Your shop logo"
      description="Shown at the top of your own shop front, beside your name."
    >
      <div className="flex flex-wrap items-start gap-5 px-6 py-5">
        {/*
          Forty pixels, which is exactly what the shop header renders. A larger
          preview would hide the only problem worth catching here.
        */}
        {logoUrl === null ? (
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-fill text-base font-semibold text-white"
          >
            {displayName.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img
            src={logoUrl}
            alt={`${displayName} logo`}
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-md border border-border bg-surface-media object-contain p-1"
          />
        )}

        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm leading-relaxed text-ink-muted">
            {logoUrl === null
              ? 'You have not added one. Your shop shows the first letter of your name until you do.'
              : 'This is how it appears in your shop header.'}
          </p>

          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-md border border-border-strong bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-hover">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={isBusy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    // Cleared so choosing the same file twice fires again —
                    // which is what somebody does after cropping and re-saving.
                    event.currentTarget.value = '';
                    if (file !== undefined) upload.mutate(file);
                  }}
                />
                {logoUrl === null ? 'Add a logo' : 'Replace it'}
              </label>

              {logoUrl !== null && (
                <Button
                  disabled={isBusy}
                  onClick={() => {
                    remove.mutate();
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          )}

          <p className="text-xxs leading-relaxed text-ink-subtle">
            PNG, JPEG or WebP. A square image on a transparent or white
            background reads best at this size.
          </p>

          {error !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * One labelled fact. sentenceCase is opt-in - capitalising every value turns
 * an email address into one that does not exist.
 */
function Detail({
  label,
  value,
  sentenceCase = false,
}: {
  label: string;
  value: string | null;
  sentenceCase?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={cx('mt-1 text-sm text-ink', sentenceCase && 'first-letter:uppercase')}>
        {value === null || value.length === 0 ? (
          <span className="text-ink-subtle">Not given</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function LocationRow({
  location,
  canManage,
  onEdit,
  onClose,
}: {
  location: SellerLocation;
  canManage: boolean;
  onEdit: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {location.name} <span className="font-normal text-ink-subtle">({location.code})</span>
        </p>
        <p className="mt-0.5 text-xxs text-ink-muted">
          {location.addressLine1}, {location.city} {location.postcode}, {location.countryCode}
        </p>
        <p className="mt-1 text-xxs text-ink-subtle">
          {location.dispatchCutoff === null
            ? 'No dispatch cut-off set'
            : `Cut-off ${location.dispatchCutoff} ${location.timezone}`}
          {' · '}
          {location.handlingTimeDays === 0
            ? 'same-day handling'
            : `${location.handlingTimeDays} working ${location.handlingTimeDays === 1 ? 'day' : 'days'} to pick`}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {location.isPickupLocation && <Badge tone="success">Dispatches</Badge>}
        {location.isReturnLocation && <Badge tone="brand">Takes returns</Badge>}
        {location.hasColdChain && <Badge tone="operational">Cold chain</Badge>}
        {!location.isOperational && <Badge tone="danger">Closed</Badge>}

        {canManage && (
          <>
            <Button onClick={onEdit}>Edit</Button>
            {/*
              "Close", not "delete". Stock movements, orders and settlements all
              point at a location, so it is archived rather than removed — and
              calling that "delete" would promise the seller something the data
              cannot do.
            */}
            {location.isOperational && <Button onClick={onClose}>Close</Button>}
          </>
        )}
      </div>
    </div>
  );
}

function RoleSelect({ memberId, current }: { memberId: string; current: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: (role: string) => changeMemberRole(memberId, role),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'members'] });
      toast.success('Role updated.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That role could not be changed.'));
    },
  });

  return (
    <Select
      aria-label="Role"
      className="h-8 w-44 text-xs"
      value={current}
      disabled={mutation.isPending}
      onChange={(event) => {
        mutation.mutate(event.currentTarget.value);
      }}
    >
      {Object.entries(ROLE_LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Select>
  );
}

function AddLocationDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { localisation } = useStorefront();

  const [form, setForm] = useState({
    code: '',
    name: '',
    addressLine1: '',
    city: '',
    postcode: '',
    countryCode: '',
    dispatchCutoff: '17:00',
    handlingTimeDays: '1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  const set = (key: keyof typeof form, value: string): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const mutation = useMutation({
    mutationFn: () =>
      createLocation({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        addressLine1: form.addressLine1.trim(),
        city: form.city.trim(),
        postcode: form.postcode.trim(),
        countryCode: form.countryCode,
        dispatchCutoff: form.dispatchCutoff,
        handlingTimeDays: Number(form.handlingTimeDays),
        timezone: form.timezone,
        isPickupLocation: true,
        isReturnLocation: true,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'locations'] });
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      toast.success('Address added.');
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That address could not be saved.'));
    },
  });

  const canSubmit =
    form.code.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.addressLine1.trim().length > 0 &&
    form.city.trim().length > 0 &&
    form.postcode.trim().length > 0 &&
    form.countryCode.length === 2;

  return (
    <Modal isOpen title="Add an address" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Short code"
            hint="Yours. It appears on every stock movement, so it cannot be reused."
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={form.code}
                placeholder="ANT-1"
                onChange={(event) => {
                  set('code', event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Name" required>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={form.name}
                placeholder="Antwerp warehouse"
                onChange={(event) => {
                  set('name', event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>

        <Field label="Address" required>
          {({ inputId }) => (
            <Input
              id={inputId}
              value={form.addressLine1}
              onChange={(event) => {
                set('addressLine1', event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City" required>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={form.city}
                onChange={(event) => {
                  set('city', event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Postcode" required>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={form.postcode}
                onChange={(event) => {
                  set('postcode', event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Country" required>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={form.countryCode}
                onChange={(event) => {
                  set('countryCode', event.currentTarget.value);
                }}
              >
                <option value="">Choose</option>
                {localisation.countries.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Dispatch cut-off"
            hint="Local time at this address. Orders after it ship the next working day."
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="time"
                value={form.dispatchCutoff}
                onChange={(event) => {
                  set('dispatchCutoff', event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Working days to pick an order">
            {({ inputId }) => (
              <Input
                id={inputId}
                type="number"
                min={0}
                max={30}
                value={form.handlingTimeDays}
                onChange={(event) => {
                  set('handlingTimeDays', event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Add address
          </Button>
        </div>
      </div>
    </Modal>
  );
}
