/**
 * The company application, step by step.
 *
 * Six steps, each saved to the server when the applicant presses Save and
 * continue - never to the browser. Leaving halfway loses nothing, and the
 * application can be finished on another device. They are the same six the
 * sign-up form's indicator shows (`OnboardingSteps`), so the journey reads as
 * one sequence even though its first step - creating the sign-in - happened
 * on another page.
 *
 * Buyer onboarding only. Nothing here asks for what a seller is asked for -
 * no catalogue, commission, payout account, warehouse or carrier - and
 * finishing it grants nothing on the seller side.
 *
 * Every rule that decides what is required lives on the server
 * (`domain/buyer-company-requirements.ts`) and arrives with the application as
 * `requirements` and `problems`. This screen draws from those rather than
 * repeating them, so "what is missing" on screen and the refusal at
 * submission are one answer.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { Link } from 'react-router-dom';
import {
  APPLICANT_RELATIONSHIPS,
  CONSENT_PURPOSES,
  ENTITY_TYPES,
  INDUSTRIES,
  NOT_APPLICABLE_REASONS,
  companyQueryKey,
  confirmEmailCode,
  sendEmailCode,
  submitApplication,
  uploadDocument,
  withdrawDocument,
  type ApplicantRelationship,
  type CompanyApplication,
  type CompanyIdentifier,
  type ConsentPurpose,
  type DocumentKind,
  type EntityType,
  type Industry,
  type ProcurementProfile,
  type Scheme,
} from '@/lib/buyer-companies';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { countryName } from '@/lib/iso-countries';
import {
  EMPTY_ADDRESS,
  addressOf,
  localFileProblem,
  problemText,
  registerFor,
  stepOfField,
  useSaveStep,
  type AddressDraft,
} from './application-logic';
import { AddressFields, CountrySelect, FormAlert } from './application-parts';
import { ONBOARDING_STEPS, OnboardingSteps, type OnboardingStep } from './OnboardingSteps';

const STEPS = ONBOARDING_STEPS;

type StepKey = OnboardingStep;

export function CompanyWizard({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t } = useI18n();
  const [step, setStep] = useState<StepKey>(() => firstIncompleteStep(application));
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Moving to a step moves focus to its heading, so a keyboard or screen
  // reader user is told where they are instead of being left on the button
  // they pressed.
  const go = (next: StepKey): void => {
    setStep(next);
    requestAnimationFrame(() => {
      headingRef.current?.focus();
    });
  };

  const index = STEPS.indexOf(step);
  // Steps saved in this visit. Together with the ones before the first
  // unfinished step on arrival, these are the ones the stepper may call
  // "Complete" - so an untouched step is never ticked just for its position.
  const [saved, setSaved] = useState<ReadonlySet<StepKey>>(() => new Set());
  const next = (): void => {
    setSaved((current) => new Set(current).add(step));
    const following = STEPS[index + 1];
    if (following !== undefined) go(following);
  };
  const back = (): void => {
    const previous = STEPS[index - 1];
    if (previous !== undefined) go(previous);
  };

  const incomplete = useMemo(
    () => new Set<StepKey>(application.problems.map((problem) => stepOfField(problem.field))),
    [application.problems],
  );
  const completed = useMemo(() => {
    const firstOpen = STEPS.findIndex((key) => incomplete.has(key) && key !== 'review');
    const done = new Set<StepKey>();
    STEPS.forEach((key, position) => {
      if (key === 'review' || incomplete.has(key)) return;
      if (saved.has(key) || firstOpen === -1 || position < firstOpen) done.add(key);
    });
    return done;
  }, [incomplete, saved]);

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <OnboardingSteps
        current={step}
        needsAttention={incomplete}
        completed={completed}
        onSelect={go}
        className="lg:sticky lg:top-24 lg:self-start"
      />

      <section aria-labelledby="company-step-heading" className="min-w-0 rounded-xl border border-border bg-surface p-5 shadow-card sm:p-6">
        <p className="hidden text-xs font-semibold uppercase tracking-wider text-ink-subtle lg:block">
          {t('companyWizard.stepOf', { current: String(index + 1), total: String(STEPS.length) })}
        </p>
        {application.prefilledFromSeller && step !== 'review' && (
          <p className="mb-3 rounded-md border border-brand/30 bg-brand-soft px-3 py-2 text-xs leading-relaxed text-ink">
            {t('companyWizard.prefilledFromSeller')}
          </p>
        )}
        <h2 id="company-step-heading" ref={headingRef} tabIndex={-1} className="mt-1 text-lg font-semibold text-ink focus:outline-none">
          {t(`companyWizard.step.${step}` as TranslationKey)}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{t(`companyWizard.intro.${step}` as TranslationKey)}</p>

        <div className="mt-6">
          {step === 'applicant' && <ApplicantStep application={application} onDone={next} />}
          {step === 'business' && <BusinessStep application={application} onDone={next} onBack={back} />}
          {step === 'identifiers' && <IdentifiersStep application={application} onDone={next} onBack={back} />}
          {step === 'addresses' && <AddressesStep application={application} onDone={next} onBack={back} />}
          {step === 'documents' && <DocumentsStep application={application} onDone={next} onBack={back} />}
          {step === 'review' && <ReviewStep application={application} onEdit={go} onBack={back} />}
        </div>
      </section>
    </div>
  );
}

function firstIncompleteStep(application: CompanyApplication): StepKey {
  if (application.status === 'EMAIL_VERIFICATION_PENDING') return 'review';
  if (application.problems.length === 0) return application.status === 'DRAFT' ? 'review' : 'applicant';
  // The earliest step with something missing, in the order the steps are
  // walked - not whichever problem the server happened to list first, which
  // opened a fresh draft on step 2 with step 1 still unanswered above it.
  const needing = new Set(application.problems.map((problem) => stepOfField(problem.field)));
  return STEPS.find((key) => needing.has(key)) ?? 'applicant';
}

function StepButtons({
  onBack,
  saving,
  label,
}: {
  onBack?: () => void;
  saving: boolean;
  label?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
      {onBack === undefined ? <span /> : (
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('companyWizard.back')}
        </Button>
      )}
      <Button type="submit" variant="primary" isLoading={saving}>
        {label ?? t('companyWizard.saveContinue')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. The person applying
// ---------------------------------------------------------------------------

function ApplicantStep({ application, onDone }: { application: CompanyApplication; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { user } = useSession();
  const { save, saving, errors, formError } = useSaveStep(application.id);
  const [jobTitle, setJobTitle] = useState(application.applicant.jobTitle ?? '');
  const [relationship, setRelationship] = useState<ApplicantRelationship | ''>(application.applicant.relationship ?? '');
  const [email, setEmail] = useState(application.business.businessEmail ?? '');
  const [authority, setAuthority] = useState(application.applicant.authorityConfirmed);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          applicant: { jobTitle, relationship: relationship === '' ? null : relationship, authorityConfirmed: authority },
          business: { businessEmail: email },
        }).then((saved) => {
          if (saved !== null) onDone();
        });
      }}
      className="space-y-4"
    >
      <FormAlert message={formError} />

      {/* Who the reviewer will see. Taken from the person's own profile rather
          than asked again, so there is one place to correct it. */}
      <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm">
        <p className="text-ink-muted">{t('companyWizard.applicant.signedInAs', { email: user?.email ?? '' })}</p>
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-ink-subtle">{t('companyWizard.applicant.fullName')}</dt>
            <dd className="break-words text-ink">{application.applicant.fullName ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-ink-subtle">{t('companyWizard.applicant.phone')}</dt>
            <dd className="break-words text-ink">{application.applicant.phone ?? '—'}</dd>
          </div>
        </dl>
        <Link to="/account/profile" className="mt-2 inline-block text-xs font-medium text-brand hover:underline">
          {t('companyWizard.applicant.changeOnProfile')}
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('companyWizard.applicant.jobTitle')} error={errors['applicant.jobTitle']} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="organization-title"
              value={jobTitle}
              invalid={errors['applicant.jobTitle'] !== undefined}
              onChange={(event) => {
                setJobTitle(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label={t('companyWizard.applicant.relationship')}
          {...(relationship === 'AUTHORISED_AGENT' ? { hint: t('companyWizard.applicant.relationshipAgentHint') } : {})}
          error={errors['applicant.relationship']}
          required
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={relationship}
              invalid={errors['applicant.relationship'] !== undefined}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setRelationship(APPLICANT_RELATIONSHIPS.find((entry) => entry === value) ?? '');
              }}
            >
              <option value="">{t('companyWizard.applicant.chooseRelationship')}</option>
              {APPLICANT_RELATIONSHIPS.map((entry) => (
                <option key={entry} value={entry}>{t(`companyRelationship.${entry}` as TranslationKey)}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        label={t('companyWizard.applicant.businessEmail')}
        hint={t('companyWizard.applicant.businessEmailHint')}
        error={errors['business.businessEmail']}
        required
      >
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="email"
            aria-describedby={describedBy}
            autoComplete="email"
            value={email}
            invalid={errors['business.businessEmail'] !== undefined}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
        )}
      </Field>

      <p className="text-xs">
        {application.business.businessEmailVerified ? (
          <Badge tone="success">{t('companyWizard.applicant.emailVerified')}</Badge>
        ) : (
          <Badge tone="warning">{t('companyWizard.applicant.emailNotVerified')}</Badge>
        )}
      </p>

      <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0"
          checked={authority}
          onChange={(event) => {
            setAuthority(event.currentTarget.checked);
          }}
        />
        <span>{t('companyWizard.applicant.authority')}</span>
      </label>
      {errors['applicant.authorityConfirmed'] !== undefined && (
        <p role="alert" className="text-xs font-medium text-danger">{errors['applicant.authorityConfirmed']}</p>
      )}

      <StepButtons saving={saving} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2. The registered business
// ---------------------------------------------------------------------------

interface BusinessForm {
  legalName: string;
  tradingName: string;
  entityType: EntityType | '';
  registrationCountry: string;
  registrationNumber: string;
  incorporationDate: string;
  industry: Industry | '';
  website: string;
  businessPhone: string;
}

function BusinessStep({ application, onDone, onBack }: { application: CompanyApplication; onDone: () => void; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { save, saving, errors, formError } = useSaveStep(application.id);
  const plans = useBuyingPlans(application);
  const [form, setForm] = useState<BusinessForm>({
    legalName: application.business.legalName ?? '',
    tradingName: application.business.tradingName ?? '',
    entityType: application.business.entityType ?? '',
    registrationCountry: application.business.registrationCountry ?? '',
    registrationNumber: application.business.registrationNumber ?? '',
    incorporationDate: application.business.incorporationDate ?? '',
    industry: application.business.industry ?? '',
    website: application.business.website ?? '',
    businessPhone: application.business.businessPhone ?? '',
  });
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const entityType = form.entityType === '' ? null : form.entityType;
  const register = registerFor(form.registrationCountry === '' ? null : form.registrationCountry, entityType);
  const dateRequired =
    entityType === 'PRIVATE_LIMITED_COMPANY' ||
    entityType === 'PUBLIC_LIMITED_COMPANY' ||
    entityType === 'LIMITED_LIABILITY_PARTNERSHIP' ||
    entityType === 'COOPERATIVE';

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          business: {
            legalName: form.legalName,
            tradingName: form.tradingName,
            entityType,
            registrationCountry: form.registrationCountry === '' ? null : form.registrationCountry,
            registrationNumber: form.registrationNumber,
            incorporationDate: form.incorporationDate === '' ? null : form.incorporationDate,
            industry: form.industry === '' ? null : form.industry,
            website: form.website,
            businessPhone: form.businessPhone,
          },
          procurement: plans.value(),
        }).then((saved) => {
          if (saved !== null) onDone();
        });
      }}
    >
      <FormAlert message={formError} />

      <Field label={t('companyWizard.business.legalName')} hint={t('companyWizard.business.legalNameHint')} error={errors['business.legalName']} required>
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} autoComplete="organization" value={form.legalName} invalid={errors['business.legalName'] !== undefined} onChange={(event) => { set({ legalName: event.currentTarget.value }); }} />
        )}
      </Field>
      <Field label={t('companyWizard.business.tradingName')} hint={t('companyWizard.business.tradingNameHint')} error={errors['business.tradingName']}>
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} value={form.tradingName} onChange={(event) => { set({ tradingName: event.currentTarget.value }); }} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('companyWizard.business.country')} error={errors['business.registrationCountry']} required>
          {({ inputId, describedBy }) => (
            <CountrySelect id={inputId} describedBy={describedBy} value={form.registrationCountry} invalid={errors['business.registrationCountry'] !== undefined} onChange={(code) => { set({ registrationCountry: code }); }} />
          )}
        </Field>
        <Field label={t('companyWizard.business.entityType')} error={errors['business.entityType']} required>
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy} value={form.entityType} onChange={(event) => { const value = event.currentTarget.value; set({ entityType: ENTITY_TYPES.find((type) => type === value) ?? '' }); }}>
              <option value="">{t('companyWizard.business.chooseEntityType')}</option>
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>{t(`companyEntity.${type}` as TranslationKey)}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        label={t(`companyWizard.register.${register}.label` as TranslationKey)}
        hint={t(`companyWizard.register.${register}.hint` as TranslationKey)}
        error={errors['business.registrationNumber']}
        required
      >
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} value={form.registrationNumber} invalid={errors['business.registrationNumber'] !== undefined} onChange={(event) => { set({ registrationNumber: event.currentTarget.value }); }} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('companyWizard.business.incorporationDate')}
          {...(dateRequired ? {} : { hint: t('companyWizard.business.incorporationDateOptional') })}
          error={errors['business.incorporationDate']}
          required={dateRequired}
        >
          {({ inputId, describedBy }) => (
            <Input id={inputId} type="date" aria-describedby={describedBy} max={new Date().toISOString().slice(0, 10)} value={form.incorporationDate} invalid={errors['business.incorporationDate'] !== undefined} onChange={(event) => { set({ incorporationDate: event.currentTarget.value }); }} />
          )}
        </Field>
        <Field label={t('companyWizard.business.industry')} error={errors['business.industry']} required>
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy} value={form.industry} onChange={(event) => { const value = event.currentTarget.value; set({ industry: INDUSTRIES.find((industry) => industry === value) ?? '' }); }}>
              <option value="">{t('companyWizard.business.chooseIndustry')}</option>
              {INDUSTRIES.map((industry) => (
                <option key={industry} value={industry}>{t(`companyIndustry.${industry}` as TranslationKey)}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('companyWizard.business.website')} hint={t('companyWizard.business.websiteHint')} error={errors['business.website']}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} type="url" inputMode="url" aria-describedby={describedBy} autoComplete="url" value={form.website} invalid={errors['business.website'] !== undefined} onChange={(event) => { set({ website: event.currentTarget.value }); }} />
          )}
        </Field>
        <Field label={t('companyWizard.business.phone')} hint={t('companyWizard.business.phoneHint')} error={errors['business.businessPhone']} required>
          {({ inputId, describedBy }) => (
            <Input id={inputId} type="tel" aria-describedby={describedBy} autoComplete="tel" value={form.businessPhone} invalid={errors['business.businessPhone'] !== undefined} onChange={(event) => { set({ businessPhone: event.currentTarget.value }); }} />
          )}
        </Field>
      </div>

      <BuyingPlansFields plans={plans} />

      <StepButtons onBack={onBack} saving={saving} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// 4. Addresses
