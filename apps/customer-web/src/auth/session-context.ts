/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components — React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save signs you out mid-checkout.
 */
import { createContext, useContext } from 'react';

/** A company status, as the backend's buyer-company state machine names it. */
export type BuyerCompanyStatus =
  | 'DRAFT'
  | 'EMAIL_VERIFICATION_PENDING'
  | 'SUBMITTED'
  | 'AUTOMATED_CHECK_IN_PROGRESS'
  | 'UNDER_REVIEW'
  | 'MORE_INFORMATION_REQUIRED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'REVERIFICATION_REQUIRED';

/** A person's authority inside one company - never a platform role. */
export type BuyerCompanyRole = 'OWNER' | 'COMPANY_ADMIN' | 'BUYER' | 'ORDER_APPROVER' | 'FINANCE' | 'VIEWER';

export interface CompanyContextOption {
  companyId: string;
  companyName: string;
  companyStatus: BuyerCompanyStatus;
  role: BuyerCompanyRole;
  applicationReference: string;
}

/**
 * Which buyer this session is acting as. Decided and held by the server; the
 * storefront only ever displays it and asks to change it.
 */
export type BuyerContext =
  | { kind: 'INDIVIDUAL' }
  | ({ kind: 'COMPANY' } & CompanyContextOption);

export interface CustomerUser {
  id: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  roles: string[];
  permissions: string[];
  customerProfileId: string | null;
  mfaEnabled: boolean;
  /**
   * Two-step sign-in is on and this session has not passed its code yet. The
   * session can do nothing else, so `isCustomer` is false until it has.
   */
  mfaChallengeRequired?: boolean;
  /** This person's seller role requires two-step sign-in. */
  mfaRequired?: boolean;
  mfaRequiredReason?: 'SELLER_OWNER' | 'SELLER_FINANCE' | null;
  /** Whether the store offers two-step sign-in to buyers and sellers. */
  mfaAvailable?: boolean;
  /** What "confirm it is you" asks this account for. */
  stepUpMethod?: 'TOTP' | 'PASSWORD';
  /** Absent on an older backend; treated as INDIVIDUAL. */
  buyerContext?: BuyerContext;
  /** Every company this person may act for. */
  companies?: CompanyContextOption[];
  /** True when the session named a company the person no longer belongs to. */
  buyerContextReset?: boolean;
}

export type BuyerType = 'individual' | 'company';

/** What the sign-in page does next, as the backend decided it. */
export type SignInNext = 'READY' | 'CHOOSE_COMPANY' | 'NO_COMPANY';

export interface SessionState {
  user: CustomerUser | null;
  /** True until the first `/auth/me` call settles, so routes do not flash. */
  isLoading: boolean;
  /** Signed in AND activated — the only state that may reach checkout. */
  isCustomer: boolean;
  /**
   * The tab chosen is an intent; the backend decides the context. The bot
   * check's answer rides along when the store has one switched on.
   */
  login: (
    email: string,
    password: string,
    buyerType?: BuyerType,
    captchaToken?: string | null,
  ) => Promise<{ next: SignInNext; mfaChallengeRequired: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** The confirmed buyer context, INDIVIDUAL when there is no session. */
  buyerContext: BuyerContext;
  companies: CompanyContextOption[];
  /** Switch between buying for yourself and one of your companies. */
  switchBuyerContext: (target: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyId: string }) => Promise<void>;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }

  return context;
}
