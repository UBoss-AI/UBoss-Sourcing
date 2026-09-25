/**
 * My Profile - the signed-in logistics company's own record.
 *
 * ONE FORM, EIGHT TABS
 *
 * Every editable field on every tab belongs to one draft, so switching tabs
 * never loses what was typed and one Save sends everything. The save bar
 * appears the moment the draft differs from what the server holds, and
 * leaving the page with a dirty draft asks first - both inside the app (the
 * router's blocker) and when the tab itself is closed (`beforeunload`).
 *
 * FOUR KINDS OF FIELD, SHOWN AS FOUR KINDS
 *
 *   - editable: an ordinary input;
 *   - re-verified: an input with a "checked by {{team}}" badge - saving sends
 *     it for approval and the live record keeps its old value until then;
 *   - set by {{team}}: shown as text with a lock, never as a disabled input
 *     (a disabled input invites the question "why can't I type here?");
 *   - system: the id, dates and counts, shown as text.
 *
 * The server enforces every one of these again. What this page adds is
 * saying so before the person has typed into something that will not save.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBlocker, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  DescriptionList,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
  type BadgeTone,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { HoverCardGrid, type HoverCard } from '@/components/profile/HoverCardGrid';
import { ProfileHero } from '@/components/profile/ProfileHero';
import { ProfileTabs } from '@/components/profile/ProfileTabs';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { capabilityKindLabel } from '@/lib/shipment-display';
import {
  COMPLIANCE_KINDS,
  DECLARABLE_MODES,
  WEEKDAYS,
  diffDraft,
  downloadComplianceDocument,
  draftFromProfile,
  fetchProfile,
  isReverified,
  problemKeyFor,
  profileKey,
  removeLogo,
  saveProfile,
  timeZones,
  uploadComplianceDocument,
  uploadLogo,
  validateDraft,
  withdrawPendingChange,
  type AddressDraft,
  type ComplianceKind,
  type ComplianceStatus,
  type FieldProblem,
  type IntegrationStatus,
  type LogisticsProfile,
  type ProfileDraft,
  type ProfileSaveResult,
} from '@/lib/profile';

type TabKey =
  | 'overview'
  | 'company'
  | 'contacts'
  | 'coverage'
  | 'capabilities'
  | 'compliance'
  | 'integrations'
  | 'account';

const TAB_KEYS: readonly TabKey[] = [
  'overview',
  'company',
  'contacts',
  'coverage',
  'capabilities',
  'compliance',
  'integrations',
  'account',
];

function isTab(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

/** Which tab a missing item or a failing field is fixed on. */
function tabForField(field: string): TabKey {
  const head = field.split('.')[0] ?? field;
  if (head === 'logo') return 'overview';
  if (
    [
      'legalName',
      'displayName',
      'registrationNumber',
      'taxNumber',
      'registrationCountry',
      'registeredAddress',
      'operationalAddress',
      'websiteUrl',
      'businessDescription',
    ].includes(head)
  ) {
    return 'company';
  }
  if (head === 'hubLocations') return 'coverage';
  if (['operatingHours', 'timeZone', 'declaredTransportModes'].includes(head)) return 'capabilities';
  if (['licenceNumber', 'licenceExpiresAt', 'document'].includes(head)) return 'compliance';
  return 'contacts';
}

const COMPLIANCE_TONE: Record<ComplianceStatus, BadgeTone> = {
  MISSING: 'neutral',
  PENDING_REVIEW: 'accent',
  VERIFIED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

const INTEGRATION_TONE: Record<IntegrationStatus, BadgeTone> = {
  CONNECTED: 'success',
  ACTIVE: 'success',
  CONFIGURED_UNVERIFIED: 'accent',
  AWAITING_FIRST_EVENT: 'accent',
  CONSENT_ONLY: 'accent',
  MANUAL_TRACKING: 'neutral',
  NOT_CONFIGURED: 'neutral',
  CREDENTIALS_REQUIRED: 'warning',
  DISABLED: 'neutral',
  ERROR: 'danger',
};

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** The badge on a field whose change goes to the operator first. */
function ReverifiedBadge(): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone="warning">{t('profile.field.reverifiedBadge')}</Badge>;
}

function LockedValue({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="flex items-center gap-1.5 text-sm text-ink">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true">
          <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </svg>
        <span className="min-w-0 break-words">{value}</span>
      </p>
      <p className="text-xs text-ink-muted">{note}</p>
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  problem?: string | undefined;
  hint?: string | undefined;
  type?: 'text' | 'email' | 'tel' | 'url' | 'date';
  required?: boolean;
  reverified?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  maxLength?: number;
  multiline?: boolean;
}

function TextField({
  label,
  value,
  onChange,
  onBlur,
  problem,
  hint,
  type = 'text',
  required = false,
  reverified = false,
  disabled = false,
  autoComplete,
  maxLength,
  multiline = false,
}: TextFieldProps): React.JSX.Element {
  return (
    <div className="relative">
      {reverified ? (
        <span className="absolute right-0 top-0">
          <ReverifiedBadge />
        </span>
      ) : null}
      <Field
        label={label}
        error={problem}
        required={required}
        {...(hint === undefined ? {} : { hint })}
      >
        {({ inputId, describedBy }) =>
          multiline ? (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={value}
              invalid={problem !== undefined}
              disabled={disabled}
              rows={4}
              {...(maxLength === undefined ? {} : { maxLength })}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              {...(onBlur === undefined ? {} : { onBlur })}
            />
          ) : (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type={type}
              value={value}
              invalid={problem !== undefined}
              disabled={disabled}
              {...(autoComplete === undefined ? {} : { autoComplete })}
              {...(maxLength === undefined ? {} : { maxLength })}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              {...(onBlur === undefined ? {} : { onBlur })}
            />
          )
        }
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ProfilePage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: profileKey, queryFn: fetchProfile, retry: 1 });

  if (query.isLoading) return <LoadingState label={t('profile.loading')} />;

  if (query.isError || query.data === undefined) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  // Keyed on the record's own timestamp, so a save that changed it rebuilds
  // the draft from the server's answer rather than from what was typed.
  return <ProfileEditor key={query.data.identity.updatedAt} profile={query.data} />;
}

