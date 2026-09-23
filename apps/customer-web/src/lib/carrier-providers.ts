/**
 * Everything a screen says about one outside carrier, in one typed place.
 *
 * WHY THIS FILE EXISTS. The carrier setup panel used to read the provider off
 * the seller's connection and, when there was no connection yet, fall back to
 * `'DHL'`. So the FedEx card said "Your DHL account", asked for DHL's fields,
 * and created a DHL connection when its button was pressed. The fix has two
 * halves: the server now says which carrier a method is for, and every word a
 * screen shows about a carrier comes from the entry for THAT carrier here. A
 * shared component takes a definition and never names a carrier itself.
 *
 * Translation KEYS, not words, and a separate key per carrier. Reusing one
 * carrier's key for another is how "DHL" leaks into the FedEx form in Greek
 * long after it was fixed in English.
 *
 * `credentialFields` must match what the server asks for
 * (`CREDENTIAL_FIELDS` in the backend's carrier-credential service); a test
 * holds the two together. India Post has none and no account-number field,
 * because this software has no verified India Post integration that uses one
 * - inventing a field for it would ask sellers for something nothing reads.
 */
import type { TranslationKey } from '@/i18n/i18n-context';

export type OutsideCarrier = 'DHL' | 'FEDEX' | 'INDIA_POST';

export interface CarrierCredentialField {
  /** The server's name for the field. */
  name: string;
  labelKey: TranslationKey;
}

export interface CarrierDefinition {
  provider: OutsideCarrier;
  /** The carrier's own name, as the carrier writes it. Never translated. */
  displayName: string;
  /** Short letters for the badge standing in for a logo. */
  monogram: string;
  /** Badge colours, as Tailwind classes built from this app's tokens. */
  badgeClass: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** Null where the carrier has no account number this software uses. */
  accountNumber: { labelKey: TranslationKey; hintKey: TranslationKey } | null;
  credentialFields: readonly CarrierCredentialField[];
  setupStepKeys: readonly TranslationKey[];
  /** Whether there is an API this software can connect to at all. */
  hasApi: boolean;
  capabilityKeys: readonly TranslationKey[];
}

export const CARRIERS: Readonly<Record<OutsideCarrier, CarrierDefinition>> = Object.freeze({
  DHL: {
    provider: 'DHL',
    displayName: 'DHL',
    monogram: 'DHL',
    badgeClass: 'bg-warning-soft text-ink',
    titleKey: 'carrier.DHL.title',
    descriptionKey: 'carrier.DHL.description',
    accountNumber: {
      labelKey: 'carrier.DHL.accountNumber',
      hintKey: 'carrier.DHL.accountNumberHint',
    },
    credentialFields: [
      { name: 'apiKey', labelKey: 'carrier.DHL.field.apiKey' },
      { name: 'apiSecret', labelKey: 'carrier.DHL.field.apiSecret' },
    ],
    setupStepKeys: ['carrier.DHL.step1', 'carrier.DHL.step2', 'carrier.DHL.step3'],
    hasApi: true,
    capabilityKeys: ['carrier.capability.rates', 'carrier.capability.labels', 'carrier.capability.pickup', 'carrier.capability.tracking'],
  },
  FEDEX: {
    provider: 'FEDEX',
    displayName: 'FedEx',
    monogram: 'FedEx',
    badgeClass: 'bg-brand-soft text-brand',
    titleKey: 'carrier.FEDEX.title',
    descriptionKey: 'carrier.FEDEX.description',
    accountNumber: {
      labelKey: 'carrier.FEDEX.accountNumber',
      hintKey: 'carrier.FEDEX.accountNumberHint',
    },
    credentialFields: [
      { name: 'clientId', labelKey: 'carrier.FEDEX.field.clientId' },
      { name: 'clientSecret', labelKey: 'carrier.FEDEX.field.clientSecret' },
    ],
    setupStepKeys: ['carrier.FEDEX.step1', 'carrier.FEDEX.step2', 'carrier.FEDEX.step3'],
    hasApi: true,
    capabilityKeys: ['carrier.capability.rates', 'carrier.capability.labels', 'carrier.capability.pickup', 'carrier.capability.tracking'],
  },
  INDIA_POST: {
    provider: 'INDIA_POST',
    displayName: 'India Post',
    monogram: 'IP',
    badgeClass: 'bg-danger-soft text-danger',
    titleKey: 'carrier.INDIA_POST.title',
    descriptionKey: 'carrier.INDIA_POST.description',
    accountNumber: null,
    credentialFields: [],
    setupStepKeys: ['carrier.INDIA_POST.step1', 'carrier.INDIA_POST.step2'],
    hasApi: false,
    capabilityKeys: [],
  },
});

export function isOutsideCarrier(value: string | null | undefined): value is OutsideCarrier {
  return value === 'DHL' || value === 'FEDEX' || value === 'INDIA_POST';
}

export function carrierDefinition(provider: string | null | undefined): CarrierDefinition | null {
  return isOutsideCarrier(provider) ? CARRIERS[provider] : null;
}

/** What a setup screen may claim about a carrier account. Mirrors the server. */
export type CarrierSetupStatus =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_REQUIRED'
  | 'PENDING_VERIFICATION'
  | 'CONNECTED'
  | 'CONNECTION_FAILED'
  | 'PAUSED'
  | 'MANUAL_MODE_AVAILABLE';

export const SETUP_STATUS_TONE: Readonly<
  Record<CarrierSetupStatus, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'>
> = Object.freeze({
  NOT_CONFIGURED: 'neutral',
  CREDENTIALS_REQUIRED: 'warning',
  PENDING_VERIFICATION: 'brand',
  CONNECTED: 'success',
  CONNECTION_FAILED: 'danger',
  PAUSED: 'neutral',
  MANUAL_MODE_AVAILABLE: 'warning',
});
