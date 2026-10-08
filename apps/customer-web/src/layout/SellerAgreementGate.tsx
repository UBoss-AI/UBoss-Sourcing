/**
 * The Seller Hub's agreement screen: the Terms of Use, the Seller Addendum and
 * the Privacy Policy, for a member of a seller who has not yet accepted them -
 * including a buyer who has just become a seller, for whom the addendum is
 * newly applicable.
 *
 * Shown before the Hub's own lock and two-step screens, on the same reasoning
 * as the storefront's: nothing of the business is drawn until it is done. A
 * signed-in buyer who is not a seller is let through, and the Hub then sends
 * them to the page about selling as it always has.
 */
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import { AgreementGate } from '@/components/agreement-kit/AgreementGate';
import { ApiError } from '@/lib/api';
import { agreementsClient } from '@/lib/agreements';
import { PRIVACY_REQUESTS_PATH } from './agreement-paths';

function isNotASeller(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'SELLER_ACCOUNT_REQUIRED';
}

export function SellerAgreementGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { isCustomer, logout } = useSession();
  const { business } = useStorefront();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <AgreementGate
      client={agreementsClient}
      scope="SELLER"
      enabled={isCustomer}
      bypass={/^\/seller\/support(\/|$)/.test(location.pathname)}
      marketplaceName={business.displayName}
      onSignOut={() => {
        void logout().finally(() => {
          void navigate('/', { replace: true });
        });
      }}
      supportHref="/seller/support"
      privacyRequestsHref={PRIVACY_REQUESTS_PATH}
      notApplicable={isNotASeller}
    >
      {children}
    </AgreementGate>
  );
}
