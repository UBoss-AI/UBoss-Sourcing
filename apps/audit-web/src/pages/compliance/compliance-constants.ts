/** Status lists for the compliance filters. Order is the order a reviewer works in. */
export const CASE_STATUSES = [
  'REQUESTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'REREVIEW_REQUIRED',
  'QUALIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'WITHDRAWN',
] as const;

export const DOCUMENT_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'DRAFT',
] as const;

export const EXPIRY_WINDOWS = [30, 60, 90] as const;

/** A value from the address bar, kept only if it is one of the allowed ones. */
export function pick<T extends string>(value: string | null, allowed: readonly T[]): T | '' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : '';
}
