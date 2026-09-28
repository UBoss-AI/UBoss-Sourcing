/**
 * Support - the one page every Support, Contact support and Help action opens.
 *
 * Built on `ContactWithGlobe`: the heading, then - on the storefront only -
 * the frequently asked questions (`SupportFaq`), so a common question is
 * answered before anybody writes in, then the published contact channels
 * with the globe under them, and a card that holds, depending on who is here,
 *
 *   - the request form, for a signed-in buyer or seller;
 *   - a sign-in prompt that comes back here, for a guest - requests are sent
 *     from an account so that the reply, the order and the company on it are
 *     facts the server knows rather than claims somebody typed;
 *   - a plain "write to us" note, when the operator has switched requests off
 *     (`features.supportTickets`) and runs its own helpdesk;
 *   - and, once sent, the reference and where to follow it.
 *
 * The contact channels are always the operator's published ones - Settings ->
 * Business profile - and are simply absent when none are set. Nothing on this
 * page is a placeholder address.
 *
 * Two surfaces share it. `/support` is the storefront's; `/seller/support` is
 * Seller Hub's, where the request is sent as the seller and the contacts are
 * the marketplace's own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { ContactWithGlobe, type ContactChannel } from '@/components/support/ContactWithGlobe';
import { SupportFaq } from '@/components/support/SupportFaq';
import {
  SupportRequestForm,
  type SupportSentResult,
} from '@/components/support/SupportRequestForm';
import { ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { CheckIcon, MailIcon, PhoneIcon } from '@/components/icons';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_TICKETS_PATH,
  fetchSupportContext,
  type SupportCategory,
  type SupportSurface,
  type SupportTicket,
} from '@/lib/support';
import { useI18n } from '@/i18n/i18n-context';

/** The request card's id; the FAQ's Contact support brings it into view. */
const SUPPORT_FORM_ID = 'support-request';

function channelsFrom(
  contacts: { email: string | null; phone: string | null },
  labels: { email: string; phone: string },
): ContactChannel[] {
  const channels: ContactChannel[] = [];
  if (contacts.email !== null && contacts.email.length > 0) {
    channels.push({
      icon: MailIcon,
      kind: labels.email,
      label: contacts.email,
      href: `mailto:${contacts.email}`,
    });
  }
  if (contacts.phone !== null && contacts.phone.length > 0) {
    channels.push({
      icon: PhoneIcon,
      kind: labels.phone,
      label: contacts.phone,
      href: `tel:${contacts.phone.replace(/[^\d+]/g, '')}`,
    });
  }
  return channels;
}

