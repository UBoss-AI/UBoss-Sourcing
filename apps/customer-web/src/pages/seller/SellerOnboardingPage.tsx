/**
 * The seller application, step by step.
 *
 * A progress navigator on the left and one step's worth of form on the right.
 * The steps come from the server and so do the fields inside them - which
 * documents and identifiers a seller must supply depends on the country their
 * business is registered in, and nothing here decides that.
 *
 * Three behaviours the reference workflows make a point of, and the reasons
 * they matter:
 *
 *   - **Save and come back.** Every step saves on its own. Onboarding takes
 *     days, not minutes: documents have to be found and a director has to be
 *     asked. A form that loses everything on a closed tab does not get
 *     finished.
 *   - **The progress is out of what is REQUIRED.** A seller who has done
 *     everything they must do sees 100%, not 87% because the marketplace has
 *     not set up payouts.
 *   - **Submission names what is missing.** A disabled "submit" with no
 *     explanation is the single most common way an application is abandoned.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  acceptAgreement,
  fetchBusinessProfile,
  fetchLocations,
  fetchOnboarding,
  fetchPayoutAccount,
  saveBusinessProfile,
  saveStoreProfile,
  submitApplication,
  type BusinessProfile,
  type OnboardingStep,
  type OnboardingStepState,
} from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';

const STATE_TONE: Record<OnboardingStepState, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> =
  {
    NOT_STARTED: 'neutral',
    IN_PROGRESS: 'warning',
    COMPLETE: 'success',
    ERROR: 'danger',
    UNDER_REVIEW: 'brand',
  };

const STATE_LABEL: Record<OnboardingStepState, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETE: 'Done',
  ERROR: 'Needs attention',
  UNDER_REVIEW: 'Being checked',
};

export function SellerOnboardingPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const seller = useOutletContext<SellerOutletContext>();

  const query = useQuery({ queryKey: ['seller', 'onboarding'], queryFn: fetchOnboarding });

  const [activeKey, setActiveKey] = useState<string | null>(null);

  /*
   * The panel, so the step that opens starts at its own heading.
   *
   * Switching step swaps the whole right-hand column, and without this the
   * page keeps the scroll position it had - so somebody who pressed a button
   * at the bottom of a long step arrives at the next one already halfway down
   * it, with the heading and the first field above the top of the screen.
   */
  const panelRef = useRef<HTMLElement | null>(null);
  const hasOpenedAStep = useRef(false);

  useEffect(() => {
    // Not on arrival: the layout has just put the page at the top, and doing
    // it again would take focus off the region it moved it to.
    if (!hasOpenedAStep.current) {
      hasOpenedAStep.current = true;
      return;
    }

    panelRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeKey]);

  const submitMutation = useMutation({
    mutationFn: submitApplication,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller'] });
      toast.success('Your application has been sent. We will be in touch.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Your application could not be sent.'));
    },
  });

  if (query.isPending) return <LoadingState label="Loading your application" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const view = query.data;

  /*
   * Which step is on screen.
   *
   * In order: the one they just clicked, then the one they last SAVED, then
   * the beginning.
   *
   * The beginning, and not the first unfinished step, is the part worth being
   * deliberate about. Contact verification is step one because the email and
   * mobile are how everything that follows is answered, and it is usually
   * already done - so "first unfinished" skipped straight past it and dropped
   * a seller who had never seen this screen into the middle of their own
   * application, with no sense of what it consists of or how far in they were.
   * Somebody returning mid-application still lands where they stopped.
   */
  const active =
    view.steps.find((step) => step.key === activeKey) ??
    view.steps.find((step) => step.key === view.lastStepKey && step.state !== 'COMPLETE') ??
    view.steps[0];

  const activeIndex = view.steps.findIndex((step) => step.key === active?.key);
  const previousStep = activeIndex > 0 ? view.steps[activeIndex - 1] : undefined;
  const nextStep = activeIndex >= 0 ? view.steps[activeIndex + 1] : undefined;

  const openStep = (key: string): void => {
    setActiveKey(key);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your seller application"
        description="Work through these in any order. Everything saves as you go."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* ---- Progress navigator ---------------------------------------- */}
        <div className="space-y-4">
          <Card>
            <div className="px-6 py-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  Completed
                </span>
                <span className="tabular text-title-sm font-semibold text-ink">
                  {view.percentComplete}%
                </span>
              </div>

              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="progressbar"
                aria-valuenow={view.percentComplete}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Application completed"
              >
                <div
                  className="h-full rounded-full bg-brand-fill transition-[width]"
                  style={{ width: `${String(view.percentComplete)}%` }}
                />
              </div>
            </div>

            <nav aria-label="Application steps" className="border-t border-border-subtle">
              <ol>
                {view.steps.map((step) => {
                  const isActive = step.key === active?.key;

                  return (
                    <li key={step.key}>
                      <button
                        type="button"
                        onClick={() => {
                          openStep(step.key);
                        }}
                        aria-current={isActive ? 'step' : undefined}
                        className={cx(
                          'flex w-full items-start gap-3 border-l-2 px-5 py-3 text-left transition-colors',
                          isActive
                            ? 'border-brand bg-brand-soft'
                            : 'border-transparent hover:bg-surface-hover',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cx(
                            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xxs font-semibold',
                            step.state === 'COMPLETE'
                              ? 'bg-success text-white'
                              : step.state === 'ERROR'
                                ? 'bg-danger text-white'
                                : 'bg-surface-sunken text-ink-subtle ring-1 ring-border-strong',
                          )}
                        >
                          {step.state === 'COMPLETE' ? '✓' : step.state === 'ERROR' ? '!' : ''}
                        </span>

                        <span className="min-w-0">
                          <span
                            className={cx(
                              'block text-sm font-medium',
                              isActive ? 'text-brand' : 'text-ink',
                            )}
                          >
                            {step.title}
                          </span>
                          <span className="mt-0.5 block text-xxs text-ink-subtle">
                            {STATE_LABEL[step.state]}
                            {!step.isRequiredForSubmission && ' · optional'}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
          </Card>

          {/* Submission, and what is stopping it. Named rather than implied:
              a greyed-out button with no list is a dead end. */}
          <Card>
            <div className="space-y-3 px-6 py-5">
              {seller.status === 'SUBMITTED' || seller.status === 'UNDER_REVIEW' ? (
                <>
                  <Badge tone="brand">With the marketplace</Badge>
                  <p className="text-sm leading-relaxed text-ink-muted">
                    We are reviewing your application. You can read your answers but not change
                    them until we have finished.
                  </p>
                </>
              ) : (
                <>
                  <Button
                    fullWidth
                    variant="primary"
                    isLoading={submitMutation.isPending}
                    disabled={!view.canSubmit}
                    onClick={() => {
                      submitMutation.mutate();
                    }}
                  >
                    Send for review
                  </Button>

                  {view.canSubmit ? (
                    <p className="text-xxs leading-relaxed text-ink-muted">
                      Everything required is done. Most applications are decided within a few
                      working days.
                    </p>
                  ) : (
                    <div>
                      <p className="text-xxs font-semibold text-ink">Still to do</p>
                      <ul className="mt-1.5 space-y-1">
                        {view.blockingSteps.map((step) => (
                          <li key={step.key}>
                            <button
                              type="button"
                              onClick={() => {
                                openStep(step.key);
                              }}
                              className="text-xxs text-ink-muted hover:text-brand"
                            >
                              {step.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        </div>

        {/* ---- The step itself ------------------------------------------- */}
        <section
          ref={panelRef}
          tabIndex={-1}
          aria-label={active?.title}
          className="min-w-0 space-y-4 outline-none"
        >
          {active !== undefined && (
            <StepPanel step={active} isEditable={seller.isApplicationEditable} />
          )}

          {/*
            Back and next, under the step rather than only in the rail.

            The rail is a map; this is the path. A seller working through an
            application for the first time should not have to go back to a list
            to find out what comes after the thing they have just filled in -
            and on a phone the rail is above the panel and off the screen by the
            time they finish a step.
          */}
          {(previousStep !== undefined || nextStep !== undefined) && (
            <nav
              aria-label="Move between steps"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              {previousStep === undefined ? (
                <span />
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    openStep(previousStep.key);
                  }}
                >
                  ← {t('common.back')}
                </Button>
              )}

              {nextStep !== undefined && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    openStep(nextStep.key);
                  }}
                >
                  {t('common.continue')}: {nextStep.title} →
                </Button>
              )}
            </nav>
          )}
        </section>
      </div>
    </div>
  );
}

function StepPanel({
  step,
  isEditable,
}: {
  step: OnboardingStep;
  isEditable: boolean;
}): React.JSX.Element {
  switch (step.key) {
    case 'business_identity':
    case 'kyb_kyc':
      return <RequirementForm step={step} isEditable={isEditable} />;
    case 'store_profile':
      return <StoreProfileForm step={step} isEditable={isEditable} />;
    case 'locations':
      return <LocationsSummary step={step} />;
    case 'payout':
      return <PayoutStep step={step} />;
    case 'agreements':
      return <AgreementsStep step={step} isEditable={isEditable} />;
    default:
      return <GenericStep step={step} />;
  }
}

function StepHeader({ step }: { step: OnboardingStep }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-title-sm text-ink">{step.title}</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">{step.summary}</p>
      </div>
      <Badge tone={STATE_TONE[step.state]}>{STATE_LABEL[step.state]}</Badge>
    </div>
  );
}

/**
 * The steps whose fields come from `SellerOnboardingRequirement`.
 *
 * Rendered from the requirements rather than from a fixed list, which is what
 * makes the GSTIN field appear for an Indian seller and the VAT field for a
 * German one without either being written into this component.
 *
 * Fields the schema has a column for are sent by their own names; the rest go
 * into `extraIdentifiers`, keyed by requirement. The server knows which is
 * which - see `REQUIREMENT_COLUMNS`.
 */
const COLUMN_FIELDS = new Set([
  'company_registration_number',
  'tax_registration_number',
  'eori_number',
  'eudamed_srn',
  'representative_name',
  'representative_email',
  'representative_phone',
  'website_url',
  'registered_address',
]);

const COLUMN_NAMES: Record<string, keyof BusinessProfile> = {
  company_registration_number: 'companyRegistrationNumber',
  tax_registration_number: 'taxRegistrationNumber',
  eori_number: 'eoriNumber',
  eudamed_srn: 'eudamedSrn',
  representative_name: 'representativeName',
  representative_email: 'representativeEmail',
  representative_phone: 'representativePhone',
  website_url: 'websiteUrl',
  registered_address: 'registeredAddressLine1',
};

function RequirementForm({
  step,
  isEditable,
}: {
  step: OnboardingStep;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['seller', 'business-profile'],
    queryFn: fetchBusinessProfile,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      const extras: Record<string, string> = {};

      for (const requirement of step.requirements) {
        if (requirement.isDocument) continue;
        const value = values[requirement.fieldKey];
        if (value === undefined) continue;

        if (COLUMN_FIELDS.has(requirement.fieldKey)) {
          patch[COLUMN_NAMES[requirement.fieldKey] ?? requirement.fieldKey] =
            value.trim().length === 0 ? null : value.trim();
        } else {
          extras[requirement.fieldKey] = value.trim();
        }
      }

      if (Object.keys(extras).length > 0) patch['extraIdentifiers'] = extras;

      return saveBusinessProfile(patch);
    },
    onSuccess: async (result) => {
      setIsDirty(false);
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      await client.invalidateQueries({ queryKey: ['seller', 'business-profile'] });

      toast.success(
        result.missing.length === 0
          ? 'Saved. This step is finished.'
          : `Saved. Still needed: ${result.missing.join(', ')}.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Those details could not be saved.'));
    },
  });

  const profile = profileQuery.data?.profile ?? null;
  const extras = profile?.extraIdentifiersJson ?? {};

  /** The stored value for a requirement, whichever side of the split it is on. */
  const storedValue = (fieldKey: string): string => {
    if (COLUMN_FIELDS.has(fieldKey)) {
      const column = COLUMN_NAMES[fieldKey];
      const stored = column === undefined ? null : profile?.[column];
      return typeof stored === 'string' ? stored : '';
    }
    return extras[fieldKey] ?? '';
  };

  const typed = step.requirements.filter((requirement) => !requirement.isDocument);
  const documents = step.requirements.filter((requirement) => requirement.isDocument);

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        {step.message !== null && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {step.message}
          </p>
        )}

        {profileQuery.isPending && <LoadingState label="Loading your answers" />}

        {typed.length === 0 && !profileQuery.isPending && (
          <p className="text-sm text-ink-muted">
            Nothing is asked for at this step in your country.
          </p>
        )}

        <div className="space-y-4">
          {typed.map((requirement) => (
            <Field
              key={requirement.fieldKey}
              label={requirement.label}
              {...(requirement.helpText === null ? {} : { hint: requirement.helpText })}
              required={requirement.isRequired}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  disabled={!isEditable}
                  value={values[requirement.fieldKey] ?? storedValue(requirement.fieldKey)}
                  onChange={(event) => {
                    /*
                     * Read out of the event BEFORE the updater.
                     *
                     * React calls a functional updater during the next render,
                     * by which time it has cleared `currentTarget` on the
                     * synthetic event - so reading it in there throws "Cannot
                     * read properties of null", and the whole Seller Hub goes
                     * to the error screen on the first keystroke of an
                     * application. It has to be captured here, while the
                     * handler is still running.
                     */
                    const { value } = event.currentTarget;

                    setValues((previous) => ({
                      ...previous,
                      [requirement.fieldKey]: value,
                    }));
                    setIsDirty(true);
                  }}
                />
              )}
            </Field>
          ))}
        </div>

        {documents.length > 0 && (
          <div className="rounded-lg border border-border bg-surface-sunken px-4 py-4">
            <h3 className="text-sm font-semibold text-ink">Documents we need</h3>
            <ul className="mt-2 space-y-1.5">
              {documents.map((requirement) => (
                <li key={requirement.fieldKey} className="text-sm text-ink-muted">
                  <span className="text-ink">{requirement.label}</span>
                  {requirement.helpText !== null && ` — ${requirement.helpText}`}
                </li>
              ))}
            </ul>
            {/*
              Stated rather than a button that does nothing. Document upload
              needs object storage and a malware scanner configured, and neither
              is on this deployment - see the implementation plan. Offering an
              upload control that silently fails would be worse than saying so.
            */}
            <p className="mt-3 text-xxs leading-relaxed text-ink-subtle">
              Document uploads need encrypted object storage to be configured for this deployment.
              Until then, send these to the marketplace team and they will attach them to your
              application.
            </p>
          </div>
        )}

        {isEditable && typed.length > 0 && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="primary"
              isLoading={mutation.isPending}
              disabled={!isDirty}
              onClick={() => {
                mutation.mutate();
              }}
            >
              Save
            </Button>
            {isDirty && <span className="text-xxs text-ink-subtle">You have unsaved changes</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

function StoreProfileForm({
  step,
  isEditable,
}: {
  step: OnboardingStep;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const query = useQuery({ queryKey: ['seller', 'business-profile'], queryFn: fetchBusinessProfile });

  /*
   * `null` means "not touched on this visit", and the box falls back to what is
   * stored. Every field is SENT through `edited` below rather than as it sits
   * here, which is the whole bug this closes:
   *
   * a seller who filled in the description and pressed Save sent
   * `supportEmail: null` with it - and a null on the wire means "clear this",
   * so the save wiped the support address they had entered a minute earlier.
   * The step needs both, so it could never be finished from this form, and
   * nothing on the screen said why the tick had not appeared.
   */
  const [description, setDescription] = useState<string | null>(null);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [supportPhone, setSupportPhone] = useState<string | null>(null);

  const account = query.data?.account ?? null;
  const profile = query.data?.profile ?? null;

  /** What is in the box on screen: this visit's edit, or what is stored. */
  const edited = (typed: string | null, stored: string | null | undefined): string =>
    typed ?? stored ?? '';

  /** An emptied box is an absent value, not an empty string - the support
      email is validated as an address and `''` is not one. */
  const orNull = (value: string): string | null =>
    value.trim().length === 0 ? null : value.trim();

  const mutation = useMutation({
    mutationFn: () =>
      saveStoreProfile({
        description: orNull(edited(description, account?.description)),
        supportEmail: orNull(edited(supportEmail, profile?.supportEmail)),
        supportPhone: orNull(edited(supportPhone, profile?.supportPhone)),
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['seller'] });

      toast.success(
        result.missing.length === 0
          ? 'Saved. This step is finished.'
          : `Saved. Still needed: ${result.missing.join(', ')}.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Your store details could not be saved.'));
    },
  });

  return (
    <Card>
      <form
        className="space-y-5 px-6 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <StepHeader step={step} />

        {step.message !== null && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {step.message}
          </p>
        )}

        <Field
          label="Shop name buyers see"
          hint="Chosen when you applied. Contact the marketplace to change it once you are approved."
        >
          {({ inputId }) => <Input id={inputId} disabled value={account?.displayName ?? ''} />}
        </Field>

        <Field
          label="About your business"
          hint="Two or three sentences. This appears on your seller page."
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={4}
              disabled={!isEditable}
              value={edited(description, account?.description)}
              onChange={(event) => {
                setDescription(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Support email" hint="Where buyers reach you about an order.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="email"
                disabled={!isEditable}
                value={edited(supportEmail, profile?.supportEmail)}
                onChange={(event) => {
                  setSupportEmail(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Support phone">
            {({ inputId }) => (
              <Input
                id={inputId}
                type="tel"
                disabled={!isEditable}
                value={edited(supportPhone, profile?.supportPhone)}
                onChange={(event) => {
                  setSupportPhone(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>

        {isEditable && (
          <Button type="submit" variant="primary" isLoading={mutation.isPending}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

function LocationsSummary({ step }: { step: OnboardingStep }): React.JSX.Element {
  const query = useQuery({ queryKey: ['seller', 'locations'], queryFn: fetchLocations });

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        {step.message !== null && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {step.message}
          </p>
        )}

        {query.isPending && <LoadingState label="Loading your addresses" />}

        {query.data !== undefined && query.data.locations.length === 0 && (
          <p className="text-sm text-ink-muted">
            You have not added an address yet. Add one on{' '}
            {/*
              A link, not the name of a screen.
              
              This step cannot be finished from here - the addresses live on the
              profile - so telling somebody where to go and making them find it
              is a step that reads as a dead end.
            */}
            <Link to="/seller/profile" className="font-medium text-brand hover:text-brand-hover">
              your seller profile
            </Link>{' '}
            — you need at least one that can dispatch orders and one that can receive returns,
            which is usually the same place.
          </p>
        )}

        {query.data !== undefined && query.data.locations.length > 0 && (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border">
            {query.data.locations.map((location) => (
              <li key={location.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">
                    {location.name}{' '}
                    <span className="font-normal text-ink-subtle">({location.code})</span>
                  </p>
                  <div className="flex gap-1.5">
                    {location.isPickupLocation && <Badge tone="success">Dispatches</Badge>}
                    {location.isReturnLocation && <Badge tone="brand">Takes returns</Badge>}
                    {!location.isOperational && <Badge tone="danger">Closed</Badge>}
                  </div>
                </div>
                <p className="mt-0.5 text-xxs text-ink-muted">
                  {location.addressLine1}, {location.city} {location.postcode},{' '}
                  {location.countryCode}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * Payout setup.
 *
 * The whole point of this panel is the branch on `isProviderConfigured`. The
 * reference workflow collects an account number and shows a penny-transfer
 * verification; this deployment has no provider that could do either, so it
 * says so and collects nothing. A form that took a seller's bank details into
 * a database with nowhere to send them would be a liability, not a feature.
 */
function PayoutStep({ step }: { step: OnboardingStep }): React.JSX.Element {
  const query = useQuery({ queryKey: ['seller', 'payout-account'], queryFn: fetchPayoutAccount });

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        {query.isPending && <LoadingState label="Checking your payout setup" />}

        {query.data !== undefined && !query.data.isProviderConfigured && (
          <div className="space-y-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-4">
            <Badge tone="warning">Configuration required</Badge>
            <p className="text-sm leading-relaxed text-ink">
              The marketplace has not finished setting up payouts yet, so there is nothing for you
              to connect. This does not hold up your application — you can send it for review
              without this step, and everything you earn is recorded in full in the meantime.
            </p>
            {query.data.missingConfigurationKey !== null && (
              <p className="text-xxs text-ink-muted">
                For the operator: set{' '}
                <code className="rounded bg-surface px-1 py-0.5 font-mono">
                  {query.data.missingConfigurationKey}
                </code>{' '}
                and the Connect return URLs, then sellers can connect their accounts here.
              </p>
            )}
          </div>
        )}

        {query.data !== undefined && query.data.isProviderConfigured && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-ink-muted">
              Payouts are handled by our payment provider. You will be taken to them to enter your
              bank details — we never see or store them.
            </p>
            {query.data.pendingRequirements.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-border bg-surface-sunken px-4 py-3">
                {query.data.pendingRequirements.map((requirement) => (
                  <li key={requirement} className="text-xs text-ink-muted">
                    {requirement}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="primary">Connect your payout account</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Accepting the marketplace agreements.
 *
 * A typed name plus a tick, recorded with the policy version, the time, the
 * address and the browser. It is NOT described anywhere as a verified
 * signature, because nothing here verifies an identity - see the note on
 * `SellerConsentMethod`. Calling it one would be a claim that only matters
 * once, in a dispute, when it turns out to be false.
 */
function AgreementsStep({
  step,
  isEditable,
}: {
  step: OnboardingStep;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  const agreements = [
    { kind: 'MARKETPLACE_AGREEMENT', label: 'Marketplace seller agreement' },
    { kind: 'COMMISSION_SCHEDULE', label: 'Commission schedule' },
    { kind: 'RETURNS_POLICY', label: 'Returns and refunds policy' },
    { kind: 'PRIVACY_POLICY', label: 'Privacy policy' },
    {
      kind: 'INTELLECTUAL_PROPERTY_DECLARATION',
      label: 'Declaration that you are entitled to sell what you list',
    },
  ];

  const mutation = useMutation({
    mutationFn: async () => {
      for (const agreement of agreements) {
        if (!accepted.has(agreement.kind)) continue;
        await acceptAgreement({
          kind: agreement.kind,
          // The version in force. A setting in a real deployment; recorded on
          // every acceptance so "which schedule was this seller on in March"
          // stays answerable when a settlement is disputed.
          version: '2026-09-01',
          acceptedName: name.trim(),
        });
      }
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      toast.success('Recorded. Thank you.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That could not be recorded.'));
    },
  });

  const canSubmit = name.trim().length >= 2 && accepted.size > 0;

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        <ul className="space-y-2">
          {agreements.map((agreement) => (
            <li key={agreement.kind}>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-4 py-3 hover:bg-surface-hover">
                <input
                  type="checkbox"
                  disabled={!isEditable}
                  checked={accepted.has(agreement.kind)}
                  onChange={(event) => {
                    // Captured here rather than inside the updater - see the
                    // note on the requirement fields above.
                    const { checked } = event.currentTarget;

                    setAccepted((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(agreement.kind);
                      else next.delete(agreement.kind);
                      return next;
                    });
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand-fill"
                />
                <span className="text-sm text-ink">I accept the {agreement.label}</span>
              </label>
            </li>
          ))}
        </ul>

        <Field
          label="Your full name"
          hint="Type the name of the person accepting on behalf of the business."
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              disabled={!isEditable}
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-xxs leading-relaxed text-ink-muted">
          We record your acceptance with the version of each document, the date and time, and the
          address and browser you accepted from. This is a record of consent — it is not an
          electronic signature bound to a verified identity, and we do not describe it as one.
        </p>

        {isEditable && (
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Record my acceptance
          </Button>
        )}
      </div>
    </Card>
  );
}

function GenericStep({ step }: { step: OnboardingStep }): React.JSX.Element {
  return (
    <Card>
      <div className="space-y-4 px-6 py-5">
        <StepHeader step={step} />

        {step.message !== null && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {step.message}
          </p>
        )}

        {step.requirements.length > 0 && (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border">
            {step.requirements.map((requirement) => (
              <li key={requirement.fieldKey} className="px-4 py-3">
                <p className="text-sm font-medium text-ink">
                  {requirement.label}
                  {requirement.isRequired && (
                    <span aria-hidden="true" className="ml-0.5 text-danger">
                      *
                    </span>
                  )}
                </p>
                {requirement.helpText !== null && (
                  <p className="mt-0.5 text-xxs text-ink-muted">{requirement.helpText}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {step.key === 'account_verification' && (
          <p className="text-sm leading-relaxed text-ink-muted">
            Your email address and mobile number are confirmed through your UBOSS account. Confirm
            or change either in{' '}
            <Link to="/account/profile" className="font-medium text-brand hover:text-brand-hover">
              your account details
            </Link>
            , and this step will update.
          </p>
        )}

        {step.key === 'compliance' && step.requirements.length === 0 && (
          <p className="text-sm leading-relaxed text-ink-muted">
            No compliance documents are required for the kind of seller you registered as in your
            country.
          </p>
        )}
      </div>
    </Card>
  );
}
