/**
 * Storefront configuration context.
 *
 * Branding and capability flags come from `GET /api/v1/config` — a public
 * endpoint with an explicit allowlist. Nothing here is hard-coded, so changing
 * the business name or turning recurring orders off is an admin action, not a
 * redeploy.
 *
 * Split from the provider so that file exports only components.
 */
import { createContext, useContext } from 'react';
import type { StorefrontConfig } from '@/lib/types';

/**
 * Used until the real config arrives, and if the request fails.
 *
 * A storefront that renders nothing because a branding call failed is worse
 * than one that renders with a neutral name — the catalogue is the point.
 */
export const FALLBACK_CONFIG: StorefrontConfig = {
  business: {
    displayName: 'UBOSS Sourcing',
    supportEmail: null,
    supportPhone: null,
    logo: null,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    policyLinks: null,
  },
  // Empty until the real config arrives. An empty currency list means the
  // switcher renders nothing rather than offering a market that may not exist.
  localisation: {
    currencies: [],
    countries: [],
    baseCurrency: 'INR',
  },
  features: {
    // All default to off. A capability that fails open is a capability that
    // shows a customer a feature the backend will then refuse.
    selfRegistration: false,
    // Assumed until the real config says otherwise. Where a deployment does
    // review sign-ups, promising an instant account and then not delivering
    // one is the worse of the two mistakes.
    selfRegistrationRequiresApproval: true,
    recurringOrders: false,
    // Off until the real config says otherwise: an AI Mode tab that appears
    // before we know the deployment has a key is a tab that opens onto a
    // 404.
    assistant: false,
    // Same reasoning. The camera button on the search bar spends the
    // operator's provider budget, and offering it on a deployment that has
    // configured no provider is a button that can only fail.
    imageSearch: false,
  },
  // Nothing claimed until the real config arrives. `isAi` is still true,
  // because if this widget ever renders it is an AI widget - the flag says
  // what the thing IS, not whether it is switched on.
  assistant: { available: false, isAi: true, model: null, vendor: null },
};

export const StorefrontContext = createContext<StorefrontConfig>(FALLBACK_CONFIG);

export function useStorefront(): StorefrontConfig {
  return useContext(StorefrontContext);
}