// ---------------------------------------------------------------------------

function AddressesStep({ application, onDone, onBack }: { application: CompanyApplication; onDone: () => void; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { save, saving, errors, formError } = useSaveStep(application.id);
  const registered = addressOf(application, 'REGISTERED_OFFICE');
  const [office, setOffice] = useState<AddressDraft>(registered ?? { ...EMPTY_ADDRESS, countryCode: application.business.registrationCountry ?? '' });
  const [operating, setOperating] = useState<AddressDraft | null>(addressOf(application, 'OPERATING'));
  const [billing, setBilling] = useState<AddressDraft | null>(addressOf(application, 'BILLING'));
  const [shipping, setShipping] = useState<AddressDraft | null>(addressOf(application, 'SHIPPING'));
  const [billingSame, setBillingSame] = useState(billing === null || JSON.stringify(billing) === JSON.stringify(registered));
  const [shippingSame, setShippingSame] = useState(shipping === null || JSON.stringify(shipping) === JSON.stringify(billing ?? registered));

  // The server keys each problem to the position in what was sent; this is
  // the order it is sent in, so a problem can be put back on its block.
  const order: ('REGISTERED_OFFICE' | 'OPERATING' | 'BILLING' | 'SHIPPING')[] = ['REGISTERED_OFFICE', 'OPERATING', 'BILLING', 'SHIPPING'];
  const prefix = (kind: (typeof order)[number]): string => `addresses.${String(order.indexOf(kind))}`;

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const billingValue = billingSame ? office : (billing ?? EMPTY_ADDRESS);
        const shippingValue = shippingSame ? billingValue : (shipping ?? EMPTY_ADDRESS);
        void save({
          addresses: [
            { kind: 'REGISTERED_OFFICE', ...office },
            operating === null ? { kind: 'OPERATING', remove: true } : { kind: 'OPERATING', ...operating },
            { kind: 'BILLING', ...billingValue },
            { kind: 'SHIPPING', ...shippingValue },
          ],
        }).then((saved) => {
          if (saved !== null) onDone();
        });
      }}
    >
      <FormAlert message={formError} />

      <AddressFields legend={t('companyWizard.addresses.registered')} value={office} onChange={setOffice} errors={errors} errorPrefix={prefix('REGISTERED_OFFICE')} />

      <SameAs
        label={t('companyWizard.addresses.operatingSame')}
        checked={operating === null}
        onChange={(same) => {
          setOperating(same ? null : { ...office });
        }}
      />
      {operating !== null && (
        <AddressFields legend={t('companyWizard.addresses.operating')} value={operating} onChange={setOperating} errors={errors} errorPrefix={prefix('OPERATING')} />
      )}

      <SameAs
        label={t('companyWizard.addresses.billingSame')}
        checked={billingSame}
        onChange={(same) => {
          setBillingSame(same);
          if (!same && billing === null) setBilling({ ...office });
        }}
      />
      {!billingSame && (
        <AddressFields legend={t('companyWizard.addresses.billing')} value={billing ?? EMPTY_ADDRESS} onChange={setBilling} errors={errors} errorPrefix={prefix('BILLING')} />
      )}

      <SameAs
        label={t('companyWizard.addresses.shippingSame')}
        checked={shippingSame}
        onChange={(same) => {
          setShippingSame(same);
          if (!same && shipping === null) setShipping({ ...(billingSame ? office : (billing ?? office)) });
        }}
      />
      {!shippingSame && (
        <AddressFields legend={t('companyWizard.addresses.shipping')} value={shipping ?? EMPTY_ADDRESS} onChange={setShipping} errors={errors} errorPrefix={prefix('SHIPPING')} />
      )}

      <StepButtons onBack={onBack} saving={saving} />
    </form>
  );
}

