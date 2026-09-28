/**
 * Which ways onward each kind of error offers.
 *
 * Decided here once rather than by each caller, so a 403 cannot grow a "Try
 * again" in one app and not another, and so the rule about retrying is
 * written in one place: it is only offered for the kinds in `RETRYABLE`, and
 * retrying means reloading the page — a GET — never repeating whatever order,
 * payment or submission was under way when things went wrong.
 */
import type { Translate } from '@/i18n/i18n-context';
import type { ErrorAction } from './ErrorPage';
import { RETRYABLE, safeInternalPath, type ErrorKind } from './error-kind';

export interface ErrorActionContext {
  t: Translate;
  /** Where "home" is. `to` inside the router, `href` outside it. */
  home: { to?: string | undefined; href?: string | undefined };
  /** "Back to dashboard" in the panels; "Back to home" on the storefront. */
  homeIsDashboard?: boolean | undefined;
  /** The sign-in route, and the path to come back to afterwards. */
  signIn?: { to: string; from: string } | undefined;
  /** Offered alongside a retry, for failures somebody may need help with. */
  supportTo?: string | undefined;
  /** Reload the page. Only used for the retryable kinds. */
  retry?: (() => void) | undefined;
  /** Step back in history. Offered on a 404, when there is somewhere to go. */
  goBack?: (() => void) | undefined;
}

export function errorActions(kind: ErrorKind, context: ErrorActionContext): ErrorAction[] {
  const { t } = context;

  const home: ErrorAction = {
    label: t(context.homeIsDashboard === true ? 'errorPage.action.backToDashboard' : 'errorPage.action.backHome'),
    ...context.home,
  };

  switch (kind) {
    case 'notFound': {
      const actions: ErrorAction[] = [{ ...home, primary: true }];
      if (context.goBack !== undefined) {
        actions.push({ label: t('errorPage.action.goBack'), onClick: context.goBack });
      }
      return actions;
    }

    case 'unauthorized': {
      if (context.signIn === undefined) return [{ ...home, primary: true }];
      // The return path is this site's own, and still checked: it came from
      // the address bar, which anyone can type into.
      const from = safeInternalPath(context.signIn.from);
      return [
        {
          label: t('errorPage.action.signIn'),
          primary: true,
          to: context.signIn.to,
          state: from === null ? undefined : { from },
        },
        home,
      ];
    }

    // Home and nothing else. No "request access", no hint of what the page
    // was: a refusal that describes the thing refused is a directory of it.
    case 'forbidden':
      return [{ ...home, primary: true }];

    // One refresh, pressed by a person. Never automatic: an automatic reload
    // that lands on the same missing file reloads again, and again.
    case 'chunk':
      return [
        {
          label: t('errorPage.action.refresh'),
          primary: true,
          onClick: () => {
            window.location.reload();
          },
        },
        home,
      ];

    default: {
      const actions: ErrorAction[] = [];

      if (RETRYABLE.has(kind) && context.retry !== undefined) {
        actions.push({ label: t('errorPage.action.tryAgain'), primary: true, onClick: context.retry });
      }

      actions.push(actions.length === 0 ? { ...home, primary: true } : home);

      if (kind !== 'offline' && context.supportTo !== undefined) {
        actions.push({ label: t('errorPage.action.contactSupport'), to: context.supportTo });
      }

      return actions;
    }
  }
}
