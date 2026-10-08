/**
 * Puts the agreement screen in front of the app for a signed-in person who
 * owes it, and gets out of the way for everybody else.
 *
 * The server decides, every time: the screen asks `GET .../agreements` once a
 * person is signed in, and asks again whenever any call is refused with
 * AGREEMENTS_REQUIRED (a version published while they were working, a box
 * cleared in another tab). Nothing is remembered in the browser.
 *
 * The screen covers whatever page was asked for and Continue uncovers it, so
 * the person lands where they were going - a deep link survives the screen.
 * `bypass` lets the app keep a few pages reachable (the public documents,
 * support, privacy requests); the server keeps the same exceptions.
 *
 * The screen is a courtesy. The control is the server, which refuses every
 * other request until both records exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { AgreementScreen, AgreementScreenFrame } from './AgreementScreen';
import type { AgreementScope, AgreementsClient, AgreementStatus } from './types';

export interface AgreementGateProps {
  client: AgreementsClient;
  scope: AgreementScope;
  /** True once a person is fully signed in on this surface. */
  enabled: boolean;
  /** True on a page that stays reachable before the screen is done. */
  bypass?: boolean;
  marketplaceName: string;
  onSignOut: () => void;
  supportHref?: string | null;
  privacyRequestsHref?: string | null;
  /**
   * True for a refusal meaning the screen does not apply at all - the Seller
   * Hub's, for somebody who is not a seller. The app then carries on as it
   * would have, and its own pages explain.
   */
  notApplicable?: (error: unknown) => boolean;
  children: ReactNode;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'not-applicable';

export function AgreementGate({
  client,
  scope,
  enabled,
  bypass = false,
  marketplaceName,
  onSignOut,
  supportHref = null,
  privacyRequestsHref = null,
  notApplicable,
  children,
}: AgreementGateProps): React.JSX.Element {
  const { t, language } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<AgreementStatus | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [asked, setAsked] = useState(0);
  const latest = useRef(0);
  // A ref, so an inline callback does not re-run the request on every render.
  const notApplicableRef = useRef(notApplicable);
  useEffect(() => {
    notApplicableRef.current = notApplicable;
  }, [notApplicable]);

  const load = useCallback(async (): Promise<AgreementStatus | null> => {
    const call = ++latest.current;
    try {
      const fresh = await client.status(scope, language);
      if (call !== latest.current) return fresh;
      setStatus(fresh);
      setPhase('ready');
      // Opened by an incomplete answer, and closed only by Continue - so a
      // person who has just ticked both boxes still sees them until they go on.
      if (!fresh.complete) setIsOpen(true);
      return fresh;
    } catch (error) {
      if (call === latest.current) setPhase(notApplicableRef.current?.(error) === true ? 'not-applicable' : 'error');
      return null;
    }
  }, [client, scope, language]);

  useEffect(() => {
    if (!enabled) {
      latest.current += 1;
      setPhase('idle');
      setStatus(null);
      setIsOpen(false);
      return;
    }
    setPhase((current) => (current === 'ready' ? current : 'loading'));
    void load();
  }, [enabled, load, asked]);

  // Any request refused for want of an agreement asks the server again.
  useEffect(
    () =>
      client.onRequired(() => {
        setAsked((value) => value + 1);
      }),
    [client],
  );

  if (!enabled || bypass || phase === 'not-applicable') return <>{children}</>;

  if (status === null && phase === 'loading') {
    return (
      <AgreementScreenFrame marketplaceName={marketplaceName}>
        <div className="flex items-center justify-center gap-2 text-sm text-ink-muted" role="status">
          <Spinner className="h-5 w-5" />
          <span>{t('agreements.checking')}</span>
        </div>
      </AgreementScreenFrame>
    );
  }

  if (status === null && phase === 'error') {
    // Fail closed: without an answer the app would only meet a wall of
    // refusals. Say so, and offer the two ways out.
    return (
      <AgreementScreenFrame marketplaceName={marketplaceName}>
        <p role="alert" className="text-sm text-ink">
          {t('agreements.loadFailed')}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" variant="ghost" onClick={onSignOut}>
            {t('agreements.signOut')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setAsked((value) => value + 1);
            }}
          >
            {t('agreements.retry')}
          </Button>
        </div>
      </AgreementScreenFrame>
    );
  }

  if (isOpen && status !== null) {
    return (
      <AgreementScreen
        client={client}
        scope={scope}
        status={status}
        onStatus={setStatus}
        onRefresh={load}
        onContinue={() => {
          if (status.complete) setIsOpen(false);
        }}
        onSignOut={onSignOut}
        marketplaceName={marketplaceName}
        supportHref={supportHref}
        privacyRequestsHref={privacyRequestsHref}
      />
    );
  }

  return <>{children}</>;
}
