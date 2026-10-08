/**
 * The storefront's agreement screen: a signed-in buyer who has not accepted
 * the Terms of Use or acknowledged the Privacy Policy sees it before any page.
 *
 * Wraps the whole store frame, so the header's basket and the rest never ask
 * the server for anything it would refuse. A guest is never shown it.
 *
 * The pages that stay reachable mirror the server's exceptions: the public
 * documents, support, and privacy requests - somebody who will not accept the
 * Terms keeps every privacy right and can still ask a person a question.
 */
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import { AgreementGate } from '@/components/agreement-kit/AgreementGate';
import { agreementsClient } from '@/lib/agreements';
import { isReachableBeforeAgreement, PRIVACY_REQUESTS_PATH } from './agreement-paths';

export function StoreAgreementGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { isCustomer, logout } = useSession();
  const { business } = useStorefront();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <AgreementGate
      client={agreementsClient}
      scope="BUYER"
      enabled={isCustomer}
      bypass={isReachableBeforeAgreement(location.pathname)}
      marketplaceName={business.displayName}
      onSignOut={() => {
        void logout().finally(() => {
          void navigate('/', { replace: true });
        });
      }}
      supportHref="/support"
      privacyRequestsHref={PRIVACY_REQUESTS_PATH}
    >
      {children}
    </AgreementGate>
  );
}
