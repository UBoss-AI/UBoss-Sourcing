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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/i18n-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, Card, Field, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { applyToSell, checkDisplayName, fetchSellerIdentity } from '@/lib/seller';
import { useToast } from '@/components/toast-context';

type BenefitKey = (typeof BENEFITS)[number]['key'];
type StepKey = (typeof STEPS)[number]['key'];

function benefitTitleKey(key: BenefitKey): `seller.sell.benefit.${BenefitKey}.title` {
  return `seller.sell.benefit.${key}.title`;
}

function benefitBodyKey(key: BenefitKey): `seller.sell.benefit.${BenefitKey}.body` {
  return `seller.sell.benefit.${key}.body`;
}

function stepTitleKey(key: StepKey): `seller.sell.step.${StepKey}.title` {
  return `seller.sell.step.${key}.title`;
}

function stepBodyKey(key: StepKey): `seller.sell.step.${StepKey}.body` {
  return `seller.sell.step.${key}.body`;
}

/**
 * What a seller gets, in the order a seller cares about it.
 *
 * Keys rather than sentences: the words live in the catalogue with the rest of
 * the storefront, so this page reads in the language the visitor chose. The
 * order is the only thing the array still decides.
 */
const BENEFITS = [
  {
    key: 'bulkBuyers',
  },
  {
    key: 'structured',
  },
  {
    key: 'warehouses',
  },
  {
    key: 'splitOrders',
  },
  {
    key: 'integrations',
  },
  {
    key: 'statements',
  },
] as const;

const STEPS = [
  {
    key: 'who',
  },
  {
    key: 'prove',
  },
  {
    key: 'shipFrom',
  },
  {
    key: 'firstProduct',
  },
] as const;

export function SellPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: t('seller.sell.metaTitle'),
      description: t('seller.sell.metaDescription'),
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
          {t('seller.sell.eyebrow')}
        </p>
        <h1 className="mt-3 text-title-2xl text-ink">{t('seller.sell.heading')}</h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-ink-muted">
          {t('seller.sell.lede')}
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {seller !== null ? (
            <ButtonLink to="/seller/dashboard" variant="primary" size="lg">
              {t('seller.sell.openHub')}
            </ButtonLink>
          ) : isSignedIn ? (
            <a
              href="#apply"
              className="inline-flex h-12 items-center rounded-md bg-brand-fill px-6 text-base font-medium text-white hover:bg-brand-fill-hover"
            >
              {t('seller.sell.startApplication')}
            </a>
          ) : (
            <>
              <ButtonLink to="/login?next=/sell" variant="primary" size="lg">
                {t('seller.sell.signInToApply')}
              </ButtonLink>
              <ButtonLink to="/register" size="lg">
                {t('seller.sell.createAccount')}
              </ButtonLink>
            </>
          )}
        </div>

        {seller === null && isSignedIn && (
          <p className="mt-3 text-xs text-ink-subtle">
            {t('seller.sell.sameSignIn')}
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="text-title-lg text-ink">{t('seller.sell.whatYouGet')}</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map((benefit) => (
            <li
              key={benefit.key}
              className="rounded-lg border border-border bg-surface px-5 py-4 shadow-card"
            >
              <h3 className="text-sm font-semibold text-ink">{t(benefitTitleKey(benefit.key))}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {t(benefitBodyKey(benefit.key))}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-title-lg text-ink">{t('seller.sell.howItWorks')}</h2>
        <ol className="mt-6 space-y-4">
          {STEPS.map((step, index) => (
            <li key={step.key} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{t(stepTitleKey(step.key))}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                  {t(stepBodyKey(step.key))}
                </p>
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
          {t('seller.sell.checkedNote')}
        </p>
      </section>

      {isSignedIn && seller === null && (
        <section id="apply" className="mt-14 scroll-mt-8">
          <ApplicationForm />
        </section>
      )}

      {!isSignedIn && (
        <section className="mt-14 rounded-lg border border-border bg-surface px-6 py-8 text-center shadow-card">
          <h2 className="text-title-md text-ink">{t('seller.sell.readyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
            {t('seller.sell.readyBody')}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/login?next=/sell" variant="primary">
              {t('header.signIn')}
            </ButtonLink>
            <ButtonLink to="/register">{t('seller.sell.createAccount')}</ButtonLink>
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
  const client = useQueryClient();
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
    onSuccess: async () => {
      /*
       * Refresh who this account is BEFORE moving, and wait for it.
       *
       * `/sellers/me` is cached for a minute and was answered "not a seller"
       * a moment ago - by the header, on this very page. Navigating without
       * refreshing it sends the new seller into `SellerLayout`, which reads
       * that cached null and redirects them straight back here. The
       * application exists, the screen says it does not, and pressing the
       * button again answers "this account already sells as ..." with nowhere
       * to go. Awaiting the refetch is what makes the Hub open on the
       * application instead.
       */
      await client.invalidateQueries({ queryKey: ['seller'] });

      // Straight to onboarding rather than to a confirmation page. The
      // application exists now; what the seller needs is the next question.
      void navigate('/seller/onboarding');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.sell.applyFailed')));
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
      title={t('seller.sell.formTitle')}
      description={t('seller.sell.formIntro')}
    >
      <form
        className="space-y-5 px-6 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <Field
          label={t('seller.sell.legalName')}
          hint={t('seller.sell.legalNameHint')}
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
          label={t('seller.sell.shopName')}
          hint={
            nameState === 'free' ? t('seller.sell.shopNameFree') : t('seller.sell.shopNameHint')
          }
          {...(nameState === 'taken' ? { error: t('seller.sell.shopNameTaken') } : {})}
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
          label={t('seller.sell.country')}
          hint={t('seller.sell.countryHint')}
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
              <option value="">{t('seller.sell.chooseCountry')}</option>
              {localisation.countries.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('seller.sell.kind')} required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value);
              }}
            >
              <option value="MANUFACTURER">{t('seller.kind.MANUFACTURER')}</option>
              <option value="AUTHORISED_DISTRIBUTOR">
                {t('seller.kind.AUTHORISED_DISTRIBUTOR')}
              </option>
              <option value="WHOLESALER">{t('seller.kind.WHOLESALER')}</option>
              <option value="RESELLER">{t('seller.kind.RESELLER')}</option>
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" isLoading={mutation.isPending} disabled={!canSubmit}>
            {t('seller.sell.startButton')}
          </Button>
          <p className="text-xxs text-ink-subtle">
            {t('seller.sell.nothingPublished')}
          </p>
        </div>
      </form>
    </Card>
  );
}

/** Module-level, so the debounce survives re-renders without a ref. */
let nameTimer = 0;
