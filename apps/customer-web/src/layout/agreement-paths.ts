/**
 * The storefront pages that stay reachable before the agreement screen is
 * done. They mirror the server's exceptions: the public documents, support,
 * and privacy requests.
 */

export const PRIVACY_REQUESTS_PATH = '/privacy-requests';

const REACHABLE_BEFORE_AGREEMENT = [
  /^\/legal(\/|$)/,
  /^\/support$/,
  // Choosing which company to buy for comes before that company's screen.
  /^\/select-company$/,
  /^\/account\/support(\/|$)/,
  new RegExp(`^${PRIVACY_REQUESTS_PATH}$`),
];

export function isReachableBeforeAgreement(pathname: string): boolean {
  return REACHABLE_BEFORE_AGREEMENT.some((pattern) => pattern.test(pathname));
}

export const ORDERS_PATH = '/account/orders';

/**
 * A shopper's existing remedies - their orders, cancelling one, a return or
 * refund, a claim or complaint - stay reachable while new Terms wait to be
 * accepted (the server's `requireCustomerForRemedies`). Shopping for
 * yourself only: a company's screen is unchanged.
 */
const REMEDIES = [
  /^\/account\/orders(\/[^/]+(\/(claim|return))?)?$/,
  /^\/account\/returns(\/[^/]+)?$/,
  /^\/account\/disputes(\/[^/]+)?$/,
];

export function isConsumerRemedyPath(pathname: string): boolean {
  return REMEDIES.some((pattern) => pattern.test(pathname));
}
