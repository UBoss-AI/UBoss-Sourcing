/**
 * The Seller Hub's idle warning, and what happens when the time is up.
 *
 * The server owns the clock (see lib/seller-session.ts): this component reads
 * when the open Hub will re-lock, warns SELLER_HUB_IDLE_WARNING_SECONDS before
 * it, and offers exactly two answers.
 *
 *   - Stay signed in: asks the server to renew, and only says "you are still
 *     signed in" once the server has agreed. A failed renewal never leaves a
 *     Hub that looks open and is not.
 *   - Sign out: closes the Hub for this session (the shop stays signed in).
 *
 * When the time runs out it asks the server before believing its own timer -
 * another tab may have kept the Hub open - and when the server says the Hub
 * has re-locked, it clears the Hub's cached data, and the layout draws the
 * lock screen with "Your session expired due to inactivity". Pages that were
 * open unmount with it, which closes their live streams. Every tab hears it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { closeSellerLock, fetchSellerSession, renewSellerSession, type SellerIdleSession } from '@/lib/seller';
import {
  installInteractionTracking,
  laterExpiry,
  onSellerSession,
  publishSellerSession,
  rememberExpiredNotice,
} from '@/lib/seller-session';

/** How often the countdown is checked. */
const TICK_MS = 1_000;

function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function SellerSessionGuard({ session }: { session: SellerIdleSession | undefined }): React.JSX.Element | null {
  const { t } = useI18n();
  const client = useQueryClient();
  const [expiresAt, setExpiresAt] = useState<string | null>(session?.expiresAt ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'renew' | 'signOut' | null>(null);
  const ended = useRef(false);
  const checking = useRef(false);

  const warningMs = (session?.warningSeconds ?? 300) * 1000;
  const idleMinutes = Math.round((session?.idleTimeoutSeconds ?? 3600) / 60);

  useEffect(() => {
    installInteractionTracking();
  }, []);

  // A fresh identity (the Hub re-opened) brings a fresh expiry.
  useEffect(() => {
    if (session?.expiresAt != null) {
      ended.current = false;
      setExpiresAt((current) => laterExpiry(current, session.expiresAt as string));
    }
  }, [session?.expiresAt]);

  /** The Hub is shut: drop what it showed, and let the layout draw the lock. */
  const end = useCallback(
    (why: 'expired' | 'closed'): void => {
      if (ended.current) return;
      ended.current = true;
      if (why === 'expired') rememberExpiredNotice();
      client.removeQueries({
        predicate: (query) => query.queryKey[0] === 'seller' && query.queryKey[1] !== 'identity',
      });
      void client.invalidateQueries({ queryKey: ['seller', 'identity'] });
    },
    [client],
  );

  // What this tab's requests and the other tabs learn.
  useEffect(
    () =>
      onSellerSession((event) => {
        if (event.type === 'expiresAt' || event.type === 'renewed') {
          setExpiresAt((current) => laterExpiry(current, event.at));
          setProblem(null);
          return;
        }
        end(event.type);
      }),
    [end],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const left = expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(expiresAt) - now;

  // Time is up by this tab's clock: ask the server, which may know better.
  useEffect(() => {
    if (left > 0 || checking.current || ended.current) return;
    checking.current = true;
    fetchSellerSession()
      .then((result) => {
        if (result.session.expiresAt === null) end('expired');
        else setExpiresAt((current) => laterExpiry(current, result.session.expiresAt as string));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 403) end('expired');
      })
      .finally(() => {
        checking.current = false;
      });
  }, [left, end]);

  const renew = async (): Promise<void> => {
    setBusy('renew');
    setProblem(null);
    try {
      const result = await renewSellerSession();
      if (result.session.expiresAt !== null) {
        publishSellerSession({ type: 'renewed', at: result.session.expiresAt });
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SELLER_SESSION_EXPIRED') {
        end('expired');
        return;
      }
      setProblem(t('sellerSession.renewFailed'));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy('signOut');
    try {
      await closeSellerLock();
    } catch {
      // Closed or not, this tab stops showing the Hub; the server re-locks
      // on its own clock regardless.
    } finally {
      setBusy(null);
      publishSellerSession({ type: 'closed' });
    }
  };

  const warn = expiresAt !== null && left > 0 && left <= warningMs && dismissedFor !== expiresAt;

  return (
    <Modal
      isOpen={warn}
      onClose={() => {
        // Escape or the backdrop: the warning goes away; the clock does not.
        setDismissedFor(expiresAt);
      }}
      title={t('sellerSession.warningTitle')}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            onClick={() => {
              void signOut();
            }}
            isLoading={busy === 'signOut'}
            disabled={busy !== null}
            className="w-full sm:w-auto"
          >
            {t('sellerSession.signOut')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void renew();
            }}
            isLoading={busy === 'renew'}
            disabled={busy !== null}
            className="w-full sm:w-auto"
          >
            {t('sellerSession.staySignedIn')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink">
        <p>{t('sellerSession.warningBody')}</p>
        <p className="text-ink-muted">{t('sellerSession.warningDetail', { minutes: String(idleMinutes) })}</p>
        <p className="text-2xl font-semibold tabular text-ink" aria-label={t('sellerSession.timeLeftLabel', { time: formatLeft(left) })}>
          {formatLeft(left)}
        </p>
        {problem === null ? null : (
          <p role="alert" className="text-sm font-medium text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}
