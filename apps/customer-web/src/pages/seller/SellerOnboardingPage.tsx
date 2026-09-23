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
 *   - **Save and come back, without pressing Save.** Every step saves on its
 *     own, and every keystroke is kept before that: written to this device at
 *     once, and sent up a couple of seconds after typing stops. Onboarding
 *     takes days, not minutes — documents have to be found and a director has
 *     to be asked — so a form that loses everything to a closed tab, an
 *     expired session or a refused request does not get finished. See
 *     `form-autosave.ts` for which of the two saves promises what.
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
import { BusinessAddressFields } from '@/components/BusinessAddressFields';
import {
  isLegacySingleLineAddress,
  normalisePostalCode,
  validateBusinessAddress,
} from '@/lib/business-address';
import type { BusinessAddress } from '@/lib/business-address';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { useFormAutoSave, type FormAutoSave } from '@/lib/form-autosave';
import { clearAllDrafts, clearDraft, readDraft } from '@/lib/onboarding-draft';
import {
  SELLER_DOCUMENT_KINDS,
  acceptAgreement,
  createDocumentLink,
  documentKindLabel,
  fetchBusinessProfile,
  fetchLocations,
  fetchOnboarding,
  fetchPayoutAccount,
  fetchSellerDocuments,
  saveBusinessProfile,
  saveStoreProfile,
  submitApplication,
  uploadSellerDocument,
  withdrawSellerDocument,
  type BusinessProfile,
  type OnboardingStep,
  type OnboardingStepState,
  type SellerDocument,
  type SellerDocumentKind,
} from '@/lib/seller';
import { LogisticsPartnerPanel } from './LogisticsPartnerPanel';
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
      /*
       * The device copies go, and they go here rather than per step.
       *
       * Once an application is with a reviewer the server holds all of it and
       * the forms turn read-only. A draft offered back at that point would be
       * offering to restore answers nobody can change - so the safety net is
       * taken down at exactly the moment it stops being a safety net.
       */
      clearAllDrafts(seller.sellerAccountId);
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
            <StepPanel step={active} seller={seller} />
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
  seller,
}: {
  step: OnboardingStep;
  seller: SellerOutletContext;
}): React.JSX.Element {
  const isEditable = seller.isApplicationEditable;

  /*
   * Evidence is NOT gated on the application being editable, and the two are
   * genuinely different questions.
   *
   * An approved seller whose ISO certificate runs out next month has to be
   * able to send the renewal, and their application stopped being editable the
   * day they were approved. A seller whose application is with a reviewer is
   * exactly the person who gets asked for another document. The backend has
   * always allowed both; this is what stops the screen hiding the control.
   *
   * What does close it is an account that may not trade at all — there is
   * nothing a rejected or suspended business can fix by uploading a file, and
   * offering the form would be inviting work that leads nowhere.
   */
  const canUpload = seller.status !== 'REJECTED' && seller.status !== 'SUSPENDED';

  switch (step.key) {
    case 'business_identity':
      return (
        <RequirementForm
          step={step}
          isEditable={isEditable}
          sellerAccountId={seller.sellerAccountId}
        />
      );
    /*
     * Identity and documents asks for both, so it draws both: the typed fields
     * above and the evidence panel below. Splitting them across two steps was
     * never an option - "the representative's name" and "photo identification
     * for the representative" are one question asked twice.
     */
    case 'kyb_kyc':
      return (
        <div className="space-y-5">
          <RequirementForm
            step={step}
            isEditable={isEditable}
            sellerAccountId={seller.sellerAccountId}
          />
          <DocumentsStep step={step} isEditable={canUpload} />
        </div>
      );
    case 'compliance':
      return <DocumentsStep step={step} isEditable={canUpload} />;
    case 'store_profile':
      return (
        <StoreProfileForm
          step={step}
          isEditable={isEditable}
          sellerAccountId={seller.sellerAccountId}
        />
      );
    case 'locations':
      return <LocationsSummary step={step} />;
    /*
     * Header and panel, rather than the panel alone.
     *
     * Every other step draws its own `StepHeader` inside its own card. This
     * one renders several cards - what the seller has set up, and the options
     * they have not - so the header sits above them instead of inside the
     * first, which would make the second card look like a separate screen.
     */
    case 'logistics_partner':
      return (
        <div className="space-y-5">
          <Card>
            <div className="space-y-4 px-6 py-5">
              <StepHeader step={step} />

              {step.message !== null && (
                <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
                  {step.message}
                </p>
              )}
            </div>
          </Card>

          <LogisticsPartnerPanel isEditable={isEditable} />
        </div>
      );
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

/**
 * The one requirement that is not a text box.
 *
 * `registered_address` is still a single requirement row — the server still
 * checks one field to decide whether the step is finished, and an operator can
 * still delete the row to stop asking — but what it renders is the six-field
 * address form rather than one input.
 *
 * Singled out by key here rather than by a flag on the requirement, because
 * the requirement table describes what to ASK for and this is a fact about how
 * this application draws it. A deployment that renames the row's label gets
 * its own label; one that deletes the row gets no address form. Neither needs
 * this constant to change.
 *
 * `REQUIREMENT_COLUMNS` on the server maps the same key to
 * `registeredAddressLine1`, so "has the seller answered it?" is still decided
 * by line 1 having something in it. The other five columns are saved beside
 * it and are validated by the API, which is where the real check lives.
 */
const ADDRESS_FIELD_KEY = 'registered_address';

/**
 * A step's unsent answers, as they sit on the device.
 *
 * `fields` is only what has been TYPED on this visit, which is the same thing
 * the form itself holds: an untouched box falls back to what is stored, and
 * restoring a draft must not turn "not answered here" into "answered with what
 * the server already had".
 */
interface RequirementDraft {
  fields: Record<string, string>;
  address: BusinessAddress | null;
}

/** The store details step's unsent answers. Null means "not touched". */
interface StoreProfileDraft {
  description: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
}

/**
 * Two fields the API validates as a SHAPE rather than as free text, and the
 * one reason this screen has to know about it.
 *
 * Nothing here is a second copy of the server's rules — the server is still
 * the only thing that decides what is stored. It is a gate on the AUTO-save:
 * `representativeEmail` and `websiteUrl` are checked by the API as an email
 * and a URL, so "jane@" and "example" are refused, and halfway through typing
 * either of them is the normal state of the box rather than a mistake.
 *
 * Without this, every pause in typing an email address would fire a request
 * that comes back 400. Nothing would be lost — the device copy holds it, and a
 * refused auto-save is deliberately silent — but it would be a request per
 * pause for no possible benefit. So the send waits until what is in the box
 * could be accepted, and the Save button remains the way to find out what the
 * server thinks of it.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Empty, or something the API would take as an address. */
function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || EMAIL_SHAPE.test(trimmed);
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSendable(fieldKey: string, value: string): boolean {
  const trimmed = value.trim();

  // Emptying a box is always send-able: it means "clear this", and the API
  // takes a null for every one of these.
  if (trimmed.length === 0) return true;

  // The tightest cap any of these columns has, and the cap on an entry in
  // `extraIdentifiers`. Past it the whole patch is refused, not just the field.
  if (trimmed.length > 255) return false;

  if (fieldKey === 'representative_email') return looksLikeEmail(trimmed);
  if (fieldKey === 'website_url') return looksLikeUrl(trimmed);

  return true;
}

/** A clock time for "saved at 14:05". The seller's own locale and format. */
const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** A date and time for "you typed this on…", which may be days ago. */
const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Where the work is, in one line under the Save button.
 *
 * Every state says something different about who is holding the answers, and
 * the difference is the point: "kept on this device" and "saved" are not the
 * same promise, and a screen that showed one wording for both would be lying
 * for half of the time it was on screen.
 */
function SaveStatus({
  autoSave,
  isDirty,
}: {
  autoSave: FormAutoSave;
  isDirty: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const at = autoSave.changedAt;

  switch (autoSave.status) {
    case 'noStorage':
      return (
        <span className="text-xxs font-medium text-danger">
          {t('sellerOnboarding.autosave.noStorage')}
        </span>
      );
    case 'sessionEnded':
      return (
        <span className="text-xxs font-medium text-warning">
          {t('sellerOnboarding.autosave.sessionEnded')}
        </span>
      );
    case 'saving':
      return (
        <span className="text-xxs text-ink-subtle">{t('sellerOnboarding.autosave.saving')}</span>
      );
    case 'saved':
      return (
        <span className="text-xxs text-success">
          {t('sellerOnboarding.autosave.saved', {
            time: at === null ? CLOCK.format(new Date()) : CLOCK.format(new Date(at)),
          })}
        </span>
      );
    case 'keptLocally':
      return (
        <span className="text-xxs text-ink-subtle">
          {t('sellerOnboarding.autosave.keptLocally')}
        </span>
      );
    case 'pending':
      return (
        <span className="text-xxs text-ink-subtle">{t('sellerOnboarding.autosave.pending')}</span>
      );
    default:
      // Nothing typed since the form opened, or since the last save. The
      // unsaved-changes note is kept for the case the auto-save has not run
      // yet - a form that is dirty and silent is the one people distrust.
      return isDirty ? (
        <span className="text-xxs text-ink-subtle">{t('sellerOnboarding.autosave.unsaved')}</span>
      ) : null;
  }
}

/**
 * The strip that appears when a step opens holding answers nobody sent.
 *
 * Shown rather than restored silently, and that is the whole decision: boxes
 * that quietly disagree with what the marketplace has on file is how somebody
 * submits an address they thought they had changed back. The seller is told
 * where the text came from, when they typed it, and is given one button to
 * throw it away and see what is actually stored.
 */
function RestoredNotice({
  savedAt,
  onDiscard,
}: {
  savedAt: number;
  onDiscard: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="rounded-lg border border-brand/30 bg-brand-soft px-4 py-3">
      <p className="text-sm font-medium text-ink">
        {t('sellerOnboarding.autosave.restoredTitle')}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        {t('sellerOnboarding.autosave.restoredBody', { when: WHEN.format(new Date(savedAt)) })}
      </p>
      <button
        type="button"
        onClick={() => {
          onDiscard();
        }}
        className="mt-2 text-xs font-medium text-brand hover:text-brand-hover"
      >
        {t('sellerOnboarding.autosave.discard')}
      </button>
    </div>
  );
}

/**
 * The stored address, read back into the shape the form holds it in.
 *
 * Nulls become empty strings, because a controlled input cannot take null and
 * a form that swaps between controlled and uncontrolled on first keystroke is
 * the oldest bug in React.
 */
function addressFromProfile(profile: BusinessProfile | null): BusinessAddress {
  return {
    line1: profile?.registeredAddressLine1 ?? '',
    line2: profile?.registeredAddressLine2 ?? '',
    city: profile?.registeredCity ?? '',
    region: profile?.registeredRegion ?? '',
    postcode: profile?.registeredPostcode ?? '',
    country: profile?.registeredCountry ?? '',
  };
}

/** The same address, in the field names the API takes. */
function addressToPatch(address: BusinessAddress): Record<string, string | null> {
  const orNull = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  };

  return {
    registeredAddressLine1: orNull(address.line1),
    registeredAddressLine2: orNull(address.line2),
    registeredCity: orNull(address.city),
    registeredRegion: orNull(address.region),
    // Trimmed and otherwise untouched: never upper-cased, never stripped of
    // spaces or hyphens, and above all never turned into a number. See
    // `normalisePostalCode`.
    registeredPostcode: orNull(normalisePostalCode(address.postcode)),
    // Upper case, because the column is `CHAR(2)` and the `countries` table
    // holds them upper case. The API upper-cases it again; this is so the
    // value sent matches the value shown.
    registeredCountry: orNull(address.country.toUpperCase()),
  };
}

function RequirementForm({
  step,
  isEditable,
  sellerAccountId,
}: {
  step: OnboardingStep;
  isEditable: boolean;
  sellerAccountId: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['seller', 'business-profile'],
    queryFn: fetchBusinessProfile,
  });

  /**
   * What was in these boxes the last time this step was open, unsent.
   *
   * Read once, in a lazy initialiser, and never re-read. A draft is a snapshot
   * of a moment, not a live store: re-reading it on a later render would let a
   * write this very form had just made race the state it made it from.
   *
   * Held in state rather than in a ref so that discarding it re-renders. The
   * notice at the top of the step is drawn from this and has to go when the
   * seller presses discard.
   */
  const [restored, setRestored] = useState(() =>
    readDraft<RequirementDraft>(sellerAccountId, step.key),
  );

  const [values, setValues] = useState<Record<string, string>>(
    () => restored?.values.fields ?? {},
  );
  // Restored work is unsaved work by definition, so the form opens dirty and
  // the auto-save has something to send as soon as it is send-able.
  const [isDirty, setIsDirty] = useState(restored !== null);

  /**
   * The address being edited, or null while nothing has been touched.
   *
   * `null` rather than a copy of the stored address, and this is the same
   * decision `StoreProfileForm` records at length further down: a form that
   * seeds its state from a query has to seed it from a query that has
   * ANSWERED, and this one renders before the profile arrives. Null means
   * "show what is stored"; anything else is this visit's edit.
   *
   * It also means an address the seller has not touched is not SENT, which is
   * what stops a save of the GSTIN field from writing six nulls over an
   * address somebody entered a minute earlier.
   */
  const [address, setAddress] = useState<BusinessAddress | null>(
    () => restored?.values.address ?? null,
  );

  /**
   * Whether the address has been submitted once.
   *
   * Objections are held back until then. A form that reports "enter a valid
   * postal code" against an empty box the moment it renders is a form that
   * opens covered in red, and somebody who has typed nothing has done nothing
   * wrong yet. After a press of Save, every objection is shown at once — all
   * of them, not the first — and the caret goes to the first field with one.
   */
  const [wasSubmitted, setWasSubmitted] = useState(false);

  /** The block the address fields live in, for moving focus into it. */
  const addressRef = useRef<HTMLDivElement>(null);

  /**
   * What this form would send, built once and used by both saves.
   *
   * The Save button and the auto-save must send the same patch — a second
   * answer to "what does this form mean" is how the two end up disagreeing,
   * and the one that runs unattended is the one that would be wrong quietly.
   */
  const buildPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    const extras: Record<string, string> = {};

    for (const requirement of step.requirements) {
      if (requirement.isDocument) continue;

      // The address is six columns and is assembled below, not here. Falling
      // through would write the whole structured address into
      // `registeredAddressLine1` as one string, which is precisely the
      // behaviour this change replaced.
      if (requirement.fieldKey === ADDRESS_FIELD_KEY) continue;

      const value = values[requirement.fieldKey];
      if (value === undefined) continue;

      if (COLUMN_FIELDS.has(requirement.fieldKey)) {
        patch[COLUMN_NAMES[requirement.fieldKey] ?? requirement.fieldKey] =
          value.trim().length === 0 ? null : value.trim();
      } else {
        extras[requirement.fieldKey] = value.trim();
      }
    }

    // Only when it has been edited on this visit. An untouched address is
    // absent from the patch, and an absent field is one the server leaves
    // alone - so saving the tax number cannot blank the address.
    if (address !== null) Object.assign(patch, addressToPatch(address));

    if (Object.keys(extras).length > 0) patch['extraIdentifiers'] = extras;

    return patch;
  };

  const mutation = useMutation({
    mutationFn: () => saveBusinessProfile(buildPatch()),
    onSuccess: async (result) => {
      setIsDirty(false);
      setWasSubmitted(false);
      /*
       * The device copy goes, and the notice with it.
       *
       * The server now holds these answers, so a draft offered back on the
       * next visit would be offering to restore the very thing that is already
       * stored - and the boxes below are about to re-read from the server
       * anyway, so the two would agree while the notice claimed they did not.
       */
      clearDraft(sellerAccountId, step.key);
      setRestored(null);
      /*
       * The local edit is dropped so the form falls back to what is STORED.
       *
       * Not kept: the server trims, upper-cases the country and may have
       * refused part of what was sent, and a box still showing the draft after
       * a successful save is a box that disagrees with the database without
       * saying so. Re-reading is the only version where what is on screen is
       * what was kept.
       */
      setAddress(null);
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      await client.invalidateQueries({ queryKey: ['seller', 'business-profile'] });

      toast.success(
        result.missing.length === 0
          ? 'Saved. This step is finished.'
          : `Saved. Still needed: ${result.missing.join(', ')}.`,
      );
    },
    onError: (error: unknown) => {
      // Nothing is cleared. A seller who has just typed out a registered
      // address and lost the connection must not have to type it again, so
      // `address` is left exactly as it is and the box still holds it.
      toast.error(errorMessage(t, error, 'Those details could not be saved.'));
    },
  });

  const profile = profileQuery.data?.profile ?? null;
  const extras = profile?.extraIdentifiersJson ?? {};

  /** What is in the address boxes: this visit's edit, or what is stored. */
  const shownAddress = address ?? addressFromProfile(profile);

  /**
   * Whether this step asks for the address at all.
   *
   * Read off the requirement rows rather than assumed: a deployment that has
   * deleted the `registered_address` row is not asking for one, and rendering
   * six fields for it anyway would be this component overruling the operator's
   * own configuration.
   */
  const addressRequirement =
    step.requirements.find(
      (requirement) => requirement.fieldKey === ADDRESS_FIELD_KEY && !requirement.isDocument,
    ) ?? null;

  const addressProblems = addressRequirement === null ? {} : validateBusinessAddress(shownAddress);
  const hasAddressProblem = Object.keys(addressProblems).length > 0;

  /**
   * An existing seller whose address predates the structured fields.
   *
   * Their line 1 holds everything they typed into the old single box, and the
   * other five are null. Nothing is parsed out of it — guessing a state and a
   * postcode out of a sentence is how a tax registration ends up against the
   * wrong jurisdiction — so the prose is shown back to them as it was stored
   * and they are asked to fill in the parts.
   */
  const isLegacyAddress = isLegacySingleLineAddress({
    line1: profile?.registeredAddressLine1 ?? null,
    line2: profile?.registeredAddressLine2 ?? null,
    city: profile?.registeredCity ?? null,
    region: profile?.registeredRegion ?? null,
    postcode: profile?.registeredPostcode ?? null,
    country: profile?.registeredCountry ?? null,
  });

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

  /**
   * The auto-save.
   *
   * `canSend` is the interesting argument. It is false for exactly as long as
   * the form holds something the API would refuse — an address without its
   * postcode, an email address halfway through being typed — and while it is
   * false the device copy is the only save. That is not a gap in the promise:
   * a request that comes back 400 has saved nothing either, and the difference
   * between the two is one wasted round trip per pause in typing.
   *
   * It does NOT go through `mutation`. The mutation resets the form to what
   * the server gave back and raises a toast, both of which are right for a
   * button somebody pressed and wrong for something that happens by itself
   * every few seconds: the reset would drop characters typed while the request
   * was in the air, and the toast would appear over and over.
   */
  const autoSave = useFormAutoSave<RequirementDraft>({
    sellerAccountId,
    section: step.key,
    values: { fields: values, address },
    isDirty,
    canSend:
      !hasAddressProblem &&
      typed.every((requirement) => {
        const value = values[requirement.fieldKey];
        return value === undefined || isSendable(requirement.fieldKey, value);
      }),
    enabled: isEditable,
    save: async () => {
      await saveBusinessProfile(buildPatch());

      /*
       * Both queries, and the second one is not optional.
       *
       * The step's tick and the progress bar come from the onboarding query;
       * what the BOXES fall back to comes from the business profile. Leaving
       * the profile stale was a real defect found on screen: an answer the
       * auto-save had sent, whose draft had therefore been dropped, was gone
       * from the box the moment the step was reopened - because the reopened
       * form has no local edit and falls back to a profile the page fetched
       * before the save. The step said "Done" and the field was empty, which
       * is the exact disagreement this feature exists to prevent.
       *
       * It cannot disturb typing. Every box here shows its local edit in
       * preference to the stored value and only falls back when there is no
       * edit, so a fresher profile changes nothing that is being typed into.
       */
      await Promise.all([
        client.invalidateQueries({ queryKey: ['seller', 'onboarding'] }),
        client.invalidateQueries({ queryKey: ['seller', 'business-profile'] }),
      ]);
    },
  });

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        {restored !== null && (
          <RestoredNotice
            savedAt={restored.savedAt}
            onDiscard={() => {
              // Back to what is stored: the typed overrides go, the address
              // edit goes, and the device copy goes with them.
              setValues({});
              setAddress(null);
              setIsDirty(false);
              setWasSubmitted(false);
              setRestored(null);
              autoSave.forgetDraft();
            }}
          />
        )}

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
          {typed.map((requirement) =>
            /*
             * The address is six fields in a section of its own; everything
             * else on this step is one text box.
             *
             * Rendered in the requirement's own place in the list rather than
             * appended below it, so the order an operator set with `sortOrder`
             * is the order on screen — the address sits between the tax number
             * and the website exactly where the seed puts it.
             */
            requirement.fieldKey === ADDRESS_FIELD_KEY ? (
              <section
                key={requirement.fieldKey}
                ref={addressRef}
                aria-labelledby={`${requirement.fieldKey}-heading`}
                className="rounded-lg border border-border-subtle bg-surface-sunken/40 px-4 py-4"
              >
                <h3
                  id={`${requirement.fieldKey}-heading`}
                  className="text-sm font-semibold text-ink"
                >
                  {requirement.label}
                  {requirement.isRequired && (
                    <>
                      <span className="ml-1 text-danger" aria-hidden="true">
                        *
                      </span>
                      <span className="sr-only"> (required)</span>
                    </>
                  )}
                </h3>

                {requirement.helpText !== null && (
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                    {requirement.helpText}
                  </p>
                )}

                {/*
                  An address entered before this form asked for its parts.

                  Shown back as it was stored, with nothing parsed out of it.
                  Splitting "42 Industrial Estate Phase 2 Noida UP 201301" into
                  fields means guessing which word is the state, and a guess
                  that is wrong puts a business in the wrong tax jurisdiction —
                  so the prose stays, the seller is asked to fill in the parts,
                  and what they type is what is kept.
                */}
                {isLegacyAddress && (
                  <div className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5">
                    <p className="text-xs font-medium text-ink">
                      {t('sellerAddress.legacyHeading')}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-ink">
                      {profile?.registeredAddressLine1}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                      {t('sellerAddress.legacyBody')}
                    </p>
                  </div>
                )}

                <div className="mt-4">
                  <BusinessAddressFields
                    value={shownAddress}
                    disabled={!isEditable}
                    // Held back until the first press of Save — an empty form
                    // that opens covered in red is objecting to something
                    // nobody has done yet.
                    problems={wasSubmitted ? addressProblems : {}}
                    onChange={(next) => {
                      setAddress(next);
                      setIsDirty(true);
                    }}
                  />
                </div>
              </section>
            ) : (
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
            ),
          )}
        </div>

        {isEditable && typed.length > 0 && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="primary"
              /*
               * `isLoading` also disables the button, so a second press while
               * the first save is in flight cannot happen. That is the whole
               * of the duplicate-submission guard and it is enough: the
               * mutation is the only path out of this form.
               */
              isLoading={mutation.isPending}
              disabled={!isDirty || mutation.isPending}
              onClick={() => {
                /*
                 * Nothing is sent while the address is incomplete.
                 *
                 * The objections appear all at once — a form that reveals them
                 * one at a time is a form somebody submits five times — and
                 * focus moves to the first field with one, so somebody who
                 * pressed Save at the bottom of a long step is put where the
                 * problem is rather than left to find it.
                 *
                 * `scrollIntoView` as well as `focus`, because focusing an
                 * input inside a collapsed-out-of-view section scrolls it into
                 * the corner of the window rather than showing the section it
                 * belongs to.
                 */
                if (hasAddressProblem) {
                  setWasSubmitted(true);

                  addressRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });

                  // After the render that puts the error markup in place, or
                  // the query below matches the field before it is marked.
                  window.setTimeout(() => {
                    const firstInvalid =
                      addressRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
                      null;
                    firstInvalid?.focus();
                  }, 0);

                  return;
                }

                setWasSubmitted(false);
                mutation.mutate();
              }}
            >
              Save
            </Button>
            <SaveStatus autoSave={autoSave} isDirty={isDirty} />
          </div>
        )}
      </div>
    </Card>
  );
}

