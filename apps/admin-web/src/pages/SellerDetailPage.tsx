/**
 * One seller application, and the decision about it.
 *
 * This is the screen the whole review process exists for: everything the
 * business told us, everything it uploaded, and what it has accepted — laid
 * out so a reviewer can answer "is this a real business that may sell here"
 * without opening four other screens.
 *
 * Three things it is careful about:
 *
 *   - **The seller-visible reason and the internal note are different boxes**,
 *     labelled as such. Only the first reaches the seller. Collapsing them is
 *     how a private assessment ends up in front of the business it was about.
 *   - **Every refusal demands a reason**, because the state machine does. The
 *     button is disabled until one is typed rather than failing afterwards.
 *   - **The decision carries the version it was made against.** Two reviewers
 *     with the same application open is a real case, and the second one
 *     silently overwriting the first is how a rejection becomes an approval
 *     nobody made.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Textarea,
} from '@/components/ui';
import { cx } from '@/lib/cx';
import { ApiError, api } from '@/lib/api';
import {
  ONBOARDING_STEPS,
  applicationStatusLabel,
  applicationStatusTone,
  decideSellerApplication,
  documentKindLabel,
  fetchSellerApplication,
  setSellerCommission,
  type SellerApplicationDetail,
  type SellerDecision,
} from '@/lib/sellers';

type DecisionKind = SellerDecision['status'];

const DECISION_COPY: Record<
  DecisionKind,
  { title: string; verb: string; needsReason: boolean; tone: 'primary' | 'danger' | 'secondary' }
> = {
  UNDER_REVIEW: {
    title: 'Start reviewing this application',
    verb: 'Take it on',
    needsReason: false,
    tone: 'secondary',
  },
  APPROVED: {
    title: 'Approve this seller',
    verb: 'Approve',
    needsReason: false,
    tone: 'primary',
  },
  ACTION_REQUIRED: {
    title: 'Send this application back',
    verb: 'Send back',
    needsReason: true,
    tone: 'secondary',
  },
  REJECTED: {
    title: 'Reject this application',
    verb: 'Reject',
    needsReason: true,
    tone: 'danger',
  },
  SUSPENDED: {
    title: 'Suspend this seller',
    verb: 'Suspend',
    needsReason: true,
    tone: 'danger',
  },
};

export function SellerDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const [deciding, setDeciding] = useState<DecisionKind | null>(null);

  const query = useQuery({
    queryKey: ['admin', 'seller', id],
    queryFn: () => fetchSellerApplication(id),
    enabled: id.length > 0,
  });

  const seller = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={seller?.displayName ?? 'Seller application'}
        description={seller === undefined ? undefined : seller.legalName}
        back={{ to: '/sellers', label: 'Sellers' }}
        actions={
          seller === undefined ? undefined : (
            <DecisionButtons
              status={seller.status}
              onChoose={(next) => {
                setDeciding(next);
              }}
            />
          )
        }
      />

      {query.isPending && <Card><div className="px-5 py-8 text-sm text-ink-muted">Loading…</div></Card>}

      {query.isError && (
        <Callout tone="danger" title="This application could not be loaded" role="alert">
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            Try again
          </Button>
        </Callout>
      )}

      {seller !== undefined && <ApplicationBody seller={seller} />}

      {deciding !== null && seller !== undefined && (
        <DecisionDialog
          seller={seller}
          decision={deciding}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * What a reviewer may do from here.
 *
 * Only the transitions the state machine actually allows from this status. A
 * button that fails on press teaches a reviewer to distrust the screen; the
 * server refuses these anyway, and this is so they are never offered.
 */
