/**
 * Enum values the server sends, as words a person reads.
 *
 * One function per enum, so the key built at run time is written once and the
 * cast that makes it a `TranslationKey` sits beside the union it ranges over.
 * Every member of each union has its key in `en.json`.
 */
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import type { AgencyKind, AuditRole } from './types';

export function roleLabel(t: Translate, role: AuditRole): string {
  return t(`role.${role}` as TranslationKey);
}

export function agencyKindLabel(t: Translate, kind: AgencyKind): string {
  return t(`agencyKind.${kind}` as TranslationKey);
}
