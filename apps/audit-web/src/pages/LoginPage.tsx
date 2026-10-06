/**
 * Signing in.
 *
 * The one screen that says out loud what the console's access model is: there
 * is no sign-up link and there is no "create an account", because every audit
 * account is invited - by the marketplace's administrators, or by an agency
 * administrator for their own agency. A visitor who arrives here without an
 * invitation is told that rather than left hunting for a button that does not
 * exist.
 *
 * WHY ARRIVING HERE WITH A SESSION SHOWS A PANEL RATHER THAN A REDIRECT
 *
 * The carrier portal learned this one the hard way: a sign-in screen that
 * sends anybody already holding a session straight to the dashboard looks,
 * from the outside, like the software picking an organisation by itself. So
 * the session is named instead of acted on. The panel says which agency the
 * browser is signed in for - or that it is the marketplace's own audit team -
 * and offers the two things a person standing here can want: carry on, or
 * sign out and use another account.
 */
import { useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { Button, Callout, Field, Spinner } from '@/components/ui';
import { AuthDivider, BottomGradient, GRADIENT_CTA, GlowInput } from '@/components/ui/auth-form';
import { DemoLoginPanel } from '@/components/DemoLoginPanel';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
import { AuthLayout } from './AuthLayout';

const schema = z.object({
  email: z.string().trim().min(1).pipe(z.email()),
  password: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

export function LoginPage(): React.JSX.Element {
  const { t } = useI18n();
  const { stage, session, notice, signIn, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [failure, setFailure] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  /*
   * Whether the session on screen is one THIS form just opened. A ref rather
   * than state because it must be true the instant the password is accepted,
   * before React has re-rendered with the new session: the panel below would
   * otherwise flash "you are signed in" for a frame at the end of a successful
   * sign-in.
   */
  const signedInHere = useRef(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const { ref: emailRef, ...emailField } = form.register('email');
  const focusEmail = useFocusOnMount<HTMLInputElement>(emailRef);

  const from = (location.state as { from?: string } | null)?.from;

  // The boot request has not answered yet. A spinner rather than the form,
  // because the answer might be "you are already signed in".
  if (stage === 'LOADING') {
    return (
      <AuthLayout heading={t('auth.heading')} subheading={t('auth.subheading')}>
        <div className="flex items-center gap-2.5 py-2 text-sm text-ink-muted">
          <Spinner className="h-4 w-4 text-ink-subtle" />
          <span role="status">{t('auth.checkingSession')}</span>
        </div>
      </AuthLayout>
    );
  }

  // Signed in on this screen a moment ago: take them where they were going.
  if (stage !== 'SIGNED_OUT' && signedInHere.current) {
    return <Navigate to={from ?? '/'} replace />;
  }

  /*
   * A session this browser was already holding. Named, never acted on.
   * Includes the two second-factor stages: Continue puts them back on the
   * wizard, because `RequireSession` renders it in place of whatever they
   * asked for.
   */
  if (stage !== 'SIGNED_OUT' && session !== null) {
    // Marketplace staff belong to no agency; they are the marketplace's own team.
    const agency = session.member.agency?.name ?? t('auth.existing.staffTeam');

    return (
      <AuthLayout heading={t('auth.existing.heading')}>
        <Callout tone="info" role="status" title={t('auth.existing.signedInAs', { agency })}>
          <p>{t('auth.existing.account', { email: session.user.email })}</p>
          <p className="mt-1.5">{t('auth.existing.explain')}</p>
        </Callout>

        <div className="mt-6 space-y-2.5">
          <Button
            className="w-full"
            onClick={() => {
              void navigate(from ?? '/', { replace: true });
            }}
          >
            {t('auth.existing.continue', { agency })}
          </Button>

          <Button
            variant="secondary"
            className="w-full"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              // The stage change is the transition: the form renders next.
              void signOut().finally(() => {
                setLeaving(false);
              });
            }}
          >
            {leaving ? t('auth.existing.signingOut') : t('auth.existing.switch')}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    signedInHere.current = true;

    try {
      await signIn(values.email, values.password);

      void navigate(from ?? '/', { replace: true });
    } catch (error) {
      signedInHere.current = false;

      if (error instanceof NetworkError) {
        setFailure(t('common.couldNotReachServer'));
        return;
      }

      // The server's own message, verbatim: a locked account, a wrong
      // password and an account not yet activated each need something
      // different from the person reading it.
      setFailure(error instanceof ApiError ? error.message : t('common.theRequestFailed'));
    }
  });

  return (
    <AuthLayout heading={t('auth.heading')} subheading={t('auth.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {/* The failure from THIS attempt, or the reason the console refused the
            last session it was handed - an account with no active membership
            signs in successfully and is bounced straight back here. */}
        {(failure ?? notice) === null ? null : (
          <Callout tone="danger" role="alert">
            {failure ?? notice}
          </Callout>
        )}

        <Field label={t('auth.email')} error={form.formState.errors.email?.message}>
          {({ inputId, describedBy }) => (
            <GlowInput
              id={inputId}
              aria-describedby={describedBy}
              {...emailField}
              ref={focusEmail}
              type="email"
              autoComplete="username"
            />
          )}
        </Field>

        <Field label={t('auth.password')} error={form.formState.errors.password?.message}>
          {({ inputId, describedBy }) => (
            <GlowInput
              id={inputId}
              aria-describedby={describedBy}
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
          )}
        </Field>

        <p className="-mt-1 text-right text-sm">
          <Link to="/forgot-password" className="font-medium text-brand hover:underline">
            {t('auth.forgotPassword')}
          </Link>
        </p>

        {/* The same large gradient submit as the storefront, the admin console
            and the carrier portal. */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className={cx('w-full', GRADIENT_CTA)}
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
          <span aria-hidden="true">&rarr;</span>
          <BottomGradient />
        </Button>
      </form>

      <AuthDivider className="my-8" />

      <div className="text-sm">
        <h2 className="font-medium text-ink">{t('auth.noAccountHeading')}</h2>
        <p className="mt-1.5 text-ink-muted">{t('auth.noSelfSignup')}</p>
      </div>

      {/* Renders nothing unless this build was given demo accounts. */}
      <DemoLoginPanel emailLabel={t('auth.email')} passwordLabel={t('auth.password')} />
    </AuthLayout>
  );
}
