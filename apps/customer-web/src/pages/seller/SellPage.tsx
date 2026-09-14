/**
 * "Sell on UBOSS" — the public page, and the one that starts an application.
 *
 * Public, and that matters: somebody deciding whether to bring their catalogue
 * here should be able to read what is involved before opening an account. The
 * same reasoning the storefront applies to prices.
 *
 * It does three jobs and changes shape for each:
 *
 *   - **A stranger** reads what selling here means and is sent to sign in.
 *   - **A signed-in buyer** fills in the short form at the bottom and becomes a
 *     seller under the account they already have. No second login, ever.
 *   - **An existing seller** is sent straight to their Hub, because they are
 *     here by mistake or by a stale bookmark.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useI18n } from '@/i18n/i18n-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, Card, Field, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { applyToSell, checkDisplayName, fetchSellerIdentity } from '@/lib/seller';
import { useToast } from '@/components/toast-context';

/** What a seller gets, in the order a seller cares about it. */
const BENEFITS: readonly { title: string; body: string }[] = Object.freeze([
  {
    title: 'Buyers who order by the carton',
    body: 'Businesses, distributors, hospitals and procurement teams buying in quantity — not consumers buying one.',
  },
  {
    title: 'Your catalogue, structured properly',
    body: 'The questions are per category — thread size for a fastener, voltage for a power supply, device class for an instrument — so buyers can filter on them and find you.',
  },
  {
    title: 'Stock across your own warehouses',
    body: 'Hold stock in as many places as you ship from, with dispatch cut-offs and handling times per place.',
  },
  {
    title: 'One order, split by seller',
    body: 'A buyer places one order. You see only your part of it, with its own number and its own dispatch deadline.',
  },
  {
    title: 'Connect your own systems',
    body: 'Push stock and orders to and from your SAP, your monday.com boards or your own API.',
  },
  {
    title: 'Statements that add up',
    body: 'Every sale, commission, fee and refund as a line you can trace back to the order it came from.',
  },
]);

const STEPS: readonly { title: string; body: string }[] = Object.freeze([
  {
    title: 'Tell us who you are',
    body: 'Your registered business name, where it is registered, and the name buyers will see.',
  },
  {
    title: 'Prove it',
    body: 'Registration documents, the authorised representative, and any certificates your trade needs.',
  },
  {
    title: 'Set up where you ship from',
    body: 'One address at minimum, with its dispatch cut-off and how long you need to pick an order.',
  },
  {
    title: 'List your first product',
    body: 'Our questions are per category, so you are only asked what actually applies.',
  },
]);