function DecisionButtons({
  status,
  onChoose,
}: {
  status: SellerApplicationDetail['status'];
  onChoose: (decision: DecisionKind) => void;
}): React.JSX.Element | null {
  const available: DecisionKind[] =
    status === 'SUBMITTED'
      ? ['UNDER_REVIEW', 'APPROVED', 'ACTION_REQUIRED', 'REJECTED']
      : status === 'UNDER_REVIEW'
        ? ['APPROVED', 'ACTION_REQUIRED', 'REJECTED']
        : status === 'ACTION_REQUIRED'
          ? ['REJECTED']
          : status === 'APPROVED'
            ? ['SUSPENDED', 'ACTION_REQUIRED']
            : status === 'SUSPENDED'
              ? ['APPROVED', 'ACTION_REQUIRED', 'REJECTED']
              : status === 'REJECTED'
                ? ['ACTION_REQUIRED']
                : [];

  if (available.length === 0) {
    return (
      <span className="text-xs text-ink-subtle">
        This seller has not sent their application in yet.
      </span>
    );
  }

  return (
    <>
      {available.map((decision) => (
        <Button
          key={decision}
          variant={DECISION_COPY[decision].tone}
          onClick={() => {
            onChoose(decision);
          }}
        >
          {DECISION_COPY[decision].verb}
        </Button>
      ))}
    </>
  );
}

