/**
 * Create an account.
 *
 * Two pages in one, chosen by the backend's own flag rather than by anything
 * this build decides. Where `features.selfRegistration` is off — the default —
 * this storefront is invitation-only and the form would post into a 403, so the
 * page states how accounts are actually made and offers the two routes that do
 * work. Where it is on, the same route renders the real form.
 *
 * ## What the form asks, and why each field is there
 *
 *   - **Name** and **email** are the account.
 *   - **Mobile number** because a sourcing order gets chased by phone when a
 *     line is short or a delivery slips, and an email address is no use at four
 *     o'clock on the day.
 *   - **Country** because this catalogue holds a real price per market rather
 *     than converting one. It decides what every price the account is shown is
 *     quoted in — which is also why answering it here means the storefront's
 *     "where are you ordering from?" prompt never has to interrupt the first
 *     visit.
 *   - **Organisation** last, and optional. A buyer acting for a company types
 *     it; a sole trader has nothing to type, and requiring it only teaches
 *     people to write "n/a".
 *
 * ## Two things this page deliberately does NOT do
 *
 * **It never says an email address is already registered.** The backend answers
 * a duplicate identically to a new sign-up and mails the address itself
 * instead, because a form that says "that email is taken" lets anybody walk a
 * list of addresses through it and learn who buys here. This page shows the
 * server's uniform answer and does not try to be more helpful than it.
 *
 * **It does not sign anybody in.** Registration issues no session: the whole
 * point of the confirmation link is that nobody has yet proved they can read
 * the address they typed.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { useStorefront } from '@/app/storefront-context';
import { Button, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

/**
 * Built per render, not once at module scope.
 *
 * The messages inside are translated, and the module is evaluated long before
 * a language has been resolved. A schema frozen at import time would report
 * every validation failure in whatever language the first visitor loaded — the
 * same reasoning as the sign-in page next door.
 */
function buildSchema(t: ReturnType<typeof useI18n>['t']) {
  return z
    .object({
      fullName: z.string().trim().min(1, t('validation.nameRequired')).max(255),
      email: z
        .string()
        .trim()
        .min(1, t('validation.emailRequired'))
        .pipe(z.email(t('validation.emailInvalid'))),
      // Only bounded, never pattern-matched. The shape of a valid mobile number
      // differs by country and changes without notice, so a regex here would
      // reject real numbers to catch typos the confirmation call catches
      // anyway. The server strips it to digits.
      phone: z
        .string()
        .trim()
        .min(6, t('validation.phoneRequired'))
        .max(32, t('validation.phoneTooLong')),
      country: z.string().trim().length(2, t('validation.countryRequired')),
      organization: z.string().trim().max(255).optional(),
      // Mirrors the backend's own policy, and it is the only rule duplicated
      // across the boundary. Somebody choosing a password should be told the
      // requirement while they type rather than have the submission bounced.
      password: z
        .string()
        .min(12, t('validation.passwordTooShort'))
        .max(128, t('validation.passwordTooLong')),
      confirmPassword: z.string(),
      acceptedTerms: z.literal(true, { message: t('validation.acceptTerms') }),
    })
    .refine((values) => values.password === values.confirmPassword, {
      path: ['confirmPassword'],
      message: t('validation.passwordsDoNotMatch'),
    });
}

type FormValues = z.output<ReturnType<typeof buildSchema>>;

interface RegisterResponse {
  registered: boolean;
  requiresApproval: boolean;
  message: string;
}

export function RegisterPage(): React.JSX.Element {
  const { features } = useStorefront();

  // The flag decides which page this is. Rendering the form and letting the
  // backend refuse it would show somebody a sign-up they cannot complete.
  return features.selfRegistration ? <RegistrationForm /> : <InvitationOnly />;
}

// ---------------------------------------------------------------------------
// The real form
// ---------------------------------------------------------------------------

