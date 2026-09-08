/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components - React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save logs you out mid-task.
 */
import { createContext, useContext } from 'react';
import type { PermissionKey } from '@/lib/permissions';

export interface AdminUser {
  id: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  /**
   * Signed in on the temporary password that was emailed when the account was
   * created. The backend refuses every admin route while this is true, so the
   * panel shows the change-password screen and nothing else.
   */
  mustChangePassword: boolean;
  /**
   * This deployment asks where each sign-in happened. True unless the operator
   * set FEATURE_ADMIN_LOGIN_LOCATION=false, which a panel served over plain
   * HTTP has to, because the browser offers no Geolocation API there.
   */
  locationRequired: boolean;
  /**
   * The browser has told this session where it is. False on every fresh
   * sign-in; while it is false and `locationRequired` is true the backend
   * refuses every admin route, so the panel shows the location screen and
   * nothing else. Survives a token refresh - it is asked once per sign-in.
   */
  locationGranted: boolean;
  /**
   * The country this session signed in from, ISO-3166-1 alpha-2.
   *
   * Resolved by the backend from the position the browser gave it, and the
   * market every price in this panel is quoted for: a member of staff sees
   * what a customer where they are sitting is charged. There is no picker,
   * because there is no other market this person can speak for.
   *
   * Null when no geocoder answered, and the panel then quotes the seller's own
   * country - the same fallback a shopper gets before giving an address.
   */
  locationCountry: string | null;
  /**
   * The same sign-in as a person reads it: the geocoded place, or the
   * coordinates where no geocoder answered.
   *
   * Shown in the top bar. The bell announces the sign-in once and has scrolled
   * away by the afternoon; a console shared by several staff accounts should
   * still be able to say out loud which sign-in is on screen - which is the
   * question somebody handed a laptop, or with two panels open, actually has.
   *
   * Null when the browser has told this session nothing, which is every
   * session in a deployment with the gate switched off.
   */
  locationPlace: string | null;
  /**
   * The interface language the office in that country works in, or null.
   *
   * Configured per country by the deployment, so a member of staff signing in
   * from Berlin reads a German panel without touching the picker. Applied once
   * per sign-in country - see I18nProvider - and outranked by the picker for
   * as long as they stay in that country.
   *
   * Null means "leave the language alone". It is not a fallback to English:
   * a country whose language the panel ships no catalogue for is a reason to
   * change nothing, not a reason to throw somebody into English.
   */
  locationLanguage: string | null;
  /**
   * The currency customers in that country are quoted in, or null.
   *
   * The market's own currency, from the same country row the storefront prices
   * a shopper from. Every customer-facing figure in this panel comes from that
   * currency's price list - a real, staff-entered price - and never from
   * converting another currency's number.
   *
   * Null for a country this deployment does not sell in, or whose currency has
   * been retired. The catalogue screens then quote the base currency and name
   * it, rather than implying that the seller's own currency is what a customer
   * in that country pays.
   *
   * There is no picker for this and never will be. A language is a preference;
   * a price is not.
   */
  locationCurrency: string | null;
}

export interface SessionState {
  user: AdminUser | null;
  /** True until the first `/me` call settles, so routes do not flash. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permission: PermissionKey) => boolean;
  canAny: (...permissions: PermissionKey[]) => boolean;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }

  return context;
}
