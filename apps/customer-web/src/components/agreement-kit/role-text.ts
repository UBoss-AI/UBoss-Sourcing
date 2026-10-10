/**
 * Which translation keys a box uses. The company screen has its own words for
 * the Terms and the services agreement - "B2B Buyer Terms & Conditions", "B2B
 * Buyer Platform Services Agreement" - and so has the consumer screen ("B2C
 * Consumer Terms & Conditions", "B2C Platform Services Agreement"). All share
 * the Privacy Policy's.
 */
import type { AgreementRole, AgreementScope } from './types';

export type RoleTextPrefix =
  | 'agreements.terms'
  | 'agreements.services'
  | 'agreements.privacy'
  | 'agreements.companyTerms'
  | 'agreements.companyServices'
  | 'agreements.consumerTerms'
  | 'agreements.consumerServices';

export function roleTextPrefix(scope: AgreementScope, role: AgreementRole): RoleTextPrefix {
  if (role === 'PRIVACY') return 'agreements.privacy';
  if (scope === 'COMPANY_BUYER') return role === 'TERMS' ? 'agreements.companyTerms' : 'agreements.companyServices';
  if (scope === 'CONSUMER') return role === 'TERMS' ? 'agreements.consumerTerms' : 'agreements.consumerServices';
  return role === 'TERMS' ? 'agreements.terms' : 'agreements.services';
}