function Sent({
  ticket,
  acknowledgementQueued,
  files,
  email,
  surface,
  onAnother,
}: {
  ticket: SupportTicket;
  acknowledgementQueued: boolean;
  files: SupportSentResult['files'];
  email: string;
  surface: SupportSurface;
  onAnother: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);

  // Keyboard and screen-reader users are taken to the outcome, not left on a
  // button that no longer exists.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="support-sent">
      <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3">
        <CheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <div>
          <h3 ref={heading} tabIndex={-1} className="font-semibold text-ink focus:outline-none">
            {t('support.sent.title')}
          </h3>
          <p className="mt-1 text-sm text-ink-muted">{t('support.sent.reference')}</p>
          <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-ink">
            {ticket.reference}
          </p>
        </div>
      </div>
      <p className="text-sm text-ink-muted">
        {acknowledgementQueued
          ? t('support.sent.emailQueued', { email })
          : t('support.sent.noEmail')}
      </p>
      {files.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label={t('support.files.chosen')}>
          {files.map((file) => (
            <li key={file.name} className={file.ok ? 'text-ink-muted' : 'text-danger'}>
              {file.ok
                ? t('support.files.attached', { name: file.name })
                : t('support.files.notAttached', { name: file.name, reason: file.message ?? '' })}
            </li>
          ))}
          {files.some((file) => !file.ok) && (
            <li className="text-xs text-ink-muted">{t('support.files.retryOnTicket')}</li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <ButtonLink variant="primary" to={`${SUPPORT_TICKETS_PATH[surface]}/${ticket.reference}`}>
          {t('support.sent.view')}
        </ButtonLink>
        <button
          type="button"
          onClick={onAnother}
          className="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          {t('support.sent.another')}
        </button>
      </div>
    </div>
  );
}

function SignedInCard({ surface }: { surface: SupportSurface }): React.JSX.Element {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [sent, setSent] = useState<SupportSentResult | null>(null);
  // A new form after "send another", so nothing from the last one survives.
  const [formRound, setFormRound] = useState(0);

  const context = useQuery({
    queryKey: ['support-context', surface],
    queryFn: () => fetchSupportContext(surface),
    staleTime: 60_000,
  });

  const requestedCategory = params.get('category');
  const initialCategory = SUPPORT_CATEGORIES.includes(requestedCategory as SupportCategory)
    ? (requestedCategory as SupportCategory)
    : null;

  const another = useCallback(() => {
    setSent(null);
    setFormRound((round) => round + 1);
  }, []);

  if (context.isPending) return <LoadingState label={t('support.loading')} />;
  if (context.isError) {
    return (
      <ErrorState
        error={context.error}
        onRetry={() => {
          void context.refetch();
        }}
      />
    );
  }

  if (!context.data.enabled) {
    return <p className="text-sm text-ink-muted">{t('support.disabled')}</p>;
  }

  if (sent !== null) {
    return (
      <Sent
        ticket={sent.ticket}
        acknowledgementQueued={sent.acknowledgementQueued}
        files={sent.files}
        email={context.data.requester.email}
        surface={surface}
        onAnother={another}
      />
    );
  }

  return (
    <>
      <SupportRequestForm
        key={formRound}
        surface={surface}
        context={context.data}
        initialOrderNumber={params.get('order')}
        initialCategory={initialCategory}
        onSent={setSent}
      />
      <p className="text-sm text-ink-muted">
        <Link to={SUPPORT_TICKETS_PATH[surface]} className="font-medium text-brand hover:underline">
          {t('support.yourRequests')}
        </Link>
      </p>
    </>
  );
}

export function SupportPageView({ surface }: { surface: SupportSurface }): React.JSX.Element {
  const { t } = useI18n();
  const { user, isLoading, isCustomer } = useSession();
  const { business, features } = useStorefront();
  const location = useLocation();

  // Seller Hub asks the marketplace; the storefront shows the shop it is on.
  const sellerContext = useQuery({
    queryKey: ['support-context', surface],
    queryFn: () => fetchSupportContext(surface),
    enabled: surface === 'seller',
    staleTime: 60_000,
  });
  const contacts =
    surface === 'seller'
      ? (sellerContext.data?.contacts ?? { email: null, phone: null })
      : { email: business.supportEmail, phone: business.supportPhone };

  const channels = channelsFrom(contacts, {
    email: t('support.channel.email'),
    phone: t('support.channel.phone'),
  });

  const takesRequests = features.supportTickets !== false;

  let card: React.JSX.Element;
  if (surface === 'storefront' && isLoading) {
    card = <LoadingState label={t('support.loading')} />;
  } else if (!takesRequests && surface === 'storefront') {
    card = <p className="text-sm text-ink-muted">{t('support.disabled')}</p>;
  } else if (surface === 'storefront' && (user === null || !isCustomer)) {
    card = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-ink-muted">{t('support.signIn.body')}</p>
        <ButtonLink
          variant="primary"
          to="/login"
          state={{ from: location.pathname + location.search }}
        >
          {t('support.signIn.action')}
        </ButtonLink>
      </div>
    );
  } else {
    card = <SignedInCard surface={surface} />;
  }

  return (
    <ContactWithGlobe
      titleAs="h1"
      subtitle={t('support.eyebrow')}
      title={t('support.title')}
      description={t('support.description')}
      getInTouchTitle={t('support.getInTouch.title')}
      getInTouchBody={t('support.getInTouch.body')}
      channels={channels}
      noChannelsMessage={t('support.noChannels')}
      // Buyers' questions. Seller Hub's own Support page is not the place.
      lead={surface === 'storefront' ? <SupportFaq formId={SUPPORT_FORM_ID} /> : undefined}
      formId={SUPPORT_FORM_ID}
      formTitle={t('support.form.title')}
      formDescription={
        // "We already know who you are" is only true once somebody has signed in.
        surface === 'storefront' && (user === null || !isCustomer)
          ? t('support.form.descriptionGuest')
          : t('support.form.description')
      }
    >
      {card}
    </ContactWithGlobe>
  );
}

export function SupportPage(): React.JSX.Element {
  return <SupportPageView surface="storefront" />;
}

export function SellerSupportPage(): React.JSX.Element {
  return <SupportPageView surface="seller" />;
}