function RegistrationForm(): React.JSX.Element {
  const { business, localisation, features } = useStorefront();
  const { t, language } = useI18n();

  const [submitted, setSubmitted] = useState<{ email: string; requiresApproval: boolean } | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentMeta({ title: t('auth.register.pageTitle'), noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: {
      fullName: '',
      email: '',
      phone: '',
      country: '',
      organization: '',
      password: '',
      confirmPassword: '',
      acceptedTerms: false as never,
    },
  });

  // Shown beside the phone field once a country is picked, so somebody who
  // types a local number can see what it will be read as.
  const selectedCountry = watch('country');
  const dialPrefix =
    localisation.countries.find((entry) => entry.code === selectedCountry)?.phonePrefix ?? null;

  if (submitted !== null) {
    return <CheckYourEmail email={submitted.email} requiresApproval={submitted.requiresApproval} />;
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      const result = await api.post<RegisterResponse>('/auth/register', {
        fullName: values.fullName,
        email: values.email,
        phone: values.phone,
        country: values.country,
        password: values.password,
        organization: values.organization === '' ? null : values.organization,
        acceptedTerms: values.acceptedTerms,
        // So the confirmation email arrives in the language they were reading
        // the shop in, and the account opens in it on first sign-in.
        language,
      });

      setSubmitted({ email: values.email, requiresApproval: result.requiresApproval });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }

      if (error instanceof ApiError) {
        // The server is the authority on which field is wrong — an unsupported
        // country and an unusable phone number both come back keyed to their
        // field, and putting the message on the field beats a banner that makes
        // the reader hunt for it.
        const fieldErrors = error.fieldErrors();
        let placed = false;

        for (const [field, message] of Object.entries(fieldErrors)) {
          if (field in values) {
            setError(field as keyof FormValues, { message });
            placed = true;
          }
        }

        if (!placed) setFormError(error.message);
        return;
      }

      setFormError(t('auth.register.failed'));
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <LanguageSwitcher placement="auth" />

      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t('auth.register.formHeading')}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {t('auth.register.formIntro', { business: business.displayName })}
        </p>
      </div>

      <form
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {formError !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {formError}
          </div>
        )}

        <Field label={t('auth.register.fullName')} error={errors.fullName?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="text"
              autoComplete="name"
              aria-describedby={describedBy}
              invalid={errors.fullName !== undefined}
              {...register('fullName')}
            />
          )}
        </Field>

        <Field label={t('common.emailAddress')} error={errors.email?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="email"
              autoComplete="email"
              aria-describedby={describedBy}
              invalid={errors.email !== undefined}
              {...register('email')}
            />
          )}
        </Field>

        {/* Country before phone, so the dial-prefix hint below is already
            filled in by the time the number is typed. */}
        <Field
          label={t('auth.register.country')}
          hint={t('auth.register.countryHint')}
          error={errors.country?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors.country !== undefined}
              {...register('country')}
            >
              <option value="">{t('auth.register.countryPlaceholder')}</option>
              {localisation.countries.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label={t('auth.register.mobile')}
          hint={
            dialPrefix === null
              ? t('auth.register.mobileHint')
              : t('auth.register.mobileHintPrefix', { prefix: dialPrefix })
          }
          error={errors.phone?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              aria-describedby={describedBy}
              invalid={errors.phone !== undefined}
              {...register('phone')}
            />
          )}
        </Field>

        <Field
          label={t('auth.register.organization')}
          hint={t('auth.register.organizationHint')}
          error={errors.organization?.message}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="text"
              autoComplete="organization"
              aria-describedby={describedBy}
              invalid={errors.organization !== undefined}
              {...register('organization')}
            />
          )}
        </Field>

        <Field
          label={t('auth.register.password')}
          hint={t('auth.register.passwordHint')}
          error={errors.password?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.password !== undefined}
              {...register('password')}
            />
          )}
        </Field>

        <Field
          label={t('auth.register.confirmPassword')}
          error={errors.confirmPassword?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.confirmPassword !== undefined}
              {...register('confirmPassword')}
            />
          )}
        </Field>

        <div>
          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
              aria-describedby={errors.acceptedTerms === undefined ? undefined : 'terms-error'}
              {...register('acceptedTerms')}
            />
            <span>
              {t('auth.register.acceptTerms')}
              {business.policyLinks !== null && Object.keys(business.policyLinks).length > 0 && (
                <>
                  {' ('}
                  {Object.entries(business.policyLinks).map(([label, href], index) => (
                    <span key={label}>
                      {index > 0 && ', '}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-brand hover:underline"
                      >
                        {label}
                      </a>
                    </span>
                  ))}
                  {')'}
                </>
              )}
            </span>
          </label>

          {errors.acceptedTerms?.message !== undefined && (
            <p id="terms-error" role="alert" className="mt-1.5 text-xs font-medium text-danger">
              {errors.acceptedTerms.message}
            </p>
          )}
        </div>

        {/* Said before the form is sent, not after. Somebody who needs to order
            today should learn that an account is reviewed while they still have
            the option of ringing instead. */}
        {features.selfRegistrationRequiresApproval !== false && (
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
            {t('auth.register.approvalNotice')}
          </p>
        )}

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          {t('auth.register.submit')}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-muted">
        {t('auth.register.haveAccount')}{' '}
        <Link to="/login" className="font-medium text-brand hover:underline">
          {t('auth.register.backToSignIn')}
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// After submitting
// ---------------------------------------------------------------------------

/**
 * The one screen shown after a successful post.
 *
 * Its wording is careful on purpose. It says a link has been sent *if this
 * address can have an account here* rather than "we have created your
 * account", because the server answers a duplicate address identically and
 * this page genuinely does not know which happened. Claiming an account was
 * created would be a lie half the time, and telling the reader which case they
 * are in is the enumeration leak the uniform response prevents.
 */
