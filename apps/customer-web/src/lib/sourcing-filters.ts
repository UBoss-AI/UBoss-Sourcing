/**
 * The B2B sourcing filters' URL contract (JOURNEY-002): which parameters they
 * are, how they are read back for the API, and the applied-filter chips. The
 * controls themselves live in components/catalog/SourcingFilters.tsx.
 */
import type { useI18n } from '@/i18n/i18n-context';
import { countryName } from '@/lib/iso-countries';

export const SOURCING_PARAMS = ['maxMoq', 'origin', 'maxLeadTimeDays', 'certified', 'verifiedSupplier', 'sample', 'incoterm'] as const;
export type SourcingParam = (typeof SOURCING_PARAMS)[number];

/** The sourcing filters in the URL, ready to send to the API (absent = not set). */
export function readSourcingFilters(searchParams: URLSearchParams): Partial<Record<SourcingParam, string>> {
  const out: Partial<Record<SourcingParam, string>> = {};
  for (const key of SOURCING_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null && value !== '') out[key] = value;
  }
  return out;
}

type SetParam = (updates: Record<string, string | string[] | null>) => void;

/** Chips for the sourcing filters that are on, each removing exactly its own parameter. */
export function sourcingChips(
  t: ReturnType<typeof useI18n>['t'],
  language: string,
  filters: Partial<Record<SourcingParam, string>>,
  setParam: SetParam,
): { key: string; label: string; remove: () => void }[] {
  const chip = (key: SourcingParam, label: string) => ({ key, label, remove: () => { setParam({ [key]: null }); } });
  const out: { key: string; label: string; remove: () => void }[] = [];
  if (filters.verifiedSupplier === 'true') out.push(chip('verifiedSupplier', t('catalog.sourcing.verifiedSupplier')));
  if (filters.certified === 'true') out.push(chip('certified', t('catalog.sourcing.certified')));
  if (filters.sample === 'true') out.push(chip('sample', t('catalog.sourcing.sample')));
  if (filters.maxMoq !== undefined) out.push(chip('maxMoq', t('catalog.sourcing.moqChip', { units: filters.maxMoq })));
  if (filters.maxLeadTimeDays !== undefined) out.push(chip('maxLeadTimeDays', t('catalog.sourcing.leadTimeChip', { days: filters.maxLeadTimeDays })));
  if (filters.incoterm !== undefined) out.push(chip('incoterm', filters.incoterm));
  if (filters.origin !== undefined) out.push(chip('origin', t('catalog.sourcing.originChip', { country: countryName(filters.origin, language) })));
  return out;
}