function ApplicationBody({ seller }: { seller: SellerApplicationDetail }): React.JSX.Element {
  const profile = seller.businessProfile;
  const steps = seller.onboarding?.stepsJson ?? {};

  const [editingCommission, setEditingCommission] = useState(false);

  /*
   * What "standard" currently means, for the sentence beside the rate.
   *
   * The same query key the Settings page uses, so a rate changed there and a
   * seller opened here do not disagree. It is allowed to fail quietly: a
   * seller's own rate is readable without it, and a card that refuses to
   * render because a second request failed is worse than one that says
   * "set under Settings".
   */
  const platform = useQuery({
    queryKey: ['business-profile'],
    queryFn: () =>
      api.get<{ business: { sellerCommissionBasisPoints: number } }>('/admin/settings/business'),
  });

  const platformRate = platform.data?.business.sellerCommissionBasisPoints ?? null;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <div className="space-y-5">
        {/* Why it is in the state it is in, if somebody said. */}
        {seller.statusReason !== null && seller.statusReason.length > 0 && (
          <Callout
            tone={seller.status === 'APPROVED' ? 'success' : 'warning'}
            title="What the seller was told"
          >
            <p className="whitespace-pre-line text-sm">{seller.statusReason}</p>
          </Callout>
        )}

        <Card title="The business" description="What they told us, and what they are registered as.">
          <dl className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2">
            <Detail label="Registered name" value={seller.legalName} />
            <Detail label="Trading name" value={seller.displayName} />
            <Detail
              label="Seller type"
              value={seller.kind.replace(/_/g, ' ').toLowerCase()}
              sentenceCase
            />
            <Detail label="Registered in" value={seller.registrationCountry} />
            <Detail
              label="Company registration number"
              value={profile?.companyRegistrationNumber ?? null}
            />
            <Detail label="Tax registration" value={profile?.taxRegistrationNumber ?? null} />
            <Detail label="EORI" value={profile?.eoriNumber ?? null} />
            <Detail label="EUDAMED SRN" value={profile?.eudamedSrn ?? null} />
            <Detail label="Website" value={profile?.websiteUrl ?? null} />
            <Detail
              label="Years in business"
              value={profile?.yearsInBusiness === null || profile?.yearsInBusiness === undefined ? null : String(profile.yearsInBusiness)}
            />
            <Detail
              label="Registered address"
              value={
                profile === null || profile.registeredAddressLine1 === null
                  ? null
                  : [
                      profile.registeredAddressLine1,
                      profile.registeredAddressLine2,
                      profile.registeredCity,
                      profile.registeredPostcode,
                      profile.registeredCountry,
                    ]
                      .filter((part) => part !== null && part.length > 0)
                      .join(', ')
              }
            />
            <Detail label="What they sell" value={seller.description} />
          </dl>

          {/*
            Country-specific identifiers the application asked for. They are
            stored by the key of the requirement that asked, because which ones
            exist is configuration - a GSTIN here, a PAN there - and a column
            per country would be wrong the first time somebody sold in a new
            one.
          */}
          {profile?.extraIdentifiersJson !== null &&
            profile?.extraIdentifiersJson !== undefined &&
            Object.keys(profile.extraIdentifiersJson).length > 0 && (
              <div className="border-t border-border-subtle px-5 py-4">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  Country-specific identifiers
                </h3>
                <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
                  {Object.entries(profile.extraIdentifiersJson).map(([key, value]) => (
                    <Detail key={key} label={key.replace(/_/g, ' ')} value={value} />
                  ))}
                </dl>
              </div>
            )}
        </Card>

        <Card
          title="Who represents it"
          description="The person who can sign for the business, and how buyers reach their support desk."
        >
          <dl className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2">
            <Detail label="Representative" value={profile?.representativeName ?? null} />
            <Detail label="Their role" value={profile?.representativeRole ?? null} />
            <Detail label="Email" value={profile?.representativeEmail ?? null} />
            <Detail label="Phone" value={profile?.representativePhone ?? null} />
            <Detail label="Support email" value={profile?.supportEmail ?? null} />
            <Detail label="Support phone" value={profile?.supportPhone ?? null} />
          </dl>

          {seller.members.length > 0 && (
            <div className="border-t border-border-subtle px-5 py-4">
              <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Who can use this seller account
              </h3>
              <ul className="mt-3 space-y-2">
                {seller.members.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">
                        {member.customerProfile.fullName}
                      </span>
                      <span className="block truncate text-xxs text-ink-subtle">
                        {member.customerProfile.user.email}
                      </span>
                    </span>
                    <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>
                      {member.role.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Documents"
          description="What they uploaded as evidence. Check each one before approving."
        >
          {seller.documents.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">
              Nothing has been uploaded yet. Document upload needs encrypted object storage to be
              configured for this deployment — until then, evidence arrives by other means and is
              attached by the marketplace team.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {seller.documents.map((document) => (
                <li key={document.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {documentKindLabel(document.kind)}
                    </p>
                    <p className="truncate text-xxs text-ink-subtle">
                      {document.originalFileName} · {Math.round(document.byteSize / 1024)} KB
                      {document.expiresOn !== null && ` · expires ${document.expiresOn}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {/*
                      The scan state is shown rather than hidden. An unscanned
                      file is not a clean file, and a reviewer opening one
                      should know which they are dealing with.
                    */}
                    <Badge
                      tone={
                        document.scanState === 'CLEAN'
                          ? 'success'
                          : document.scanState === 'INFECTED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {document.scanState.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                    {document.approvedAt !== null && <Badge tone="success">accepted</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Where they ship from"
          description="At least one address must be able to dispatch orders and take returns."
        >
          {seller.locations.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">No address has been added yet.</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {seller.locations.map((location) => (
                <li key={location.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {location.name}{' '}
                      <span className="font-normal text-ink-subtle">({location.code})</span>
                    </p>
                    <div className="flex gap-1.5">
                      {location.isPickupLocation && <Badge tone="success">dispatches</Badge>}
                      {location.isReturnLocation && <Badge tone="brand">takes returns</Badge>}
                      {!location.isOperational && <Badge tone="danger">closed</Badge>}
                    </div>
                  </div>
                  <p className="mt-0.5 text-xxs text-ink-muted">
                    {location.addressLine1}, {location.city} {location.postcode},{' '}
                    {location.countryCode}
                    {location.dispatchCutoff !== null && ` · cut-off ${location.dispatchCutoff}`}
                    {` · ${String(location.handlingTimeDays)} working day(s) to pick`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="What they have accepted"
          description="Each acceptance is recorded with its policy version, the time and the address it came from."
        >
          {seller.agreements.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">
              No agreement has been accepted yet.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {seller.agreements.map((agreement) => (
                <li key={agreement.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">
                      {agreement.kind.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="truncate text-xxs text-ink-subtle">
                      version {agreement.version} · accepted by {agreement.acceptedName ?? 'unknown'}
                      {' · '}
                      {new Date(agreement.acceptedAt).toLocaleString()}
                      {agreement.ipAddress !== null && ` · from ${agreement.ipAddress}`}
                    </p>
                  </div>
                  {/*
                    Named for what it is. A drawn signature is DRAWN_CONSENT and
                    is not a verified electronic signature - see the note on
                    `SellerConsentMethod`. A reviewer relying on it later needs
                    to know which it was.
                  */}
                  <Badge tone={agreement.method === 'QUALIFIED_ESIGNATURE' ? 'success' : 'neutral'}>
                    {agreement.method.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ---- The side column: state, progress, checks, private notes ------ */}
      <div className="space-y-5">
        <Card title="Where it stands">
          <div className="space-y-3 px-5 py-4">
            <Badge tone={applicationStatusTone(seller.status)}>
              {applicationStatusLabel(seller.status)}
            </Badge>

            <dl className="space-y-2 text-xs">
              <TimeRow label="Started" value={seller.createdAt} />
              <TimeRow label="Submitted" value={seller.submittedAt} />
              <TimeRow label="Picked up" value={seller.reviewedAt} />
              <TimeRow label="Approved" value={seller.approvedAt} />
              <TimeRow label="Suspended" value={seller.suspendedAt} />
            </dl>

            {seller.status === 'REJECTED' && (
              <p className="text-xxs text-ink-muted">
                {seller.resubmissionAllowed
                  ? 'They may be reopened and try again.'
                  : 'Resubmission was closed. Reopening is the only way back.'}
              </p>
            )}
          </div>
        </Card>

        <Card title="Application progress">
          <ul className="divide-y divide-border-subtle">
            {ONBOARDING_STEPS.map((step) => {
              const state = steps[step.key]?.state ?? 'NOT_STARTED';
              const message = steps[step.key]?.message ?? null;

              return (
                <li key={step.key} className="px-5 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink">{step.title}</span>
                    <span
                      className={cx(
                        'shrink-0 text-xxs font-medium',
                        state === 'COMPLETE'
                          ? 'text-success'
                          : state === 'ERROR'
                            ? 'text-danger'
                            : state === 'IN_PROGRESS'
                              ? 'text-warning'
                              : 'text-ink-subtle',
                      )}
                    >
                      {state.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </div>
                  {message !== null && message.length > 0 && (
                    <p className="mt-0.5 text-xxs text-ink-subtle">{message}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Checks">
          {seller.verificationCases.length === 0 ? (
            <p className="px-5 py-4 text-xs text-ink-muted">
              No automated check has been attempted. This deployment has no verification provider
              configured, so business, tax and bank checks are a human decision — which is what
              this screen is for.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {seller.verificationCases.map((check) => (
                <li key={check.id} className="px-5 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink">
                      {check.kind.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <Badge
                      tone={
                        check.state === 'VERIFIED'
                          ? 'success'
                          : check.state === 'FAILED'
                            ? 'danger'
                            : check.state === 'PROVIDER_UNCONFIGURED'
                              ? 'neutral'
                              : 'warning'
                      }
                    >
                      {check.state.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  </div>
                  {check.failureReason !== null && (
                    <p className="mt-0.5 text-xxs text-ink-muted">{check.failureReason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Payout account">
          <div className="px-5 py-4 text-xs">
            {seller.payoutAccount === null ||
            seller.payoutAccount.state === 'PROVIDER_UNCONFIGURED' ? (
              <p className="text-ink-muted">
                No payout provider is configured for this marketplace, so nothing has been
                connected. This does not block approval — earnings are recorded either way.
              </p>
            ) : (
              <dl className="space-y-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">State</dt>
                  <dd className="text-ink">
                    {seller.payoutAccount.state.replace(/_/g, ' ').toLowerCase()}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">Account</dt>
                  <dd className="text-ink">
                    {seller.payoutAccount.bankName ?? '—'}
                    {seller.payoutAccount.accountLast4 !== null &&
                      ` ···· ${seller.payoutAccount.accountLast4}`}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        {/*
          The operator's own notes. Marked plainly as not seller-visible,
          because the whole point of keeping them in a separate column is that
          somebody writing here believes that.
        */}
        <Card title="Commission">
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm text-ink">
              {seller.commissionBasisPoints === null
                ? 'Marketplace standard rate'
                : `Own rate: ${percentOf(seller.commissionBasisPoints)}`}
            </p>

            {/*
              Said in full rather than assumed. An operator looking at a seller
              wants to know what this business is charged, and "standard" is
              only half an answer without the figure standard currently means.
            */}
            <p className="text-xxs leading-relaxed text-ink-muted">
              {seller.commissionBasisPoints === null
                ? `They are charged whatever the marketplace charges, which is ${
                    platformRate === null ? 'set under Settings' : percentOf(platformRate)
                  } today, and they follow it when it changes.`
                : 'This rate is theirs. It does not move when the marketplace standard rate does.'}
            </p>

            <Button
              size="sm"
              onClick={() => {
                setEditingCommission(true);
              }}
            >
              Change
            </Button>
          </div>
        </Card>

        {editingCommission && (
          <CommissionDialog
            seller={seller}
            platformRate={platformRate}
            onClose={() => {
              setEditingCommission(false);
            }}
          />
        )}

        <Card title="Internal notes" tone="danger">
          <div className="px-5 py-4">
            <p className="text-xxs font-medium text-danger">The seller never sees this.</p>
            <p className="mt-2 whitespace-pre-line text-xs text-ink-muted">
              {seller.internalNotes === null || seller.internalNotes.length === 0
                ? 'Nothing recorded. Add one with your next decision.'
                : seller.internalNotes}
            </p>
          </div>
        </Card>

        <Card title="Their catalogue">
          <div className="space-y-2 px-5 py-4 text-xs">
            <Link to={`/products?seller=${seller.id}`} className="block text-brand hover:underline">
              Products this seller created →
            </Link>
            <Link to="/brand-requests" className="block text-brand hover:underline">
              Brand requests waiting for a decision →
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * One labelled fact.
 *
 * sentenceCase is opt-in rather than the default. Capitalising the first
 * letter of everything turned 'anke@northwind.example' into
 * 'Anke@northwind.example' - an address that does not exist, printed on the
 * screen a reviewer checks an address against.
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
      <dd
        className={cx(
          'mt-1 break-words text-sm text-ink',
          sentenceCase && 'first-letter:uppercase',
        )}
      >
        {value === null || value.length === 0 ? (
          <span className="text-ink-subtle">Not given</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function TimeRow({ label, value }: { label: string; value: string | null }): React.JSX.Element | null {
  if (value === null) return null;

  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">{new Date(value).toLocaleString()}</dd>
    </div>
  );
}

/** "2.50%" from 250. Two decimals, because 12.5% is not 13%. */
function percentOf(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

/**
 * Putting one seller on their own rate, or back on the marketplace's.
 *
 * Two choices rather than a box that can be emptied, because "no rate" and "a
 * rate of zero" are different promises and a blank field does not say which
 * was meant. Null follows the standard rate wherever it goes; zero is a
 * decision to take nothing from this seller and stays at nothing.
 *
 * Nothing already sold moves either way — each seller's share of an order
 * carries the rate that applied when it was confirmed — and the dialog says so,
 * because the question "does this fix last month's statement" is the first one
 * anybody asks.
 */
function CommissionDialog({
  seller,
  platformRate,
  onClose,
}: {
  seller: SellerApplicationDetail;
  platformRate: number | null;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const client = useQueryClient();

  const [ownRate, setOwnRate] = useState(seller.commissionBasisPoints !== null);
  const [percent, setPercent] = useState(
    seller.commissionBasisPoints === null ? '' : String(Number((seller.commissionBasisPoints / 100).toFixed(2))),
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (basisPoints: number | null) => setSellerCommission(seller.id, basisPoints),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'seller', seller.id] });
      toast.success(`${seller.displayName} — commission updated.`);
      onClose();
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'That commission rate could not be saved.',
      );
    },
  });

  const submit = (): void => {
    if (!ownRate) {
      void mutation.mutateAsync(null);
      return;
    }

    const parsed = Number(percent.trim().replace('%', ''));

    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100 || percent.trim().length === 0) {
      setError('Enter a rate between 0 and 100.');
      return;
    }

    void mutation.mutateAsync(Math.round(parsed * 100));
  };

  return (
    <Modal isOpen title={`Commission — ${seller.displayName}`} onClose={onClose}>
      <div className="space-y-4">
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        <fieldset className="space-y-2">
          <legend className="sr-only">Which rate applies to this seller</legend>

          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="radio"
              name="commission-kind"
              // Named here as well as beside it: the visible label carries a
              // second line of explanation, and a screen reader announcing the
              // whole paragraph as the choice is worse than a short answer.
              aria-label="The marketplace standard rate"
              className="mt-1 h-4 w-4 shrink-0"
              checked={!ownRate}
              onChange={() => {
                setError(null);
                setOwnRate(false);
              }}
            />
            <span>
              The marketplace standard rate
              <span className="mt-0.5 block text-xxs text-ink-muted">
                {platformRate === null
                  ? 'Whatever is set under Settings, now and when it changes.'
                  : `${percentOf(platformRate)} today, and it follows that figure when it changes.`}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="radio"
              name="commission-kind"
              aria-label="A rate of their own"
              className="mt-1 h-4 w-4 shrink-0"
              checked={ownRate}
              onChange={() => {
                setError(null);
                setOwnRate(true);
              }}
            />
            <span>
              A rate of their own
              <span className="mt-0.5 block text-xxs text-ink-muted">
                Stays where it is put, whatever the standard rate does afterwards.
              </span>
            </span>
          </label>
        </fieldset>

        {ownRate && (
          <Field label="Their rate (%)" hint="Between 0 and 100. Type 2.5 for two and a half per cent.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={percent}
                onChange={(event) => {
                  setError(null);
                  setPercent(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        <Callout tone="neutral">
          The seller is told. Orders already confirmed keep the rate that applied to them, so no
          statement they have already been sent can move.
        </Callout>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={mutation.isPending} onClick={submit}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DecisionDialog({
  seller,
  decision,
  onClose,
}: {
  seller: SellerApplicationDetail;
  decision: DecisionKind;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const client = useQueryClient();

  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [allowResubmission, setAllowResubmission] = useState(true);

  const copy = DECISION_COPY[decision];

  const mutation = useMutation({
    mutationFn: () =>
      decideSellerApplication(seller.id, {
        status: decision,
        reason: reason.trim().length === 0 ? null : reason.trim(),
        internalNote: note.trim().length === 0 ? null : note.trim(),
        ...(decision === 'REJECTED' ? { resubmissionAllowed: allowResubmission } : {}),
        // The version this decision was made against. If somebody else decided
        // meanwhile, the server refuses rather than overwriting them.
        expectedVersion: seller.version,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'seller', seller.id] });
      await client.invalidateQueries({ queryKey: ['admin', 'sellers'] });
      toast.success(`${seller.displayName} — ${copy.verb.toLowerCase()}d.`);
      onClose();
    },
    onError: (error: unknown) => {
      // The server's own sentence where there is one - it knows why it
      // refused, and a stale-version conflict in particular needs to say so.
      toast.error(
        error instanceof ApiError ? error.message : 'That decision could not be recorded.',
      );
    },
  });

  const canSubmit = !copy.needsReason || reason.trim().length > 0;

  return (
    <Modal isOpen title={copy.title} onClose={onClose}>
      <div className="space-y-4">
        {decision === 'APPROVED' && (
          <Callout tone="success" title="What approving does">
            <p className="text-sm">
              {seller.displayName} will be able to create listings immediately. Nothing they list
              goes on sale until it has been through quality review, and their first listing will
              appear in that queue.
            </p>
          </Callout>
        )}

        {decision === 'SUSPENDED' && (
          <Callout tone="warning" title="What suspending does">
            <p className="text-sm">
              New listings and new orders stop at once. Orders they have already accepted still
              need fulfilling, and money already owed is still owed.
            </p>
          </Callout>
        )}

        <Field
          label={copy.needsReason ? 'What should the seller be told?' : 'Anything to tell the seller?'}
          hint="This goes on their screen and into their own record. Write it for them."
          required={copy.needsReason}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={4}
              value={reason}
              placeholder={
                decision === 'ACTION_REQUIRED'
                  ? 'The registration document is for a different company name. Please upload the one matching Acme Supplies Ltd.'
                  : ''
              }
              onChange={(event) => {
                setReason(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Internal note"
          hint="Only staff see this. It is never sent to the seller or shown on their screen."
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={3}
              value={note}
              onChange={(event) => {
                setNote(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        {decision === 'REJECTED' && (
          <CheckboxField
            label="They may apply again"
            description="Leave this on unless you want the door closed. A closed application can only be reopened by staff."
            checked={allowResubmission}
            onChange={(event) => {
              setAllowResubmission(event.currentTarget.checked);
            }}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={copy.tone}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {copy.verb}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
