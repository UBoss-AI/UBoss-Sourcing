/**
 * Set a new password from an emailed reset link.
 *
 * Reached at `/reset-password?token=…`, the URL the backend built. Everything
 * here is shaped by the token being single-use and short-lived: it may be
 * expired, already spent, or simply wrong, and somebody locked out of their
 * account cannot be left guessing which.
 *
 * Two decisions worth keeping:
 *
 *   - **The token is never checked by a separate call first.** No such endpoint
 *     exists, and adding a client-side guess would create a second source of
 *     truth about a one-shot token. The form submits, and the server's own
 *     error code decides what is shown and whether retrying could help.
 *   - **A dead link is not a dead end.** Every terminal failure offers the one
 *     action that recovers it — ask for a fresh link.
 *
 * Validation uses react-hook-form's own rules rather than `zodResolver`, for
 * the reason set out in ChangePasswordPage: `@hookform/resolvers@3` cannot read
 * a `zod@4` error, so a failed validation throws instead of showing a message.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';

interface FormValues {
  newPassword: string;
  confirmPassword: string;
}

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/** Failures no amount of retyping can fix — the link itself is the problem. */
const TERMINAL_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'TOKEN_INVALID',
  'ACCOUNT_DEACTIVATED',
]);

/**
 * Why the link failed, and what to do about it.
 *
 * Takes `t` as an argument rather than reaching for the hook itself. Keeping
 * it a pure function of (language, code) is what makes the message re-render
 * in the new language the moment somebody uses the picker — and on this screen
 * that message is the entire content of the page, so it is exactly the thing
 * they switched language in order to read.
 */
function recoveryFor(
  t: ReturnType<typeof useI18n>['t'],
  code: string,
): { title: string; body: string } {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return { title: t('auth.reset.expiredTitle'), body: t('auth.reset.expiredBody') };
    case 'TOKEN_ALREADY_USED':
      return { title: t('auth.reset.usedTitleAdmin'), body: t('auth.reset.usedBodyAdmin') };
    case 'TOKEN_INVALID':
      return { title: t('auth.reset.invalidTitleAdmin'), body: t('auth.reset.invalidBodyAdmin') };
    case 'ACCOUNT_DEACTIVATED':
      return { title: t('auth.reset.deactivatedTitle'), body: t('auth.reset.deactivatedBody') };
    default:
      return { title: t('auth.reset.unknownTitle'), body: t('auth.reset.unknownBody') };
  }
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        {/* In the shell so it is present on the form, the dead-link panel and
            the success panel alike. This screen is reached straight from an
            email, so it is often the first one somebody sees. */}
        <LanguageSwitcher placement="auth" />

        <div className="mb-6 flex flex-col items-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Failure({ code, message }: { code: string; message: string }): React.JSX.Element {
  const { t } = useI18n();
  const recovery = recoveryFor(t, code);

  return (
    <Shell>
      <div
        role="alert"
        className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
      >
        <h1 className="text-lg font-semibold text-ink">{recovery.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{recovery.body}</p>
        {/* The server's own wording, kept alongside ours rather than replacing
            it — it sometimes carries a detail the generic copy cannot. */}
        <p className="mt-2 text-xs text-ink-subtle">{message}</p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link
            to="/forgot-password"
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {t('auth.reset.emailNewLink')}
          </Link>
          <Link
            to="/login"
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            {t('auth.reset.goToSignIn')}
          </Link>
        </div>
      </div>
    </Shell>
  );
}

export function ResetPasswordPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { t } = useI18n();

  const [isDone, setIsDone] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { newPassword: '', confirmPassword: '' } });

  useEffect(() => {
    if (token !== '' && !isDone) setFocus('newPassword');
  }, [token, isDone, setFocus]);

  // A link with no token never reaches the server: there is nothing to send,
  // and a round trip would only produce the same answer more slowly.
  if (token === '') {
    return <Failure code="TOKEN_INVALID" message={t('auth.reset.noToken')} />;
  }

  const isTerminal = failure !== null && TERMINAL_CODES.has(failure.code);
  if (isTerminal) {
    return <Failure code={failure.code} message={failure.message} />;
  }

  if (isDone) {
    return (
      <Shell>
        <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
          <h1 className="text-lg font-semibold text-success">{t('auth.reset.doneHeading')}</h1>
          <p className="mt-2 text-sm text-ink">{t('auth.reset.doneBody')}</p>
          <div className="mt-6 flex justify-center">
            <Link
              to="/login"
              className="inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-white"
            >
              {t('auth.reset.goToSignIn')}
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFailure(null);

    try {
      await api.post('/admin/auth/password/reset', {
        token,
        newPassword: values.newPassword,
      });
      setIsDone(true);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ code: 'NETWORK', message: error.message });
        return;
      }
      if (error instanceof ApiError) {
        setFailure({ code: error.code, message: error.message });
        return;
      }
      setFailure({ code: 'UNKNOWN', message: t('auth.reset.setFailed') });
    }
  };

  return (
    <Shell>
      <div className="mb-6 text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {t('auth.reset.setHeading')}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{t('auth.reset.onlyYouKnow')}</p>
      </div>

      <form
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {/* A non-terminal failure - a rate limit, a network blip - leaves the
            form in place, because retrying is the right next move. */}
        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {failure.message}
          </div>
        )}

        <Field
          label={t('auth.reset.newPassword')}
          hint={t('auth.passwordHint')}
          error={errors.newPassword?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.newPassword !== undefined}
              {...register('newPassword', {
                required: t('validation.choosePassword'),
                minLength: { value: MIN_LENGTH, message: t('validation.passwordTooShort') },
                maxLength: { value: MAX_LENGTH, message: t('validation.passwordTooLong') },
              })}
            />
          )}
        </Field>

        <Field
          label={t('auth.change.confirmPassword')}
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
              {...register('confirmPassword', {
                required: t('validation.repeatPassword'),
                validate: (value) =>
                  value === getValues('newPassword') || t('validation.passwordsDoNotMatch'),
              })}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
          {t('auth.reset.setSubmit')}
        </Button>
      </form>
    </Shell>
  );
}