function StoreProfileForm({
  step,
  isEditable,
  sellerAccountId,
}: {
  step: OnboardingStep;
  isEditable: boolean;
  sellerAccountId: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const query = useQuery({ queryKey: ['seller', 'business-profile'], queryFn: fetchBusinessProfile });

  /** What was typed here last time and never sent. See `RequirementForm`. */
  const [restored, setRestored] = useState(() =>
    readDraft<StoreProfileDraft>(sellerAccountId, step.key),
  );

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
  const [description, setDescription] = useState<string | null>(
    () => restored?.values.description ?? null,
  );
  const [supportEmail, setSupportEmail] = useState<string | null>(
    () => restored?.values.supportEmail ?? null,
  );
  const [supportPhone, setSupportPhone] = useState<string | null>(
    () => restored?.values.supportPhone ?? null,
  );

  /*
   * Whether anything has been typed on this visit.
   *
   * The three above cannot answer it between them: null means "not touched",
   * but a restored draft arrives already holding values that were never sent,
   * and that is the state the auto-save most needs to know about.
   */
  const [isDirty, setIsDirty] = useState(restored !== null);

  const account = query.data?.account ?? null;
  const profile = query.data?.profile ?? null;

  /** What is in the box on screen: this visit's edit, or what is stored. */
  const edited = (typed: string | null, stored: string | null | undefined): string =>
    typed ?? stored ?? '';

  /** An emptied box is an absent value, not an empty string - the support
      email is validated as an address and `''` is not one. */
  const orNull = (value: string): string | null =>
    value.trim().length === 0 ? null : value.trim();

  /** What this form would send. One answer, used by the button and the clock. */
  const buildPatch = (): {
    description: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
  } => ({
    description: orNull(edited(description, account?.description)),
    supportEmail: orNull(edited(supportEmail, profile?.supportEmail)),
    supportPhone: orNull(edited(supportPhone, profile?.supportPhone)),
  });

  const mutation = useMutation({
    mutationFn: () => saveStoreProfile(buildPatch()),
    onSuccess: async (result) => {
      setIsDirty(false);
      // The server has it, so the device copy and the notice offering it back
      // both go. See the same line in `RequirementForm`.
      clearDraft(sellerAccountId, step.key);
      setRestored(null);
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

  /**
   * The auto-save. Same two saves as `RequirementForm`, one field to gate on.
   *
   * The support email is the only thing here the API checks the shape of, and
   * an address halfway through being typed is not an address — so the send
   * waits for it rather than firing a request per pause that can only come
   * back refused. The description and the phone are free text and gate nothing.
   */
  const autoSave = useFormAutoSave<StoreProfileDraft>({
    sellerAccountId,
    section: step.key,
    values: { description, supportEmail, supportPhone },
    isDirty,
    canSend: looksLikeEmail(edited(supportEmail, profile?.supportEmail)),
    enabled: isEditable,
    save: async () => {
      await saveStoreProfile(buildPatch());
      // Both, for the reason set out on the same line in `RequirementForm`.
      await Promise.all([
        client.invalidateQueries({ queryKey: ['seller', 'onboarding'] }),
        client.invalidateQueries({ queryKey: ['seller', 'business-profile'] }),
      ]);
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

        {restored !== null && (
          <RestoredNotice
            savedAt={restored.savedAt}
            onDiscard={() => {
              setDescription(null);
              setSupportEmail(null);
              setSupportPhone(null);
              setIsDirty(false);
              setRestored(null);
              autoSave.forgetDraft();
            }}
          />
        )}

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
                setIsDirty(true);
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
                  setIsDirty(true);
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
                  setIsDirty(true);
                }}
              />
            )}
          </Field>
        </div>

        {isEditable && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" isLoading={mutation.isPending}>
              Save
            </Button>
            <SaveStatus autoSave={autoSave} isDirty={isDirty} />
          </div>
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

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Certificates, licences and the paperwork behind them.
 *
 * Shown on the two steps that ask for documents - Compliance, and Identity and
 * documents - and it is the same panel on both, because it is the same job: put
 * a file up, and see what the marketplace made of the last one.
 *
 * Three things it is careful to say out loud, because a seller who guesses any
 * of them guesses wrong:
 *
 *   - **Uploading is not approving.** A file sits at "Being checked" until
 *     somebody at the marketplace accepts it, and the badge says so.
 *   - **A refusal comes with the reason.** Written by the reviewer, shown here
 *     in full, because "not accepted" on its own produces the same file
 *     uploaded again.
 *   - **What is required, and what is merely allowed.** A seller of packaging
 *     has no CE certificate and never will; the list below says which of these
 *     their country and trade actually demands, and everything else is offered
 *     rather than asked for.
 */
function DocumentsStep({
  step,
  isEditable,
}: {
  step: OnboardingStep;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const query = useQuery({ queryKey: ['seller', 'documents'], queryFn: fetchSellerDocuments });

  // The requirements this step asks for as FILES. The typed fields on the same
  // step are the requirement form's business, not this panel's.
  const wanted = step.requirements.filter((requirement) => requirement.isDocument);

  const documents = query.data?.documents ?? [];

  const refresh = async (): Promise<void> => {
    // Both, and in that order: the list this panel renders, and the checklist
    // whose tick depends on it. The server has already recomputed the step, so
    // this is re-reading the answer rather than deciding it.
    await client.invalidateQueries({ queryKey: ['seller', 'documents'] });
    await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
  };

  const withdraw = useMutation({
    mutationFn: withdrawSellerDocument,
    onSuccess: async () => {
      await refresh();
      toast.success('Removed.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That document could not be removed.'));
    },
  });

  const open = useMutation({
    mutationFn: createDocumentLink,
    onSuccess: (link) => {
      /*
       * Opened the moment it is minted, never stored.
       *
       * The link is single-use and lives for minutes, so keeping it in state to
       * render as an `<a href>` would produce a control that is dead by the
       * time anybody clicks it. `noopener` because this is a download from our
       * own origin and the new context has no business reaching back.
       */
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That document could not be opened.'));
    },
  });

  return (
    <Card>
      <div className="space-y-5 px-6 py-5">
        <StepHeader step={step} />

        {step.message !== null && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {step.message}
          </p>
        )}

        {/* What this country and trade actually demands. Rendered before the
            upload form, because it is the answer to "what do you want from
            me" and the form is only useful once that is known. */}
        {wanted.length > 0 && (
          <div>
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              What we need from you
            </h3>
            <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
              {wanted.map((requirement) => {
                const answer = documents.find(
                  (document) => document.requirementFieldKey === requirement.fieldKey,
                );

                return (
                  <li key={requirement.fieldKey} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">
                          {requirement.label}
                          {requirement.isRequired && (
                            <span aria-hidden="true" className="ml-0.5 text-danger">
                              *
                            </span>
                          )}
                        </p>
                        {requirement.helpText !== null && (
                          <p className="mt-0.5 max-w-prose text-xxs leading-relaxed text-ink-muted">
                            {requirement.helpText}
                          </p>
                        )}
                      </div>
                      <Badge tone={answer === undefined ? 'neutral' : DOCUMENT_TONE[answer.status]}>
                        {answer === undefined
                          ? requirement.isRequired
                            ? 'Needed'
                            : 'Optional'
                          : DOCUMENT_LABEL[answer.status]}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {step.key === 'compliance' && wanted.length === 0 && (
          <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
            Nothing is required for the kind of seller you registered as in your country. You can
            still attach a CE certificate, a Declaration of Conformity or a quality certificate
            below — buyers of regulated goods ask for them, and having one accepted before you list
            saves a round trip later.
          </p>
        )}

        {isEditable && <DocumentUploadForm requirements={wanted} onUploaded={refresh} />}

        {/* What is already up. Below the form rather than above it, because on
            a first visit there is nothing here and the form is the thing to
            get to. */}
        <div>
          <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            What you have sent us
          </h3>

          {query.isPending && <LoadingState label="Loading your documents" />}

          {query.data !== undefined && documents.length === 0 && (
            <p className="mt-3 text-sm text-ink-muted">Nothing yet.</p>
          )}

          {documents.length > 0 && (
            <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
              {documents.map((document) => (
                <li key={document.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {documentKindLabel(document.kind)}
                      </p>
                      <p className="mt-0.5 truncate text-xxs text-ink-subtle">
                        {document.originalFileName} · {Math.max(1, Math.round(document.byteSize / 1024))} KB
                        {document.expiresOn !== null && ` · expires ${document.expiresOn}`}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge tone={DOCUMENT_TONE[document.status]}>
                        {DOCUMENT_LABEL[document.status]}
                      </Badge>

                      {document.isDownloadable && (
                        <Button
                          isLoading={open.isPending && open.variables === document.id}
                          onClick={() => {
                            open.mutate(document.id);
                          }}
                        >
                          Open
                        </Button>
                      )}

                      {/* Only while it is undecided. A document the
                          marketplace has accepted is part of the record of why
                          this seller was approved, so the way to change it is
                          to upload a newer one. */}
                      {isEditable && document.status === 'PENDING' && (
                        <Button
                          isLoading={withdraw.isPending && withdraw.variables === document.id}
                          onClick={() => {
                            withdraw.mutate(document.id);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>

                  {document.rejectedReason !== null && (
                    <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs leading-relaxed text-ink">
                      {document.rejectedReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

const DOCUMENT_TONE: Record<SellerDocument['status'], 'neutral' | 'brand' | 'success' | 'danger'> = {
  PENDING: 'brand',
  APPROVED: 'success',
  REJECTED: 'danger',
};

const DOCUMENT_LABEL: Record<SellerDocument['status'], string> = {
  PENDING: 'Being checked',
  APPROVED: 'Accepted',
  REJECTED: 'Not accepted',
};

/**
 * The upload form.
 *
 * Its own component so that choosing a file, a kind and two dates does not
 * re-render the list above on every keystroke - and so that the form can reset
 * itself after a successful upload by remounting, which is the one reliable way
 * to clear a file input.
 *
 * The "what is this" picker offers the REQUIREMENTS first where there are any,
 * because attaching a file to the requirement it answers is what lets the
 * checklist tick itself. A free-standing document is still allowed: a seller
 * who wants to send a certificate nobody asked for should be able to.
 */
function DocumentUploadForm({
  requirements,
  onUploaded,
}: {
  requirements: OnboardingStep['requirements'];
  onUploaded: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const [target, setTarget] = useState<string>(
    requirements[0] === undefined ? `kind:${DEFAULT_DOCUMENT_KIND}` : `req:${requirements[0].fieldKey}`,
  );
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (chosen: File) =>
      uploadSellerDocument({
        file: chosen,
        kind: kindFor(target, requirements),
        requirementFieldKey: target.startsWith('req:') ? target.slice(4) : null,
        issuedOn: issuedOn.length === 0 ? null : issuedOn,
        expiresOn: expiresOn.length === 0 ? null : expiresOn,
      }),
    onSuccess: async () => {
      setFile(null);
      setIssuedOn('');
      setExpiresOn('');
      // A file input's value cannot be set to anything but the empty string,
      // and clearing the React state alone leaves the browser still showing
      // the old filename beside the button.
      if (fileRef.current !== null) fileRef.current.value = '';

      await onUploaded();
      toast.success('Uploaded. We will check it and let you know.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That document could not be uploaded.'));
    },
  });

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-sunken px-4 py-4">
      <Field label="What is this document?">
        {({ inputId }) => (
          <select
            id={inputId}
            value={target}
            onChange={(event) => {
              setTarget(event.currentTarget.value);
            }}
            className="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-ink"
          >
            {requirements.length > 0 && (
              <optgroup label="What we asked for">
                {requirements.map((requirement) => (
                  <option key={requirement.fieldKey} value={`req:${requirement.fieldKey}`}>
                    {requirement.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Something else">
              {SELLER_DOCUMENT_KINDS.map((kind) => (
                <option key={kind.value} value={`kind:${kind.value}`}>
                  {kind.label}
                </option>
              ))}
            </optgroup>
          </select>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Issued on" hint="Optional. Leave blank if the document has no date on it.">
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={issuedOn}
              onChange={(event) => {
                setIssuedOn(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Expires on"
          hint="Optional, but worth giving: we warn you before a certificate runs out."
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={expiresOn}
              onChange={(event) => {
                setExpiresOn(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>

      <Field label="The file" hint="A PDF, or a clear photograph or scan. Up to 10 MB.">
        {({ inputId, describedBy }) => (
          <input
            id={inputId}
            aria-describedby={describedBy}
            ref={fileRef}
            type="file"
            // The bytes decide the type on the server whatever this says; this
            // is a hint to the file picker, not a control.
            accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
            }}
            className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand"
          />
        )}
      </Field>

      <Button
        variant="primary"
        isLoading={mutation.isPending}
        disabled={file === null}
        onClick={() => {
          if (file !== null) mutation.mutate(file);
        }}
      >
        Upload
      </Button>
    </div>
  );
}

/** What a free-standing upload defaults to. The one most sellers reach for. */
const DEFAULT_DOCUMENT_KIND: SellerDocumentKind = 'CE_CERTIFICATE';

/**
 * Which enum member to file an upload under.
 *
 * A requirement says what to ASK for; the KIND is what the document is, and the
 * two are not the same field. The mapping is by the words in the requirement's
 * own field key, which is what lets an operator add
 * `ce_certificate_class_iib` as a requirement and have it filed correctly with
 * no code change. Anything unrecognised is OTHER, which is honest - a reviewer
 * reads the requirement label beside it either way.
 */
function kindFor(target: string, requirements: OnboardingStep['requirements']): SellerDocumentKind {
  if (target.startsWith('kind:')) {
    const chosen = target.slice(5);
    const known = SELLER_DOCUMENT_KINDS.find((entry) => entry.value === chosen);
    return known?.value ?? DEFAULT_DOCUMENT_KIND;
  }

  const fieldKey = target.slice(4);
  const requirement = requirements.find((entry) => entry.fieldKey === fieldKey);
  const haystack = `${fieldKey} ${requirement?.label ?? ''}`.toLowerCase();

  if (haystack.includes('ce ') || haystack.includes('ce_')) return 'CE_CERTIFICATE';
  if (haystack.includes('conformity')) return 'DECLARATION_OF_CONFORMITY';
  if (haystack.includes('notified body')) return 'NOTIFIED_BODY_CERTIFICATE';
  if (haystack.includes('quality') || haystack.includes('iso')) return 'ISO_13485';
  if (haystack.includes('licence') || haystack.includes('license')) return 'REGULATORY_LICENCE';
  if (haystack.includes('registration')) return 'BUSINESS_REGISTRATION';
  if (haystack.includes('tax') || haystack.includes('vat')) return 'TAX_CERTIFICATE';
  if (haystack.includes('identity') || haystack.includes('identification')) return 'IDENTITY_PROOF';
  if (haystack.includes('address')) return 'ADDRESS_PROOF';
  if (haystack.includes('bank')) return 'BANK_STATEMENT';

  return 'OTHER';
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
