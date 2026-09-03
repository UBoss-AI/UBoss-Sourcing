/**
 * Identifiers.
 *
 * ULIDs, stored as CHAR(26). Chosen over UUIDv4 because the first 48 bits are a
 * timestamp: IDs sort by creation order, so InnoDB clustered-index inserts stay
 * append-only instead of scattering pages across the B-tree the way random
 * UUIDv4 does. MariaDB 10.4 has no native UUID column type anyway.
 */
import { monotonicFactory, ulid } from 'ulid';

/**
 * Monotonic within a process: two IDs generated in the same millisecond still
 * sort in creation order. That matters for order_status_history and audit_logs,
 * where a bulk write must read back in the sequence it happened.
 */
const nextMonotonic = monotonicFactory();

export function newId(): string {
  return nextMonotonic();
}

/** Non-monotonic variant, for values that must not leak generation order. */
export function newRandomId(): string {
  return ulid();
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * The empty-string sentinel used by `variantKey` columns.
 *
 * A MySQL UNIQUE index treats every NULL as distinct, so a nullable variantId
 * inside a composite unique would not stop duplicate rows. Every such column
 * stores this instead of NULL for the base product.
 */
export const NO_VARIANT_KEY = '';

export function variantKeyOf(variantId: string | null | undefined): string {
  return variantId ?? NO_VARIANT_KEY;
}
