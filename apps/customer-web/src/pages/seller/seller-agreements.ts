/**
 * The Seller Hub's two seller agreements as the server reports them, for the
 * onboarding page and its agreements panel. See `SellerAgreementsPanel.tsx`.
 */
import { useQuery } from '@tanstack/react-query';
import type { AgreementDocumentStatus, AgreementRole, AgreementStatus } from '@/components/agreement-kit/types';
import { useI18n } from '@/i18n/i18n-context';
import { agreementsClient } from '@/lib/agreements';

export const SELLER_AGREEMENTS_QUERY_KEY = ['agreements', 'SELLER'] as const;

export interface SellerAgreementRow {
  role: Extract<AgreementRole, 'TERMS' | 'SERVICES'>;
  entry: AgreementDocumentStatus | null;
}

export function sellerAgreementRows(status: AgreementStatus): SellerAgreementRow[] {
  return [
    { role: 'TERMS', entry: status.terms.find((entry) => entry.kind === 'SELLER_TERMS') ?? null },
    { role: 'SERVICES', entry: status.services?.[0] ?? null },
  ];
}

/** Both agreements are published and accepted in a version that still counts. */
export function sellerAgreementsReady(status: AgreementStatus | undefined): boolean {
  if (status === undefined) return false;
  return sellerAgreementRows(status).every(({ entry }) => entry !== null && !entry.unavailable && entry.record !== null);
}

export function useSellerAgreements() {
  const { language } = useI18n();
  return useQuery({
    queryKey: [...SELLER_AGREEMENTS_QUERY_KEY, language],
    queryFn: () => agreementsClient.status('SELLER', language),
  });
}
