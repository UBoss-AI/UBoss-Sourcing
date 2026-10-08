/**
 * The storefront pages that stay reachable before the agreement screen is
 * done. They mirror the server's exceptions: the public documents, support,
 * and privacy requests.
 */

export const PRIVACY_REQUESTS_PATH = '/privacy-requests';

const REACHABLE_BEFORE_AGREEMENT = [
  /^\/legal(\/|$)/,
  /^\/support$/,
  /^\/account\/support(\/|$)/,
  new RegExp(`^${PRIVACY_REQUESTS_PATH}$`),
];

export function isReachableBeforeAgreement(pathname: string): boolean {
  return REACHABLE_BEFORE_AGREEMENT.some((pattern) => pattern.test(pathname));
}