function SameAs({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex items-center gap-3 text-sm text-ink">
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 3. Registration and tax identifiers
// ---------------------------------------------------------------------------

function IdentifiersStep({ application, onDone, onBack }: { application: CompanyApplication; onDone: () => void; onBack: () => void }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { save, saving, errors, formError } = useSaveStep(application.id);
  const requirements = application.requirements.identifiers;
  const [rows, setRows] = useState<CompanyIdentifier[]>(() =>
    requirements.map(
      (requirement) =>
        application.identifiers.find((row) => row.scheme === requirement.scheme) ?? {
          scheme: requirement.scheme,
          value: null,
          notApplicable: false,
          notApplicableReason: null,
        },
    ),
  );

  if (application.business.registrationCountry === null) {
    return (
      <div className="space-y-4">
        <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm text-ink">{t('companyWizard.identifiers.chooseCountryFirst')}</p>
        <div className="flex">
          <Button variant="ghost" onClick={onBack}>{t('companyWizard.back')}</Button>
        </div>
      </div>
    );
  }

  const update = (scheme: Scheme, patch: Partial<CompanyIdentifier>): void => {
    setRows((current) => current.map((row) => (row.scheme === scheme ? { ...row, ...patch } : row)));
  };

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ identifiers: rows }).then((saved) => {
          if (saved !== null) onDone();
        });
      }}
    >
      <FormAlert message={formError} />
      <p className="text-sm text-ink-muted">
        {t('companyWizard.identifiers.forCountry', { country: countryName(application.business.registrationCountry, intlLocale) })}
      </p>

      {requirements.map((requirement, index) => {
        const row = rows[index] ?? { scheme: requirement.scheme, value: null, notApplicable: false, notApplicableReason: null };
        const base = `identifiers.${String(index)}`;
        const error = errors[`${base}.value`] ?? errors[base] ?? errors[`identifiers.${requirement.scheme}`];
        return (
          <fieldset key={requirement.scheme} className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-semibold text-ink">
              {t(`companyScheme.${requirement.scheme}.label` as TranslationKey)}
              {requirement.required ? (
                <span className="ml-2 text-xs font-normal text-danger">{t('companyWizard.required')}</span>
              ) : (
                <span className="ml-2 text-xs font-normal text-ink-subtle">{t('companyWizard.optional')}</span>
              )}
            </legend>
            <p className="text-xs leading-relaxed text-ink-muted">{t(`companyScheme.${requirement.scheme}.hint` as TranslationKey)}</p>

            {!row.notApplicable && (
              <Field label={t('companyWizard.identifiers.value')} error={error}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={row.value ?? ''}
                    invalid={error !== undefined}
                    onChange={(event) => {
                      update(requirement.scheme, { value: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
            )}

            {requirement.allowNotApplicable && (
              <div className="space-y-2">
                <label className="flex items-start gap-3 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={row.notApplicable}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      update(requirement.scheme, {
                        notApplicable: checked,
                        value: checked ? null : row.value,
                        notApplicableReason: checked ? (row.notApplicableReason ?? 'NOT_REGISTERED') : null,
                      });
                    }}
                  />
                  <span>
                    {t('companyWizard.identifiers.notApplicable')}
                    <span className="mt-0.5 block text-xs text-ink-muted">{t('companyWizard.identifiers.notApplicableHelp')}</span>
                  </span>
                </label>
                {row.notApplicable && (
                  <Field label={t('companyWizard.identifiers.reason')} error={errors[`${base}.notApplicableReason`]}>
                    {({ inputId, describedBy }) => (
                      <Select
                        id={inputId}
                        aria-describedby={describedBy}
                        value={row.notApplicableReason ?? 'NOT_REGISTERED'}
                        onChange={(event) => {
                          update(requirement.scheme, { notApplicableReason: event.currentTarget.value as CompanyIdentifier['notApplicableReason'] });
                        }}
                      >
                        {NOT_APPLICABLE_REASONS.map((reason) => (
                          <option key={reason} value={reason}>{t(`companyNotApplicable.${reason}` as TranslationKey)}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
              </div>
            )}
          </fieldset>
        );
      })}

      <StepButtons onBack={onBack} saving={saving} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// 5. Supporting documents
// ---------------------------------------------------------------------------

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

function DocumentsStep({ application, onDone, onBack }: { application: CompanyApplication; onDone: () => void; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-muted">{t('companyWizard.documents.rules')}</p>
      {application.requirements.documents.map((requirement) => (
        <DocumentRequirementBlock key={requirement.kinds.join('|')} application={application} kinds={requirement.kinds} required={requirement.required} purpose={t(`companyDocumentPurpose.${requirement.purpose}` as TranslationKey)} />
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <Button variant="ghost" onClick={onBack}>{t('companyWizard.back')}</Button>
        <Button variant="primary" onClick={onDone}>{t('companyWizard.continue')}</Button>
      </div>
    </div>
  );
}

/** One kind of document asked for: why, what is uploaded already, and an upload control. */
export function DocumentRequirementBlock({
  application,
  kinds,
  required,
  purpose,
  infoRequestId,
}: {
  application: CompanyApplication;
  kinds: DocumentKind[];
  required: boolean;
  purpose: string;
  infoRequestId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<DocumentKind>(kinds[0] ?? 'OTHER');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // 0..1 while a file is on its way; null otherwise.
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadDocument(application.id, kind, file, infoRequestId ?? null, (fraction) => {
        setProgress(fraction);
      }),
    onSettled: () => {
      setProgress(null);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(companyQueryKey(application.id), result.application);
      setDone(t('companyWizard.documents.uploaded'));
      if (inputRef.current !== null) inputRef.current.value = '';
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('companyWizard.documents.uploadFailed')));
    },
  });

  const withdraw = useMutation({
    mutationFn: (documentId: string) => withdrawDocument(application.id, documentId),
    onSuccess: (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  const uploaded = application.documents.filter(
    (document) => kinds.includes(document.kind) && document.status !== 'SUPERSEDED' && document.status !== 'WITHDRAWN',
  );
  const editable = application.actions.edit;

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{kinds.map((entry) => t(`companyDocument.${entry}` as TranslationKey)).join(' / ')}</p>
        {required ? <Badge tone="warning">{t('companyWizard.required')}</Badge> : <Badge>{t('companyWizard.optional')}</Badge>}
      </div>
      <p className="text-xs leading-relaxed text-ink-muted">{purpose}</p>

      {uploaded.length > 0 && (
        <ul className="space-y-1.5">
          {uploaded.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs">
              <span className="font-medium text-ink">{t(`companyDocument.${document.kind}` as TranslationKey)}</span>
              <span className="text-ink-muted">{Math.max(1, Math.round(document.sizeBytes / 1024)).toLocaleString()} KB</span>
              <Badge tone={document.status === 'ACCEPTED' ? 'success' : document.status === 'REJECTED' ? 'danger' : 'neutral'}>
                {t(`companyDocumentStatus.${document.status}` as TranslationKey)}
              </Badge>
              {document.reviewReason !== null && <span className="basis-full text-danger">{document.reviewReason}</span>}
              {editable && document.status === 'PENDING_REVIEW' && (
                <button
                  type="button"
                  className="ml-auto font-medium text-danger hover:underline"
                  onClick={() => {
                    setError(null);
                    withdraw.mutate(document.id);
                  }}
                >
                  {t('companyWizard.documents.withdraw')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <div className="flex flex-wrap items-end gap-3">
          {kinds.length > 1 && (
            <Field label={t('companyWizard.documents.kind')}>
              {({ inputId, describedBy }) => (
                <Select id={inputId} aria-describedby={describedBy} value={kind} onChange={(event) => { setKind(event.currentTarget.value as DocumentKind); }}>
                  {kinds.map((entry) => (
                    <option key={entry} value={entry}>{t(`companyDocument.${entry}` as TranslationKey)}</option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('companyWizard.documents.file')} hint={t('companyWizard.documents.fileHint')}>
            {({ inputId, describedBy }) => (
              <input
                ref={inputRef}
                id={inputId}
                type="file"
                accept={ACCEPT}
                aria-describedby={describedBy}
                disabled={upload.isPending}
                className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file === undefined) return;
                  setError(null);
                  setDone(null);
                  // Said before the bytes leave the browser. The server is
                  // still the authority - it reads the file's own signature,
                  // its size and scans it - but an empty file or a
                  // spreadsheet should not have to be uploaded to be refused.
                  const local = localFileProblem(file);
                  if (local !== null) {
                    setError(t(local));
                    event.currentTarget.value = '';
                    return;
                  }
                  setProgress(0);
                  upload.mutate(file);
                }}
              />
            )}
          </Field>
        </div>
      )}
      {upload.isPending && (
        <div className="space-y-1">
          <p role="status" className="text-xs text-ink-muted">
            {progress === null || progress >= 1
              ? t('companyWizard.documents.checking')
              : t('companyWizard.documents.uploadingPercent', { percent: String(Math.round(progress * 100)) })}
          </p>
          <div
            role="progressbar"
            aria-label={t('companyWizard.documents.uploading')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress ?? 0) * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
          >
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${String(Math.round((progress ?? 0) * 100))}%` }} />
          </div>
        </div>
      )}
      {done !== null && !upload.isPending && <p role="status" className="text-xs text-success">{done}</p>}
      {error !== null && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The optional buying plans (part of step 2)
// ---------------------------------------------------------------------------

const VOLUMES = ['UNDER_1K', '1K_10K', '10K_50K', '50K_250K', 'OVER_250K'] as const;
const USERS = ['1', '2_5', '6_20', 'OVER_20'] as const;

interface BuyingPlans {
  form: ProcurementProfile;
  setForm: (next: ProcurementProfile) => void;
  categoriesText: string;
  setCategoriesText: (next: string) => void;
  value: () => ProcurementProfile;
}

/** The optional "how you plan to buy" answers, saved with the business step. */
function useBuyingPlans(application: CompanyApplication): BuyingPlans {
  const initial = application.procurement ?? {};
  const [form, setForm] = useState<ProcurementProfile>({
    expectedMonthlyVolume: initial.expectedMonthlyVolume ?? null,
    categories: initial.categories ?? [],
    deliveryCountries: initial.deliveryCountries ?? [],
    preferredCurrency: initial.preferredCurrency ?? null,
    paymentTermsInterest: initial.paymentTermsInterest ?? false,
    erpIntegrationInterest: initial.erpIntegrationInterest ?? false,
    expectedUsers: initial.expectedUsers ?? null,
  });
  const [categoriesText, setCategoriesText] = useState((initial.categories ?? []).join(', '));
  return {
    form,
    setForm,
    categoriesText,
    setCategoriesText,
    value: () => ({
      ...form,
      categories: categoriesText
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 20),
    }),
  };
}

/**
 * Optional, and says so. Folded away by default: nothing in it is used to
 * verify the company, and a first-time applicant should not have to read it
 * to reach the Continue button.
 */
function BuyingPlansFields({ plans }: { plans: BuyingPlans }): React.JSX.Element {
  const { t } = useI18n();
  const { localisation } = useStorefront();
  const { form, setForm } = plans;

  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink">
        <span>
          {t('companyWizard.procurement.heading')}{' '}
          <span className="font-normal text-ink-subtle">{t('companyWizard.optional')}</span>
        </span>
        <span aria-hidden="true" className="text-ink-subtle transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-4">
        <p className="text-xs leading-relaxed text-ink-muted">{t('companyWizard.procurement.optionalNote')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('companyWizard.procurement.volume')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={form.expectedMonthlyVolume ?? ''} onChange={(event) => { const value = event.currentTarget.value; setForm({ ...form, expectedMonthlyVolume: value === '' ? null : (value as (typeof VOLUMES)[number]) }); }}>
                <option value="">{t('companyWizard.procurement.notSaying')}</option>
                {VOLUMES.map((volume) => (
                  <option key={volume} value={volume}>{t(`companyWizard.procurement.volume.${volume}` as TranslationKey)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('companyWizard.procurement.users')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={form.expectedUsers ?? ''} onChange={(event) => { const value = event.currentTarget.value; setForm({ ...form, expectedUsers: value === '' ? null : (value as (typeof USERS)[number]) }); }}>
                <option value="">{t('companyWizard.procurement.notSaying')}</option>
                {USERS.map((users) => (
                  <option key={users} value={users}>{t(`companyWizard.procurement.users.${users}` as TranslationKey)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('companyWizard.procurement.currency')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={form.preferredCurrency ?? ''} onChange={(event) => { setForm({ ...form, preferredCurrency: event.currentTarget.value || null }); }}>
                <option value="">{t('companyWizard.procurement.notSaying')}</option>
                {localisation.currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>{currency.code}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('companyWizard.procurement.deliveryCountries')} hint={t('companyWizard.procurement.deliveryCountriesHint')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                multiple
                aria-describedby={describedBy}
                className="h-28 py-1"
                value={form.deliveryCountries ?? []}
                onChange={(event) => {
                  setForm({ ...form, deliveryCountries: [...event.currentTarget.selectedOptions].map((option) => option.value).slice(0, 40) });
                }}
              >
                {localisation.countries.map((country) => (
                  <option key={country.code} value={country.code}>{country.name}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('companyWizard.procurement.categories')} hint={t('companyWizard.procurement.categoriesHint')}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} aria-describedby={describedBy} value={plans.categoriesText} onChange={(event) => { plans.setCategoriesText(event.currentTarget.value); }} />
          )}
        </Field>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.paymentTermsInterest === true} onChange={(event) => { setForm({ ...form, paymentTermsInterest: event.currentTarget.checked }); }} />
          <span>{t('companyWizard.procurement.paymentTerms')}</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.erpIntegrationInterest === true} onChange={(event) => { setForm({ ...form, erpIntegrationInterest: event.currentTarget.checked }); }} />
          <span>{t('companyWizard.procurement.erp')}</span>
        </label>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// 6. Review and declaration
// ---------------------------------------------------------------------------

function ReviewStep({ application, onEdit, onBack }: { application: CompanyApplication; onEdit: (step: StepKey) => void; onBack: () => void }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const queryClient = useQueryClient();
  const { refreshUser } = useSession();
  const [consents, setConsents] = useState<Record<ConsentPurpose, boolean>>({
    ACCURACY_DECLARATION: false,
    BUSINESS_TERMS: false,
    PRIVACY_NOTICE: false,
    AUTHORITY_TO_ACT: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [consentErrors, setConsentErrors] = useState<Set<string>>(new Set());

  const submit = useMutation({
    mutationFn: () => submitApplication(application.id, consents),
    onSuccess: async (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
      await refreshUser();
    },
    onError: (failure) => {
      if (failure instanceof ApiError) {
        setConsentErrors(new Set(failure.details.map((detail) => detail.field ?? '').filter((field) => field.startsWith('consents.'))));
      }
      setError(errorMessage(t, failure));
    },
  });

  const pending = application.status === 'EMAIL_VERIFICATION_PENDING';

  if (pending) return <EmailCodeBox application={application} />;

  const business = application.business;
  const rows: { step: StepKey; label: string; value: string }[] = [
    { step: 'applicant', label: t('companyWizard.applicant.fullName'), value: application.applicant.fullName ?? '' },
    { step: 'applicant', label: t('companyWizard.applicant.phone'), value: application.applicant.phone ?? '' },
    { step: 'applicant', label: t('companyWizard.applicant.jobTitle'), value: application.applicant.jobTitle ?? '' },
    {
      step: 'applicant',
      label: t('companyWizard.applicant.relationship'),
      value: application.applicant.relationship === null ? '' : t(`companyRelationship.${application.applicant.relationship}` as TranslationKey),
    },
    { step: 'applicant', label: t('companyWizard.applicant.businessEmail'), value: business.businessEmail ?? '' },
    { step: 'business', label: t('companyWizard.business.legalName'), value: business.legalName ?? '' },
    { step: 'business', label: t('companyWizard.business.tradingName'), value: business.tradingName ?? '' },
    { step: 'business', label: t('companyWizard.business.entityType'), value: business.entityType === null ? '' : t(`companyEntity.${business.entityType}` as TranslationKey) },
    { step: 'business', label: t('companyWizard.business.country'), value: countryName(business.registrationCountry, intlLocale) },
    { step: 'business', label: t(`companyWizard.register.${application.requirements.register}.label` as TranslationKey), value: business.registrationNumber ?? '' },
    { step: 'business', label: t('companyWizard.business.incorporationDate'), value: business.incorporationDate ?? '' },
    { step: 'business', label: t('companyWizard.business.industry'), value: business.industry === null ? '' : t(`companyIndustry.${business.industry}` as TranslationKey) },
    { step: 'business', label: t('companyWizard.business.website'), value: business.website ?? '' },
    { step: 'business', label: t('companyWizard.business.phone'), value: business.businessPhone ?? '' },
    ...application.addresses.map((address) => ({
      step: 'addresses' as const,
      label: t(`companyAddressKind.${address.kind}` as TranslationKey),
      value: [address.line1, address.line2, address.city, address.region, address.postalCode, countryName(address.countryCode, intlLocale)].filter((part) => part !== null && part !== '').join(', '),
    })),
    ...application.identifiers.map((row) => ({
      step: 'identifiers' as const,
      label: t(`companyScheme.${row.scheme}.label` as TranslationKey),
      value: row.notApplicable ? t(`companyNotApplicable.${row.notApplicableReason ?? 'NOT_REGISTERED'}` as TranslationKey) : (row.value ?? ''),
    })),
    {
      step: 'documents',
      label: t('companyWizard.step.documents'),
      value: String(application.documents.filter((document) => document.status === 'PENDING_REVIEW' || document.status === 'ACCEPTED').length),
    },
  ];

  return (
    <div className="space-y-6">
      {application.problems.length > 0 && (
        <div role="alert" className="rounded-md border border-warning/30 bg-warning-soft p-4 text-sm">
          <p className="font-semibold text-ink">{t('companyWizard.review.missingHeading')}</p>
          <ul className="mt-2 space-y-1">
            {application.problems.map((problem) => (
              <li key={`${problem.field}:${problem.code}`}>
                <button type="button" className="text-left text-brand hover:underline" onClick={() => { onEdit(stepOfField(problem.field)); }}>
                  {t(`companyWizard.step.${stepOfField(problem.field)}` as TranslationKey)}: {problemText(t, problem.code)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row, index) => (
          <div key={`${row.step}-${String(index)}`} className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
            <dt className="text-ink-muted">{row.label}</dt>
            <dd className="min-w-0 break-words text-ink">{row.value === '' ? <span className="text-ink-subtle">{t('companyWizard.review.notGiven')}</span> : row.value}</dd>
            <dd>
              <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => { onEdit(row.step); }}>
                {t('companyWizard.review.edit')}
                <span className="sr-only"> {row.label}</span>
              </button>
            </dd>
          </div>
        ))}
      </dl>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">{t('companyWizard.review.declarationsHeading')}</legend>
        <p className="text-xs text-ink-muted">{t('companyWizard.review.declarationsIntro')}</p>
        {CONSENT_PURPOSES.map((purpose) => (
          <label key={purpose} className={cx('flex items-start gap-3 rounded-md border p-3 text-sm text-ink', consentErrors.has(`consents.${purpose}`) ? 'border-danger' : 'border-border')}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={consents[purpose]}
              onChange={(event) => {
                setConsents({ ...consents, [purpose]: event.currentTarget.checked });
              }}
            />
            <span>{t(`companyConsent.${purpose}` as TranslationKey)}</span>
          </label>
        ))}
        {application.consentVersion !== undefined && (
          <p className="text-xs text-ink-subtle">{t('companyWizard.review.consentVersion', { version: application.consentVersion })}</p>
        )}
      </fieldset>

      <FormAlert message={error} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <Button variant="ghost" onClick={onBack}>{t('companyWizard.back')}</Button>
        <Button
          variant="primary"
          size="lg"
          isLoading={submit.isPending}
          disabled={application.problems.length > 0 || !CONSENT_PURPOSES.every((purpose) => consents[purpose])}
          onClick={() => {
            setError(null);
            setConsentErrors(new Set());
            submit.mutate();
          }}
        >
          {t('companyWizard.review.submit')}
        </Button>
      </div>
    </div>
  );
}

/** "We sent a code to ..." - the one thing between a filled-in application and its review. */
function EmailCodeBox({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { refreshUser } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const confirm = useMutation({
    mutationFn: () => confirmEmailCode(application.id, code.trim()),
    onSuccess: async (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
      await refreshUser();
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  const resend = useMutation({
    mutationFn: () => sendEmailCode(application.id),
    onSuccess: () => {
      setNotice(t('companyWizard.email.resent'));
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        confirm.mutate();
      }}
    >
      <p className="text-sm text-ink">{t('companyWizard.email.sent', { email: application.business.businessEmail ?? '' })}</p>
      <Field label={t('companyWizard.email.code')} error={error ?? undefined}>
        {({ inputId, describedBy }) => (
          <Input
            ref={inputRef}
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            invalid={error !== null}
            className="max-w-[10rem] text-center font-mono text-lg tracking-[0.3em]"
            onChange={(event) => {
              setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        )}
      </Field>
      {notice !== null && <p role="status" className="text-xs text-success">{notice}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" isLoading={confirm.isPending} disabled={code.length !== 6}>
          {t('companyWizard.email.confirm')}
        </Button>
        <Button type="button" variant="ghost" isLoading={resend.isPending} onClick={() => { setError(null); setNotice(null); resend.mutate(); }}>
          {t('companyWizard.email.resend')}
        </Button>
      </div>
    </form>
  );
}