function CheckYourEmail({
  email,
  requiresApproval,
}: {
  email: string;
  requiresApproval: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  useDocumentMeta({ title: t('auth.register.sentHeading'), noIndex: true }, business.displayName);

  const resend = async (): Promise<void> => {
    setResending(true);
    setResendError(null);

    try {
      await api.post('/auth/verify-email/resend', { email });
      setResent(true);
    } catch (error) {
      setResendError(
        error instanceof ApiError || error instanceof NetworkError
          ? error.message
          : t('auth.register.resendFailed'),
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
        <h1 className="text-lg font-semibold text-success">{t('auth.register.sentHeading')}</h1>
        <p className="mt-2 text-sm text-ink">{t('auth.register.sentBody', { email })}</p>
        <p className="mt-2 text-xs text-ink-muted">{t('auth.register.sentSpam')}</p>

        {requiresApproval && (
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            {t('auth.register.sentApproval')}
          </p>
        )}
      </div>

      <div className="mt-5 rounded-lg border border-border bg-surface p-5 text-center text-sm">
        {resent ? (
          <p className="text-ink-muted" role="status">
            {t('auth.register.resent')}
          </p>
        ) : (
          <>
            <p className="text-ink-muted">{t('auth.register.noEmail')}</p>
            <Button
              variant="secondary"
              className="mt-3"
              isLoading={resending}
              onClick={() => {
                void resend();
              }}
            >
              {t('auth.register.resend')}
            </Button>
          </>
        )}

        {resendError !== null && (
          <p role="alert" className="mt-3 text-xs font-medium text-danger">
            {resendError}
          </p>
        )}
      </div>

      <p className="mt-5 text-center text-sm">
        <Link to="/login" className="font-medium text-brand hover:underline">
          {t('auth.register.backToSignIn')}
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invitation-only deployments
// ---------------------------------------------------------------------------

/**
 * What this page was before self-registration existed, and still is wherever
 * the flag is off — which is the default. There is no form here because there
 * is nothing it could post to: `POST /auth/register` answers
 * SELF_REGISTRATION_DISABLED, and no amount of client-side cleverness gets
 * round that.
 */
function InvitationOnly(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();

  useDocumentMeta({ title: t('auth.register.pageTitle'), noIndex: true }, business.displayName);

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <LanguageSwitcher placement="auth" />

      <div className="rounded-lg border border-border bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {t('auth.register.headingByInvitation')}
        </h1>

        <p className="mt-3 text-sm text-ink-muted">
          {/* The business name goes in as a placeholder rather than being
              concatenated onto a fragment: several of these languages put it
              in a different position in the sentence, and Greek inflects the
              article in front of it. */}
          {t('auth.register.bodyByInvitation', { business: business.displayName })}
        </p>

        <div className="mt-6 space-y-3">
          <div className="rounded-md border border-border bg-surface-sunken p-4">
            <h2 className="text-sm font-medium text-ink">{t('auth.register.invitedHeading')}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t('auth.register.invitedBody')}</p>
          </div>

          <div className="rounded-md border border-border bg-surface-sunken p-4">
            <h2 className="text-sm font-medium text-ink">
              {t('auth.register.needAccountHeading')}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              {business.supportEmail === null ? (
                t('auth.register.needAccountNoEmail')
              ) : (
                <EmailSentence
                  // Deliberately called with no variables, so the `{{email}}`
                  // placeholder survives for the split inside to find.
                  template={t('auth.register.needAccountWithEmail')}
                  email={business.supportEmail}
                />
              )}
            </p>
          </div>
        </div>

        <Link
          to="/login"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
        >
          {t('auth.register.backToSignIn')}
        </Link>
      </div>
    </div>
  );
}

/**
 * A translated sentence with a mailto link in the middle of it.
 *
 * The sentence is split on its own `{{email}}` placeholder, so the two halves
 * are whatever the language put either side of the address — in whatever order
 * that language wanted. The obvious alternative, two keys reading "Email" and
 * "and we will set one up", silently forces English word order onto every
 * other catalogue in the directory.
 *
 * A translation that drops the placeholder still renders: the split yields one
 * part, the address follows it, and the reader gets a slightly clumsy sentence
 * rather than a missing email address.
 */
function EmailSentence({
  template,
  email,
}: {
  template: string;
  email: string;
}): React.JSX.Element {
  // i18next's own delimiter, doubled. Splitting on a single brace pair used to
  // leave a stray `{` and `}` either side of the link.
  const [before = '', after = ''] = template.split('{{email}}');

  return (
    <>
      {before}
      <a
        href={`mailto:${email}?subject=New%20account%20request`}
        className="font-medium text-brand hover:underline"
      >
        {email}
      </a>
      {after}
    </>
  );
}
