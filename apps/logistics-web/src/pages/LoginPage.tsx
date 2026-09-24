/**
 * Signing in.
 *
 * The one screen that says out loud what the portal's access model is: there
 * is no sign-up link and there is no "create an account", because a logistics
 * partner is created by the marketplace and its people are invited. A visitor
 * who arrives here without an invitation should be told that rather than left
 * hunting for a button that does not exist.
 *
 * WHY ARRIVING HERE WITH A SESSION SHOWS A PANEL RATHER THAN A REDIRECT
 *
 * This screen used to send anybody who already had a session straight to
 * `/dashboard`, and that is how the portal came to be accused of choosing the
 * wrong company. An operator created a new carrier, opened the portal to look
 * at it, and landed - with no sign-in form, no prompt and no explanation - on
 * the dashboard of whichever carrier that browser last signed in as. The
 * company on screen was correct for the session the browser was holding and
 * had nothing to do with the carrier just created, but a redirect that says
 * nothing is indistinguishable from the portal picking a tenant by itself.
 *
 * So the session is named instead of acted on. The panel says which company
 * the browser is signed in as and offers the two things a person standing here
 * can actually want: carry on as that company, or sign out and use another
 * account. Nothing is chosen for them, and in particular nothing in the URL -
 * a company id, a code, a name - is allowed to influence it, because the
 * company is the session's, not the address bar's.
 */
import { useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
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
   * Whether the session on screen is one THIS form just opened.
   *
   * A ref rather than state because it must be true the instant the password
   * is accepted, before React has re-rendered with the new session: the panel
   * below would otherwise flash "you are signed in as X" for a frame at the
   * end of a successful sign-in, which is the one moment it is nonsense.
   */
  const signedInHere = useRef(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const { ref: emailRef, ...emailField } = form.register('email');
  const focusEmail = useFocusOnMount<HTMLInputElement>(emailRef);

  const from = (location.state as { from?: string } | null)?.from;

  /*
   * The boot request has not answered yet.
   *
   * A spinner rather than the form, because the form is a lie for as long as
   * the answer might be "you are already signed in as somebody" - and somebody
   * who starts typing a password into it has to be interrupted a beat later.
   */
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

  // The person signed in on this screen a moment ago. Take them where they
  // were going; they know perfectly well who they signed in as.
  if (stage !== 'SIGNED_OUT' && signedInHere.current) {
    return <Navigate to={from ?? '/'} replace />;
  }

  /*
   * A session this browser was already holding when the portal was opened.
   *
   * Named, never acted on. Includes the two second-factor stages: somebody
   * mid-enrolment who presses Back gets this panel rather than a form that
   * would sign them in again, and Continue puts them back on the wizard,
   * because `RequireSession` renders it in place of whatever they asked for.
   */
  if (stage !== 'SIGNED_OUT' && session !== null) {
    const company = session.partner.displayName;

    return (
      <AuthLayout heading={t('auth.existing.heading')}>
        <Callout tone="info" role="status" title={t('auth.existing.signedInAs', { company })}>
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
            {t('auth.existing.continue', { company })}
          </Button>

          <Button
            variant="secondary"
            className="w-full"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              // `signOut` clears this surface's cookies and drops the cached
              // identity, so the form below is what renders next. There is
              // nothing to navigate to: the stage change is the transition.
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

      /*
       * The server's own message, verbatim.
       *
       * It distinguishes a locked account from a wrong password from an
       * account that has not been activated, and each one needs a different
       * thing from the person reading it. Replacing all three with "sign-in
       * failed" would send somebody with a live invitation email hunting for a
       * password they never had.
       */
      setFailure(error instanceof ApiError ? error.message : t('common.theRequestFailed'));
    }
  });

  return (
    <AuthLayout heading={t('auth.heading')} subheading={t('auth.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {/*
          The failure from THIS attempt, or the reason the portal refused the
          last session it was handed. A carrier whose company the marketplace
          has not activated yet signs in successfully and is bounced straight
          back here; `notice` is the only thing that tells them why.
        */}
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

        {/* `primary`, where this used to be the default `secondary`. The
            gradient replaces the fill, so the label has to be the white one
            that goes with a filled button — dark ink on brand blue is the one
            way this restyle could have broken a contrast rule. */}
        {/* `size="lg"`, matching the storefront and the admin panel: their
            submit is the large one, and a button a step smaller on an
            otherwise identical card is the kind of difference nobody can name
            and everybody notices. Full width comes from a class rather than
            the storefront's `fullWidth` prop, which this app's `Button` does
            not carry. */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className={cx('w-full', GRADIENT_CTA)}
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
          {/* Decoration, and hidden as such. In the accessible name this
              button is "Sign in", not "Sign in right arrow". */}
          <span aria-hidden="true">&rarr;</span>
          <BottomGradient />
        </Button>
      </form>

      <AuthDivider className="my-8" />

      {/* The same block the storefront and the admin panel close with,
          answering the same question — "what if I have no account?" — with
          this surface's own answer. It was a single grey line of `text-xs`
          before, which said the same thing in a way that read as a footnote
          rather than as the answer to the question somebody standing here is
          actually asking. */}
      <div className="text-sm">
        <h2 className="font-medium text-ink">{t('auth.noAccountHeading')}</h2>
        <p className="mt-1.5 text-ink-muted">{t('auth.noSelfSignup')}</p>
      </div>

      {/* Renders nothing unless this build was given demo accounts, which is
          every build except a demonstration one. */}
      <DemoLoginPanel emailLabel={t('auth.email')} passwordLabel={t('auth.password')} />
    </AuthLayout>
  );
}