export function SellPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: 'Sell on UBOSS',
      description:
        'Bring your catalogue to a B2B marketplace built for procurement teams, ' +
        'distributors and businesses that buy in quantity.',
    },
    business.displayName,
  );

  // Runs for a signed-out visitor too. The API answers 401 there, which the
  // query reports as an error rather than as "not a seller" - so an error is
  // treated as "we do not know", which is exactly right for a stranger.
  const identity = useQuery({
    queryKey: ['seller', 'identity'],
    queryFn: fetchSellerIdentity,
    retry: false,
    staleTime: 60_000,
  });

  const seller = identity.data?.seller ?? null;
  const isSignedIn = identity.isSuccess;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:py-16">
      <section className="text-center">
        <p className="text-xxs font-semibold uppercase tracking-[0.2em] text-brand">
          UBOSS Marketplace
        </p>
        <h1 className="mt-3 text-title-2xl text-ink">Sell to businesses that buy in bulk</h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-ink-muted">
          Whatever you supply — components, packaging, equipment, consumables — list it alongside
          other approved sellers, keep your own stock and your own prices, and reach buyers who are
          already ordering here.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {seller !== null ? (
            <ButtonLink to="/seller/dashboard" variant="primary" size="lg">
              Open your Seller Hub
            </ButtonLink>
          ) : isSignedIn ? (
            <a
              href="#apply"
              className="inline-flex h-12 items-center rounded-md bg-brand-fill px-6 text-base font-medium text-white hover:bg-brand-fill-hover"
            >
              Start your application
            </a>
          ) : (
            <>
              <ButtonLink to="/login?next=/sell" variant="primary" size="lg">
                Sign in to apply
              </ButtonLink>
              <ButtonLink to="/register" size="lg">
                Create an account
              </ButtonLink>
            </>
          )}
        </div>

        {seller === null && isSignedIn && (
          <p className="mt-3 text-xs text-ink-subtle">
            You already have an account here — selling uses the same sign-in.
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="text-title-lg text-ink">What you get</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map((benefit) => (
            <li
              key={benefit.title}
              className="rounded-lg border border-border bg-surface px-5 py-4 shadow-card"
            >
              <h3 className="text-sm font-semibold text-ink">{benefit.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{benefit.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-title-lg text-ink">How it works</h2>
        <ol className="mt-6 space-y-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        {/*
          Said plainly, on the public page, because a supplier who finds out
          after two hours of form-filling that they cannot be approved without
          an ISO certificate will not come back.
        */}
        <p className="mt-6 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm leading-relaxed text-ink-muted">
          Every seller is checked before they can list anything. What we ask for depends on the
          country your business is registered in, on whether you manufacture, distribute or resell,
          and on what you intend to sell — a seller of packaging is not asked for the paperwork a
          seller of medical devices is. Applications are usually decided within a few working days.
        </p>
      </section>

      {isSignedIn && seller === null && (
        <section id="apply" className="mt-14 scroll-mt-8">
          <ApplicationForm />
        </section>
      )}

      {!isSignedIn && (
        <section className="mt-14 rounded-lg border border-border bg-surface px-6 py-8 text-center shadow-card">
          <h2 className="text-title-md text-ink">Ready to apply?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
            Sign in with your UBOSS account, or create one. Selling uses the same account you buy
            with — there is no separate seller login.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/login?next=/sell" variant="primary">
              {t('header.signIn')}
            </ButtonLink>
            <ButtonLink to="/register">Create an account</ButtonLink>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The short form that creates the seller organisation.
 *
 * Four fields, deliberately. Everything else is asked during onboarding, where
 * the seller can save and come back - and a twenty-field form in front of
 * somebody who has not decided yet is how an application is abandoned at field
 * nine.
 */
function ApplicationForm(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { localisation } = useStorefront();

  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [country, setCountry] = useState('');
  const [kind, setKind] = useState('RESELLER');
  const [nameState, setNameState] = useState<'idle' | 'checking' | 'free' | 'taken'>('idle');

  const mutation = useMutation({
    mutationFn: () =>
      applyToSell({
        legalName: legalName.trim(),
        displayName: displayName.trim(),
        registrationCountry: country,
        kind: kind as 'MANUFACTURER' | 'AUTHORISED_DISTRIBUTOR' | 'WHOLESALER' | 'RESELLER',
      }),
    onSuccess: () => {
      // Straight to onboarding rather than to a confirmation page. The
      // application exists now; what the seller needs is the next question.
      void navigate('/seller/onboarding');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Your application could not be started.'));
    },
  });

  /** Availability, checked as they type, debounced by hand. */
  const onDisplayNameChange = (value: string): void => {
    setDisplayName(value);
    setNameState(value.trim().length < 2 ? 'idle' : 'checking');

    window.clearTimeout(nameTimer);
    if (value.trim().length < 2) return;

    nameTimer = window.setTimeout(() => {
      void checkDisplayName(value.trim())
        .then((result) => {
          setNameState(result.available ? 'free' : 'taken');
        })
        .catch(() => {
          // A failed check is not a failed name. Left at idle so the seller is
          // not told their name is taken because the network blinked; the
          // server checks it again on submit, which is the one that counts.
          setNameState('idle');
        });
    }, 400);
  };

  const canSubmit =
    legalName.trim().length >= 2 &&
    displayName.trim().length >= 2 &&
    country.length === 2 &&
    nameState !== 'taken';

  return (
    <Card
      title="Start your seller application"
      description="Four answers to begin. You can save and come back to the rest."
    >
      <form
        className="space-y-5 px-6 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <Field
          label="Registered business name"
          hint="Exactly as it appears on your registration document."
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={legalName}
              autoComplete="organization"
              onChange={(event) => {
                setLegalName(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Shop name buyers will see"
          hint={
            nameState === 'free'
              ? 'That name is available.'
              : 'This appears on every listing and every order you take.'
          }
          {...(nameState === 'taken'
            ? { error: 'Another seller already trades under that name.' }
            : {})}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={displayName}
              onChange={(event) => {
                onDisplayNameChange(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Country the business is registered in"
          hint="This decides which documents and tax details we ask you for."
          required
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={country}
              onChange={(event) => {
                setCountry(event.currentTarget.value);
              }}
            >
              <option value="">Choose a country</option>
              {localisation.countries.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="What kind of seller are you?" required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value);
              }}
            >
              <option value="MANUFACTURER">We manufacture what we sell</option>
              <option value="AUTHORISED_DISTRIBUTOR">
                We are an authorised distributor for a manufacturer
              </option>
              <option value="WHOLESALER">We are a wholesaler</option>
              <option value="RESELLER">We resell</option>
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" isLoading={mutation.isPending} disabled={!canSubmit}>
            Start application
          </Button>
          <p className="text-xxs text-ink-subtle">
            Nothing is published until we have approved your account.
          </p>
        </div>
      </form>
    </Card>
  );
}

/** Module-level, so the debounce survives re-renders without a ref. */
let nameTimer = 0;
