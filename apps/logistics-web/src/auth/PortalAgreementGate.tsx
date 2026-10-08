/**
 * The carrier portal's agreement screen: the Logistics Partner Terms and the Privacy Policy, for a
 * signed-in person who has not accepted or acknowledged them in a version
 * that still counts. Shown after the second-factor screens and before the
 * carrier portal itself, and over whatever page was asked for, so Continue lands
 * the person where they were going.
 *
 * The screen is `components/agreement-kit/`, the same in all four apps; the
 * server is what refuses everything else until both records exist.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AgreementGate } from '@/components/agreement-kit/AgreementGate';
import { agreementsClient } from '@/lib/agreements';
import { api } from '@/lib/api';
import { PRODUCT_BRAND } from '@/lib/brand';

interface MarketplaceConfig {
  marketplace?: { displayName?: string };
}

export function PortalAgreementGate({
  signOut,
  children,
}: {
  signOut: () => Promise<void>;
  children: ReactNode;
}): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // The same query `<MarketplaceName />` makes, so this is read from its cache.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<MarketplaceConfig>('/config'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <AgreementGate
      client={agreementsClient}
      scope="LOGISTICS"
      enabled
      // Support stays reachable before the screen is done, as it does on the server.
      bypass={/^\/support(\/|$)/.test(location.pathname)}
      marketplaceName={config.data?.marketplace?.displayName ?? PRODUCT_BRAND}
      onSignOut={() => {
        void signOut().finally(() => {
          void navigate('/login', { replace: true });
        });
      }}
      supportHref="/support"
    >
      {children}
    </AgreementGate>
  );
}