function ProfileEditor({ profile }: { profile: LogisticsProfile }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canEdit = profile.editing.canEdit;
  const initial = useMemo(() => draftFromProfile(profile), [profile]);
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmRemoveLogo, setConfirmRemoveLogo] = useState(false);

  const active: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : 'overview';
  const setActive = useCallback(
    (tab: TabKey) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (tab === 'overview') next.delete('tab');
          else next.set('tab', tab);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const patch = useMemo(() => diffDraft(initial, draft), [initial, draft]);
  const changed = Object.keys(patch);
  const dirty = changed.length > 0;
  const reverifiedChanges = changed.filter(isReverified);
  const problems = useMemo(() => validateDraft(draft), [draft]);

  /** The message a field shows now, if any. */
  const problemFor = (field: string): string | undefined => {
    const server = serverProblems[field];
    if (server !== undefined) return t(`profile.problem.${server}` as TranslationKey);
    const local: FieldProblem | undefined = problems[field];
    if (local === undefined) return undefined;
    if (!attempted && !touched.has(field.split('.')[0] ?? field)) return undefined;
    return t(`profile.problem.${local}`);
  };

  const update = <K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setServerProblems((current) => {
      const next: Record<string, string> = {};
      for (const [key, code] of Object.entries(current)) {
        if (key !== field && !key.startsWith(`${field}.`)) next[key] = code;
      }
      return next;
    });
  };

  const touch = (field: string) => (): void => {
    setTouched((current) => new Set(current).add(field));
  };

  // --- Leaving with unsaved work ----------------------------------------
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  // --- Saving -----------------------------------------------------------
  const save = useMutation({
    mutationFn: () => saveProfile(patch),
    onSuccess: (result: ProfileSaveResult) => {
      setSaveError(null);
      setServerProblems({});
      setAttempted(false);
      setTouched(new Set());
      queryClient.setQueryData(profileKey, result.profile);
      if (result.applied.length > 0) toast.success(t('profile.save.saved'));
      if (result.submittedForReview.length > 0) toast.info(t('profile.save.sentForReview'));
      if (result.applied.length === 0 && result.submittedForReview.length === 0) {
        toast.info(t('profile.save.nothingChanged'));
      }
      // The editor is keyed on `updatedAt`; when only a proposal was filed the
      // record itself did not change, so put the draft back by hand.
      setDraft(draftFromProfile(result.profile));
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.details.length > 0) {
        const mapped: Record<string, string> = {};
        for (const detail of error.details) {
          if (detail.field === undefined) continue;
          const key = problemKeyFor(detail.field);
          mapped[key] = detail.code === 'TAKEN' ? 'taken' : 'server';
        }
        setServerProblems(mapped);
        const first = Object.keys(mapped)[0];
        if (first !== undefined) setActive(tabForField(first));
      }
      setSaveError(error);
    },
  });

  const submit = (): void => {
    setAttempted(true);
    const blocking = Object.keys(problems).filter((field) =>
      changed.includes(field.split('.')[0] ?? field),
    );
    if (blocking.length > 0) {
      const first = blocking[0];
      if (first !== undefined) setActive(tabForField(first));
      toast.error(t('profile.save.fixFirst'));
      return;
    }
    save.mutate();
  };

  const reset = (): void => {
    setDraft(initial);
    setTouched(new Set());
    setAttempted(false);
    setServerProblems({});
    setSaveError(null);
  };

  // --- Logo, withdrawal -------------------------------------------------
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: profileKey });
  };

  const logoUpload = useMutation({
    mutationFn: uploadLogo,
    onSuccess: () => {
      toast.success(t('profile.hero.logoSaved'));
      refresh();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const logoRemoval = useMutation({
    mutationFn: removeLogo,
    onSuccess: () => {
      setConfirmRemoveLogo(false);
      toast.success(t('profile.hero.logoRemoved'));
      refresh();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const withdraw = useMutation({
    mutationFn: withdrawPendingChange,
    onSuccess: (next) => {
      setConfirmWithdraw(false);
      queryClient.setQueryData(profileKey, next);
      toast.success(t('profile.review.withdrawn'));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const pending = profile.review.pendingChange;
  const lastDecision = profile.review.lastDecision;

  const tabs = TAB_KEYS.map((key) => ({
    key,
    label: t(`profile.tab.${key}`),
    flag:
      key === 'compliance'
        ? profile.compliance.items.some((item) => item.status !== 'VERIFIED')
        : Object.keys(serverProblems).some((field) => tabForField(field) === key),
  }));

  const fieldLabel = (field: string): string =>
    t(`profile.fieldName.${field}` as TranslationKey);

  return (
    <div>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />

      <ProfileHero
        profile={profile}
        canEdit={canEdit}
        hasPendingChange={pending !== null}
        logoBusy={logoUpload.isPending || logoRemoval.isPending}
        onUploadLogo={(file) => {
          logoUpload.mutate(file);
        }}
        onRemoveLogo={() => {
          setConfirmRemoveLogo(true);
        }}
      />

      <div className="mb-5 space-y-3">
        {!canEdit ? (
          <Callout tone="neutral">{t('profile.readOnlyRole')}</Callout>
        ) : null}

        {profile.identity.status === 'SUSPENDED' ? (
          <Callout tone="warning" title={t('profile.suspended.title')}>
            {profile.identity.suspensionReason ?? t('profile.suspended.noReason')}
          </Callout>
        ) : null}

        {pending === null ? null : (
          <Callout tone="info" title={t('profile.review.pendingTitle')}>
            <p>{t('profile.review.pendingBody', { when: formatDateTime(pending.requestedAt) })}</p>
            <ul className="mt-2 space-y-1">
              {Object.entries(pending.proposed).map(([field, value]) => (
                <li key={field} className="text-sm">
                  <span className="font-medium">{fieldLabel(field)}:</span>{' '}
                  <span className="text-ink-muted line-through">
                    {describeValue(pending.current[field as keyof typeof pending.current])}
                  </span>{' '}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">{t('profile.review.changesTo')}</span>{' '}
                  <span>{describeValue(value)}</span>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => {
                  setConfirmWithdraw(true);
                }}
              >
                {t('profile.review.withdraw')}
              </Button>
            ) : null}
          </Callout>
        )}

        {pending === null && lastDecision?.state === 'REJECTED' ? (
          <Callout tone="warning" title={t('profile.review.rejectedTitle')}>
            {lastDecision.decisionNote ?? t('profile.review.noReason')}
          </Callout>
        ) : null}
      </div>

      <ProfileTabs
        tabs={tabs}
        active={active}
        onChange={setActive}
        label={t('profile.tabsLabel')}
        idPrefix="profile"
      />

      <div
        role="tabpanel"
        id={`profile-panel-${active}`}
        aria-labelledby={`profile-tab-${active}`}
        tabIndex={0}
        className="mt-5 focus-visible:outline-none"
      >
        {active === 'overview' ? (
          <OverviewSection profile={profile} onOpen={setActive} />
        ) : null}
        {active === 'company' ? (
          <CompanySection
            profile={profile}
            draft={draft}
            canEdit={canEdit}
            update={update}
            touch={touch}
            problemFor={problemFor}
          />
        ) : null}
        {active === 'contacts' ? (
          <ContactsSection
            draft={draft}
            canEdit={canEdit}
            update={update}
            touch={touch}
            problemFor={problemFor}
          />
        ) : null}
        {active === 'coverage' ? (
          <CoverageSection
            profile={profile}
            draft={draft}
            canEdit={canEdit}
            update={update}
            problemFor={problemFor}
          />
        ) : null}
        {active === 'capabilities' ? (
          <CapabilitiesSection
            profile={profile}
            draft={draft}
            canEdit={canEdit}
            update={update}
            problemFor={problemFor}
          />
        ) : null}
        {active === 'compliance' ? (
          <ComplianceSection
            profile={profile}
            draft={draft}
            canEdit={canEdit}
            update={update}
            touch={touch}
            problemFor={problemFor}
            onUploaded={refresh}
          />
        ) : null}
        {active === 'integrations' ? <IntegrationsSection profile={profile} /> : null}
        {active === 'account' ? <AccountSection profile={profile} /> : null}
      </div>

      {dirty && canEdit ? (
        <div
          role="region"
          aria-label={t('profile.save.region')}
          className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 shadow-overlay backdrop-blur supports-[backdrop-filter]:bg-surface/85 lg:-mx-8 lg:px-8"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm" aria-live="polite">
              <p className="font-semibold text-ink">
                {t('profile.save.unsaved', { changes: String(changed.length) })}
              </p>
              {reverifiedChanges.length > 0 ? (
                <p className="text-xs text-ink-muted">
                  {t('profile.save.willReview', {
                    fields: reverifiedChanges.map(fieldLabel).join(', '),
                  })}
                </p>
              ) : null}
              {saveError !== null ? (
                <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs font-medium text-danger">
                  {saveError instanceof ApiError && saveError.details.length > 0
                    ? t('profile.save.checkFields')
                    : saveError.message || t('profile.save.failed')}
                  <button
                    type="button"
                    className="rounded underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    onClick={submit}
                  >
                    {t('common.retry')}
                  </button>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={reset} disabled={save.isPending}>
                {t('profile.save.reset')}
              </Button>
              <Button variant="primary" onClick={submit} isLoading={save.isPending}>
                {t('profile.save.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        onClose={() => {
          blocker.reset?.();
        }}
        onConfirm={() => {
          blocker.proceed?.();
        }}
        title={t('profile.leave.title')}
        body={t('profile.leave.body')}
        confirmLabel={t('profile.leave.confirm')}
        isDangerous
      />

      <ConfirmDialog
        isOpen={confirmWithdraw}
        onClose={() => {
          setConfirmWithdraw(false);
        }}
        onConfirm={() => {
          withdraw.mutate();
        }}
        title={t('profile.review.withdrawTitle')}
        body={t('profile.review.withdrawBody')}
        confirmLabel={t('profile.review.withdraw')}
        isWorking={withdraw.isPending}
      />

      <ConfirmDialog
        isOpen={confirmRemoveLogo}
        onClose={() => {
          setConfirmRemoveLogo(false);
        }}
        onConfirm={() => {
          logoRemoval.mutate();
        }}
        title={t('profile.hero.removeLogoTitle')}
        body={t('profile.hero.removeLogoBody')}
        confirmLabel={t('profile.hero.removeLogo')}
        isDangerous
        isWorking={logoRemoval.isPending}
      />
    </div>
  );
}

const HISTORY_ACTIONS = [
  'logistics.organisation.updated',
  'logistics.profile.updated',
  'logistics.profile.change_requested',
  'logistics.profile.change_withdrawn',
  'logistics.profile.change_approved',
  'logistics.profile.change_rejected',
  'logistics.profile.logo_updated',
  'logistics.profile.logo_removed',
  'logistics.profile.document_uploaded',
  'logistics.profile.document_downloaded',
  'logistics.profile.document_verified',
  'logistics.profile.document_rejected',
  'logistics.profile.verification_changed',
] as const;

/** A trail entry in the reader’s language. The server’s summary is English, so it is not shown. */
function historyLabel(action: string, t: ReturnType<typeof useI18n>['t']): string {
  return (HISTORY_ACTIONS as readonly string[]).includes(action)
    ? t(`profile.history.${action.replaceAll('.', '_')}` as TranslationKey)
    : t('profile.history.other');
}

/** A proposed or current value, as a sentence fragment. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const address = value as Partial<Record<string, string | null>>;
    return [address['line1'], address['line2'], address['city'], address['postalCode'], address['countryCode']]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(', ');
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** The draft fields that hold plain text. */
type TextDraftField = {
  [K in keyof ProfileDraft]: ProfileDraft[K] extends string ? K : never;
}[keyof ProfileDraft];

type Update = <K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) => void;
type Touch = (field: string) => () => void;
type ProblemFor = (field: string) => string | undefined;

function OverviewSection({
  profile,
  onOpen,
}: {
  profile: LogisticsProfile;
  onOpen: (tab: TabKey) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const verifiedDocs = profile.compliance.items.filter((item) => item.status === 'VERIFIED').length;
  const needsAttention = profile.compliance.items.some(
    (item) => item.status === 'EXPIRED' || item.status === 'REJECTED' || item.status === 'MISSING',
  );
  const connected = profile.integrations.filter(
    (row) => row.status === 'CONNECTED' || row.status === 'ACTIVE',
  ).length;

  const cards: HoverCard[] = [
    {
      key: 'company',
      title: t('profile.tab.company'),
      value: profile.identity.legalName,
      detail: t('profile.overview.registered', {
        country: profile.company.registrationCountry,
      }),
      onOpen: () => {
        onOpen('company');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.company') }),
    },
    {
      key: 'contacts',
      title: t('profile.tab.contacts'),
      value: profile.contacts.contactEmail,
      detail: profile.contacts.contactPhone ?? t('profile.overview.noPhone'),
      onOpen: () => {
        onOpen('contacts');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.contacts') }),
    },
    {
      key: 'coverage',
      title: t('profile.tab.coverage'),
      value: t('profile.overview.countries', { countries: String(profile.coverage.countries.length) }),
      detail:
        profile.coverage.countries.length === 0
          ? t('profile.overview.noCoverage')
          : profile.coverage.countries.join(' · '),
      onOpen: () => {
        onOpen('coverage');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.coverage') }),
    },
    {
      key: 'capabilities',
      title: t('profile.tab.capabilities'),
      value: t('profile.overview.fleet', {
        vehicles: String(profile.capabilities.fleetSize),
        drivers: String(profile.capabilities.activeDrivers),
      }),
      detail:
        profile.capabilities.levels.length === 0
          ? t('profile.overview.noLevels')
          : profile.capabilities.levels.join(' · '),
      onOpen: () => {
        onOpen('capabilities');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.capabilities') }),
    },
    {
      key: 'compliance',
      title: t('profile.tab.compliance'),
      value: t('profile.overview.documents', {
        verified: String(verifiedDocs),
        total: String(profile.compliance.items.length),
      }),
      detail: needsAttention ? t('profile.overview.complianceAttention') : t('profile.overview.complianceOk'),
      tone: needsAttention ? 'warning' : 'success',
      onOpen: () => {
        onOpen('compliance');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.compliance') }),
    },
    {
      key: 'integrations',
      title: t('profile.tab.integrations'),
      value: t('profile.overview.integrations', {
        connected: String(connected),
        total: String(profile.integrations.length),
      }),
      detail: t('profile.overview.integrationsDetail'),
      onOpen: () => {
        onOpen('integrations');
      },
      openLabel: t('profile.overview.open', { section: t('profile.tab.integrations') }),
    },
  ];

  return (
    <div className="space-y-5">
      <HoverCardGrid cards={cards} idPrefix="profile-overview" />

      <Card title={t('profile.overview.missingTitle')} bodyClassName="px-5 py-4">
        {profile.completion.missing.length === 0 ? (
          <p className="text-sm text-success">{t('profile.hero.complete')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {profile.completion.missing.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => {
                    onOpen(tabForField(key));
                  }}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-ink transition-colors hover:border-brand/40 hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                  {t(`profile.missing.${key}` as TranslationKey)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('profile.overview.systemTitle')} bodyClassName="px-5 py-4">
        <DescriptionList
          items={[
            { label: t('profile.hero.partnerId'), value: profile.identity.partnerCode },
            {
              label: t('profile.overview.partnerType'),
              value: t(`profile.partnerKind.${profile.identity.partnerKind}` as TranslationKey),
            },
            { label: t('profile.overview.created'), value: formatDate(profile.identity.createdAt) },
            {
              label: t('profile.overview.lastUpdate'),
              value: formatDateTime(profile.identity.updatedAt),
            },
            {
              label: t('profile.overview.verifiedAt'),
              value:
                profile.identity.verifiedAt === null
                  ? t('profile.overview.notVerified')
                  : formatDate(profile.identity.verifiedAt),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function AddressFields({
  legend,
  value,
  onChange,
  problem,
  disabled,
  reverified = false,
}: {
  legend: string;
  value: AddressDraft;
  onChange: (value: AddressDraft) => void;
  problem: string | undefined;
  disabled: boolean;
  reverified?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const set = (key: keyof AddressDraft) => (next: string) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-ink">
        {legend}
        {reverified ? <ReverifiedBadge /> : null}
      </legend>
      {problem === undefined ? null : (
        <p role="alert" className="text-xs font-medium text-danger">
          {problem}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('profile.address.line1')} value={value.line1} onChange={set('line1')} disabled={disabled} autoComplete="address-line1" maxLength={200} />
        <TextField label={t('profile.address.line2')} value={value.line2} onChange={set('line2')} disabled={disabled} autoComplete="address-line2" maxLength={200} />
        <TextField label={t('profile.address.city')} value={value.city} onChange={set('city')} disabled={disabled} autoComplete="address-level2" maxLength={120} />
        <TextField label={t('profile.address.region')} value={value.region} onChange={set('region')} disabled={disabled} autoComplete="address-level1" maxLength={120} />
        <TextField label={t('profile.address.postalCode')} value={value.postalCode} onChange={set('postalCode')} disabled={disabled} autoComplete="postal-code" maxLength={20} />
        <TextField
          label={t('profile.address.country')}
          value={value.countryCode}
          onChange={(next) => {
            set('countryCode')(next.toUpperCase());
          }}
          hint={t('profile.address.countryHint')}
          disabled={disabled}
          autoComplete="country"
          maxLength={2}
        />
      </div>
    </fieldset>
  );
}

function CompanySection({
  profile,
  draft,
  canEdit,
  update,
  touch,
  problemFor,
}: {
  profile: LogisticsProfile;
  draft: ProfileDraft;
  canEdit: boolean;
  update: Update;
  touch: Touch;
  problemFor: ProblemFor;
}): React.JSX.Element {
  const { t } = useI18n();
  const disabled = !canEdit;

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card
        title={t('profile.company.identityTitle')}
        description={t('profile.company.identityHint')}
        bodyClassName="space-y-4 px-5 py-4"
      >
        <LockedValue
          label={t('profile.hero.partnerId')}
          value={<span className="font-mono">{profile.identity.partnerCode}</span>}
          note={t('profile.field.system')}
        />
        <TextField label={t('profile.fieldName.legalName')} value={draft.legalName} onChange={(v) => { update('legalName', v); }} onBlur={touch('legalName')} problem={problemFor('legalName')} required reverified disabled={disabled} autoComplete="organization" maxLength={255} />
        <TextField label={t('profile.fieldName.displayName')} value={draft.displayName} onChange={(v) => { update('displayName', v); }} onBlur={touch('displayName')} problem={problemFor('displayName')} hint={t('profile.company.displayNameHint')} required reverified disabled={disabled} maxLength={160} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t('profile.fieldName.registrationNumber')} value={draft.registrationNumber} onChange={(v) => { update('registrationNumber', v); }} onBlur={touch('registrationNumber')} problem={problemFor('registrationNumber')} reverified disabled={disabled} maxLength={64} />
          <TextField label={t('profile.fieldName.taxNumber')} value={draft.taxNumber} onChange={(v) => { update('taxNumber', v); }} onBlur={touch('taxNumber')} problem={problemFor('taxNumber')} hint={t('profile.company.taxHint')} reverified disabled={disabled} maxLength={64} />
        </div>
        <TextField label={t('profile.fieldName.registrationCountry')} value={draft.registrationCountry} onChange={(v) => { update('registrationCountry', v.toUpperCase()); }} onBlur={touch('registrationCountry')} problem={problemFor('registrationCountry')} hint={t('profile.address.countryHint')} required reverified disabled={disabled} maxLength={2} />
      </Card>

      <Card title={t('profile.company.aboutTitle')} bodyClassName="space-y-4 px-5 py-4">
        <TextField label={t('profile.fieldName.websiteUrl')} type="url" value={draft.websiteUrl} onChange={(v) => { update('websiteUrl', v); }} onBlur={touch('websiteUrl')} problem={problemFor('websiteUrl')} hint={t('profile.company.websiteHint')} disabled={disabled} autoComplete="url" maxLength={512} />
        <TextField label={t('profile.fieldName.businessDescription')} value={draft.businessDescription} onChange={(v) => { update('businessDescription', v); }} onBlur={touch('businessDescription')} problem={problemFor('businessDescription')} hint={t('profile.company.descriptionHint', { remaining: String(2000 - draft.businessDescription.length) })} disabled={disabled} maxLength={2000} multiline />
      </Card>

      <Card title={t('profile.fieldName.registeredAddress')} description={t('profile.company.registeredHint')} bodyClassName="px-5 py-4">
        <AddressFields
          legend={t('profile.fieldName.registeredAddress')}
          value={draft.registeredAddress}
          onChange={(v) => {
            update('registeredAddress', v);
          }}
          problem={problemFor('registeredAddress')}
          disabled={disabled}
          reverified
        />
      </Card>

      <Card title={t('profile.fieldName.operationalAddress')} description={t('profile.company.operationalHint')} bodyClassName="px-5 py-4">
        <AddressFields
          legend={t('profile.fieldName.operationalAddress')}
          value={draft.operationalAddress}
          onChange={(v) => {
            update('operationalAddress', v);
          }}
          problem={problemFor('operationalAddress')}
          disabled={disabled}
        />
      </Card>
    </div>
  );
}

function ContactsSection({
  draft,
  canEdit,
  update,
  touch,
  problemFor,
}: {
  draft: ProfileDraft;
  canEdit: boolean;
  update: Update;
  touch: Touch;
  problemFor: ProblemFor;
}): React.JSX.Element {
  const { t } = useI18n();
  const disabled = !canEdit;
  const text = (field: TextDraftField, type: TextFieldProps['type'] = 'text', max = 160, required = false) => (
    <TextField
      label={t(`profile.fieldName.${field}` as TranslationKey)}
      type={type}
      value={draft[field]}
      onChange={(v) => {
        update(field, v);
      }}
      onBlur={touch(field)}
      problem={problemFor(field)}
      disabled={disabled}
      required={required}
      maxLength={max}
      {...(type === 'email' ? { autoComplete: 'email' } : type === 'tel' ? { autoComplete: 'tel' } : {})}
    />
  );

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title={t('profile.contacts.businessTitle')} description={t('profile.contacts.businessHint')} bodyClassName="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {text('contactEmail', 'email', 320, true)}
        {text('contactPhone', 'tel', 32)}
        {text('primaryContactName')}
        {text('primaryContactTitle', 'text', 120)}
      </Card>
      <Card title={t('profile.contacts.emergencyTitle')} description={t('profile.contacts.emergencyHint')} bodyClassName="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {text('emergencyContactName')}
        {text('emergencyPhone', 'tel', 32)}
      </Card>
      <Card title={t('profile.contacts.supportTitle')} bodyClassName="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {text('supportEmail', 'email', 320)}
        {text('supportPhone', 'tel', 32)}
      </Card>
      <Card title={t('profile.contacts.billingTitle')} bodyClassName="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {text('billingContactName')}
        {text('billingEmail', 'email', 320)}
        {text('billingPhone', 'tel', 32)}
      </Card>
    </div>
  );
}

function CoverageSection({
  profile,
  draft,
  canEdit,
  update,
  problemFor,
}: {
  profile: LogisticsProfile;
  draft: ProfileDraft;
  canEdit: boolean;
  update: Update;
  problemFor: ProblemFor;
}): React.JSX.Element {
  const { t } = useI18n();
  const regions = profile.coverage.regions;

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title={t('profile.coverage.regionsTitle')} description={t('profile.field.setByTeam')} bodyClassName="px-5 py-4">
        {regions.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('profile.coverage.noRegions')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {regions.map((region) => (
              <li key={region.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="font-medium text-ink">
                  {region.countryCode}
                  {region.regionValue === '' ? '' : ` · ${region.regionValue}`}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {region.isExclusion ? <Badge tone="danger">{t('profile.coverage.excluded')}</Badge> : null}
                  {region.supportsPickup ? <Badge tone="neutral">{t('profile.coverage.pickup')}</Badge> : null}
                  {region.supportsDelivery ? <Badge tone="neutral">{t('profile.coverage.delivery')}</Badge> : null}
                  {region.isActive ? null : <Badge tone="warning">{t('profile.coverage.inactive')}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t('profile.fieldName.hubLocations')}
        description={t('profile.coverage.hubsHint')}
        bodyClassName="space-y-3 px-5 py-4"
        actions={
          canEdit && draft.hubLocations.length < 20 ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                update('hubLocations', [...draft.hubLocations, { name: '', city: '', countryCode: '' }]);
              }}
            >
              {t('profile.coverage.addHub')}
            </Button>
          ) : undefined
        }
      >
        {draft.hubLocations.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('profile.coverage.noHubs')}</p>
        ) : (
          draft.hubLocations.map((hub, index) => {
            const set = (key: 'name' | 'city' | 'countryCode') => (value: string) => {
              update(
                'hubLocations',
                draft.hubLocations.map((row, at) =>
                  at === index ? { ...row, [key]: key === 'countryCode' ? value.toUpperCase() : value } : row,
                ),
              );
            };
            return (
              <fieldset key={index} className="rounded-lg border border-border-subtle p-3">
                <legend className="px-1 text-xs font-semibold text-ink-muted">
                  {t('profile.coverage.hubNumber', { number: String(index + 1) })}
                </legend>
                {problemFor(`hubLocations.${String(index)}`) === undefined ? null : (
                  <p role="alert" className="mb-2 text-xs font-medium text-danger">
                    {problemFor(`hubLocations.${String(index)}`)}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end">
                  <TextField label={t('profile.coverage.hubName')} value={hub.name} onChange={set('name')} disabled={!canEdit} maxLength={120} />
                  <TextField label={t('profile.address.city')} value={hub.city} onChange={set('city')} disabled={!canEdit} maxLength={120} />
                  <TextField label={t('profile.address.country')} value={hub.countryCode} onChange={set('countryCode')} disabled={!canEdit} maxLength={2} />
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('profile.coverage.removeHub', { number: String(index + 1) })}
                      onClick={() => {
                        update(
                          'hubLocations',
                          draft.hubLocations.filter((_, at) => at !== index),
                        );
                      }}
                    >
                      {t('profile.coverage.remove')}
                    </Button>
                  ) : null}
                </div>
              </fieldset>
            );
          })
        )}
      </Card>
    </div>
  );
}

function CapabilitiesSection({
  profile,
  draft,
  canEdit,
  update,
  problemFor,
}: {
  profile: LogisticsProfile;
  draft: ProfileDraft;
  canEdit: boolean;
  update: Update;
  problemFor: ProblemFor;
}): React.JSX.Element {
  const { t } = useI18n();
  const capabilities = profile.capabilities;
  const zones = useMemo(() => {
    const all = timeZones();
    return draft.timeZone !== '' && !all.includes(draft.timeZone) ? [draft.timeZone, ...all] : all;
  }, [draft.timeZone]);

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title={t('profile.capabilities.evidenceTitle')} description={t('profile.capabilities.evidenceHint')} bodyClassName="space-y-4 px-5 py-4">
        <DescriptionList
          items={[
            {
              label: t('profile.capabilities.selfManaged'),
              value: capabilities.selfManaged ? t('common.yes') : t('common.no'),
            },
            {
              label: t('profile.capabilities.levels'),
              value: capabilities.levels.length === 0 ? t('profile.capabilities.noneYet') : capabilities.levels.join(', '),
            },
            {
              label: t('profile.capabilities.pricedModes'),
              value:
                capabilities.pricedTransportModes.length === 0
                  ? t('profile.capabilities.noneYet')
                  : capabilities.pricedTransportModes.map((mode) => t(`profile.mode.${mode}` as TranslationKey)).join(', '),
            },
            { label: t('profile.capabilities.fleetSize'), value: String(capabilities.fleetSize) },
            { label: t('profile.capabilities.activeDrivers'), value: String(capabilities.activeDrivers) },
            {
              label: t('profile.capabilities.vehicleTypes'),
              value:
                capabilities.vehicleKinds.length === 0
                  ? t('profile.capabilities.noneYet')
                  : capabilities.vehicleKinds.map((kind) => t(`profile.vehicle.${kind}` as TranslationKey)).join(', '),
            },
            {
              label: t('profile.capabilities.maxLoad'),
              value:
                capabilities.maxVehicleLoadKg === null
                  ? t('profile.capabilities.notStated')
                  : t('profile.capabilities.kg', { kg: capabilities.maxVehicleLoadKg.toLocaleString() }),
            },
            { label: t('profile.capabilities.refrigerated'), value: String(capabilities.refrigeratedVehicles) },
          ]}
        />
        <p className="text-xs text-ink-muted">{t('profile.capabilities.fleetHint')}</p>
      </Card>

      <Card title={t('profile.capabilities.approvedTitle')} description={t('profile.field.setByTeam')} bodyClassName="px-5 py-4">
        {capabilities.approved.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('profile.capabilities.noneYet')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {capabilities.approved.map((row) => (
              <li key={row.kind}>
                <Badge tone={row.state === 'APPROVED' ? 'success' : row.state === 'REJECTED' ? 'danger' : 'neutral'} dot>
                  {capabilityKindLabel(row.kind, t)}
                  {row.evidenceExpiresAt === null ? '' : ` · ${formatDate(row.evidenceExpiresAt)}`}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('profile.fieldName.declaredTransportModes')} description={t('profile.capabilities.declaredHint')} bodyClassName="grid gap-2 px-5 py-4 sm:grid-cols-2">
        {DECLARABLE_MODES.map((mode) => (
          <CheckboxField
            key={mode}
            boxed
            label={t(`profile.mode.${mode}`)}
            checked={draft.declaredTransportModes.includes(mode)}
            disabled={!canEdit}
            onChange={(event) => {
              update(
                'declaredTransportModes',
                event.target.checked
                  ? [...draft.declaredTransportModes, mode]
                  : draft.declaredTransportModes.filter((row) => row !== mode),
              );
            }}
          />
        ))}
      </Card>

      <Card title={t('profile.fieldName.operatingHours')} bodyClassName="space-y-4 px-5 py-4">
        <Field label={t('profile.fieldName.timeZone')} error={problemFor('timeZone')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={draft.timeZone}
              disabled={!canEdit}
              invalid={problemFor('timeZone') !== undefined}
              onChange={(event) => {
                update('timeZone', event.target.value);
              }}
            >
              <option value="">{t('profile.capabilities.noTimeZone')}</option>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <ul className="space-y-2">
          {WEEKDAYS.map((day) => {
            const slot = draft.operatingHours[day];
            const setSlot = (next: Partial<typeof slot>): void => {
              update('operatingHours', { ...draft.operatingHours, [day]: { ...slot, ...next } });
            };
            const problem = problemFor(`operatingHours.${day}`);
            return (
              <li key={day} className="rounded-md border border-border-subtle px-3 py-2">
                <div className="flex flex-wrap items-center gap-3">
                  <CheckboxField
                    className="w-28"
                    label={t(`profile.day.${day}`)}
                    checked={slot.enabled}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setSlot({ enabled: event.target.checked });
                    }}
                  />
                  {slot.enabled ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        className="w-28"
                        aria-label={t('profile.capabilities.opensAt', { day: t(`profile.day.${day}`) })}
                        value={slot.open}
                        invalid={problem !== undefined}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setSlot({ open: event.target.value });
                        }}
                      />
                      <span aria-hidden="true" className="text-ink-subtle">–</span>
                      <Input
                        type="time"
                        className="w-28"
                        aria-label={t('profile.capabilities.closesAt', { day: t(`profile.day.${day}`) })}
                        value={slot.close}
                        invalid={problem !== undefined}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setSlot({ close: event.target.value });
                        }}
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-ink-muted">{t('profile.capabilities.closed')}</span>
                  )}
                </div>
                {problem === undefined ? null : (
                  <p role="alert" className="mt-1 text-xs font-medium text-danger">
                    {problem}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function ComplianceSection({
  profile,
  draft,
  canEdit,
  update,
  touch,
  problemFor,
  onUploaded,
}: {
  profile: LogisticsProfile;
  draft: ProfileDraft;
  canEdit: boolean;
  update: Update;
  touch: Touch;
  problemFor: ProblemFor;
  onUploaded: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [kind, setKind] = useState<ComplianceKind>('BUSINESS_LICENCE');
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | undefined>(undefined);
  const [inputKey, setInputKey] = useState(0);

  const upload = useMutation({
    mutationFn: uploadComplianceDocument,
    onSuccess: () => {
      toast.success(t('profile.compliance.uploaded'));
      setFile(null);
      setExpiresOn('');
      setInputKey((key) => key + 1);
      onUploaded();
    },
    onError: (error: Error) => {
      setFileProblem(
        error instanceof ApiError && error.code === 'MEDIA_TYPE_NOT_ALLOWED'
          ? t('profile.compliance.wrongType')
          : error.message,
      );
    },
  });

  const download = useMutation({
    mutationFn: downloadComplianceDocument,
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const pick = (next: File | null): void => {
    setFile(next);
    setFileProblem(undefined);
    if (next === null) return;
    if (next.size > MAX_DOCUMENT_BYTES) setFileProblem(t('profile.compliance.tooLarge'));
    else if (next.type !== '' && !DOCUMENT_TYPES.includes(next.type)) {
      setFileProblem(t('profile.compliance.wrongType'));
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={t('profile.compliance.statusTitle')} bodyClassName="px-5 py-4">
          <ul className="divide-y divide-border-subtle">
            {profile.compliance.items.map((item) => (
              <li key={item.kind} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="font-medium text-ink">{t(`profile.documentKind.${item.kind}`)}</span>
                <span className="flex items-center gap-2">
                  {item.expiresOn === null ? null : (
                    <span className="text-xs text-ink-muted">
                      {t('profile.compliance.expires', { date: formatDate(item.expiresOn) })}
                    </span>
                  )}
                  <Badge tone={COMPLIANCE_TONE[item.status]} dot>
                    {t(`profile.complianceStatus.${item.status}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
          <DescriptionList
            items={[
              {
                label: t('profile.compliance.contract'),
                value: t(`profile.contract.${profile.compliance.contractStatus}` as TranslationKey),
              },
              {
                label: t('profile.compliance.contractEnds'),
                value: formatDate(profile.compliance.contractEndsAt),
              },
            ]}
          />
        </Card>

        <Card title={t('profile.compliance.licenceTitle')} bodyClassName="space-y-4 px-5 py-4">
          <TextField label={t('profile.fieldName.licenceNumber')} value={draft.licenceNumber} onChange={(v) => { update('licenceNumber', v); }} onBlur={touch('licenceNumber')} problem={problemFor('licenceNumber')} reverified disabled={!canEdit} maxLength={64} />
          <TextField label={t('profile.fieldName.licenceExpiresAt')} type="date" value={draft.licenceExpiresAt} onChange={(v) => { update('licenceExpiresAt', v); }} onBlur={touch('licenceExpiresAt')} problem={problemFor('licenceExpiresAt')} reverified disabled={!canEdit} />
        </Card>
      </div>

      {canEdit ? (
        <Card title={t('profile.compliance.uploadTitle')} description={t('profile.compliance.uploadHint')} bodyClassName="px-5 py-4">
          <form
            className="grid gap-4 md:grid-cols-[1fr_12rem_1fr_auto] md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (file === null) {
                setFileProblem(t('profile.compliance.chooseFile'));
                return;
              }
              if (fileProblem !== undefined) return;
              upload.mutate({ kind, expiresOn, file });
            }}
          >
            <Field label={t('profile.compliance.kind')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as ComplianceKind);
                  }}
                >
                  {COMPLIANCE_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {t(`profile.documentKind.${value}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <TextField
              label={t('profile.compliance.expiresOn')}
              type="date"
              value={expiresOn}
              onChange={setExpiresOn}
            />
            <Field label={t('profile.compliance.file')} error={fileProblem}>
              {({ inputId, describedBy }) => (
                <input
                  key={inputKey}
                  id={inputId}
                  aria-describedby={describedBy}
                  type="file"
                  accept={DOCUMENT_TYPES.join(',')}
                  className="block w-full text-sm text-ink file:mr-3 file:min-h-10 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-ink hover:file:border-border-hover"
                  onChange={(event) => {
                    pick(event.target.files?.[0] ?? null);
                  }}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" isLoading={upload.isPending}>
              {t('profile.compliance.upload')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Card title={t('profile.compliance.filesTitle')} bodyClassName="px-5 py-4">
        {profile.compliance.documents.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('profile.compliance.noFiles')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {profile.compliance.documents.map((document) => (
              <li key={document.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{document.fileName}</p>
                  <p className="text-xs text-ink-muted">
                    {t(`profile.documentKind.${document.kind}`)} ·{' '}
                    {t('profile.compliance.uploadedBy', {
                      who: document.uploadedByLabel,
                      when: formatDate(document.createdAt),
                    })}
                    {document.expiresOn === null
                      ? ''
                      : ` · ${t('profile.compliance.expires', { date: formatDate(document.expiresOn) })}`}
                  </p>
                  {document.rejectionReason === null ? null : (
                    <p className="mt-1 text-xs text-danger">
                      {t('profile.compliance.rejectedBecause', { reason: document.rejectionReason })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={document.scanState === 'CLEAN' ? 'success' : document.scanState === 'INFECTED' || document.scanState === 'FAILED' ? 'danger' : 'neutral'}>
                    {t(`profile.scan.${document.scanState}` as TranslationKey)}
                  </Badge>
                  <Badge tone={COMPLIANCE_TONE[document.reviewState]} dot>
                    {t(`profile.complianceStatus.${document.reviewState}`)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!document.downloadable || download.isPending}
                    title={document.downloadable ? undefined : t('profile.compliance.notDownloadable')}
                    onClick={() => {
                      download.mutate(document);
                    }}
                  >
                    {t('profile.compliance.download')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function IntegrationsSection({ profile }: { profile: LogisticsProfile }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('profile.integration.title')} description={t('profile.integration.hint')} bodyClassName="px-5 py-2">
      <ul className="divide-y divide-border-subtle">
        {profile.integrations.map((row) => (
          <li key={row.key} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{t(`profile.integration.name.${row.key}` as TranslationKey)}</p>
              <p className="text-xs text-ink-muted">{t(`profile.integration.explain.${row.status}`)}</p>
            </div>
            <div className="flex items-center gap-2">
              {row.lastSuccessAt === null ? null : (
                <span className="text-xs text-ink-muted">
                  {t('profile.integration.lastSuccess', { when: formatDateTime(row.lastSuccessAt) })}
                </span>
              )}
              <Badge tone={INTEGRATION_TONE[row.status]} dot>
                {t(`profile.integration.status.${row.status}`)}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AccountSection({ profile }: { profile: LogisticsProfile }): React.JSX.Element {
  const { t } = useI18n();
  const { session } = useSession();

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title={t('profile.account.youTitle')} bodyClassName="px-5 py-4">
        {session === null ? null : (
          <DescriptionList
            items={[
              { label: t('profile.account.name'), value: session.user.fullName },
              { label: t('profile.account.email'), value: session.user.email },
              { label: t('profile.account.role'), value: t(`profile.role.${session.user.role}`) },
              {
                label: t('profile.account.canEdit'),
                value: profile.editing.canEdit ? t('common.yes') : t('common.no'),
              },
              {
                label: t('profile.account.mfa'),
                value: session.mfa.enrolled
                  ? t('profile.account.mfaOn')
                  : session.mfa.required
                    ? t('profile.account.mfaRequired')
                    : t('profile.account.mfaOff'),
              },
              {
                label: t('profile.account.recoveryCodes'),
                value: session.mfa.enrolled ? String(session.mfa.recoveryCodesRemaining) : '—',
              },
            ]}
          />
        )}
      </Card>

      <Card title={t('profile.account.securityTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm text-ink-muted">
        <p>{t('profile.account.securityDocs')}</p>
        <p>{t('profile.account.securitySecrets')}</p>
        <p>{t('profile.account.securityReview')}</p>
      </Card>

      <Card title={t('profile.account.historyTitle')} className="xl:col-span-2" bodyClassName="px-5 py-4">
        {profile.history === null ? (
          <p className="text-sm text-ink-muted">{t('profile.account.historyNoAccess')}</p>
        ) : profile.history.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('profile.account.historyEmpty')}</p>
        ) : (
          <ol className="space-y-3">
            {profile.history.map((row) => (
              <li key={row.id} className="flex gap-3 text-sm">
                <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />
                <div className="min-w-0">
                  <p className="text-ink">{historyLabel(row.action, t)}</p>
                  <p className="text-xs text-ink-muted">
                    {row.actorLabel} · <time dateTime={row.createdAt}>{formatDateTime(row.createdAt)}</time>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
