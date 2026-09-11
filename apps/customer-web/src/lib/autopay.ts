/**
 * The Account -> Automatic payment API, as this app calls it.
 *
 * Auto-pay only. A customer connecting their OWN ERP lives in
 * `lib/customer-erp.ts` and Account -> ERP integration; the two were once the
 * same surface and are now separate features with separate tenants, separate
 * credentials and separate screens.
 *
 * Auto-pay belongs to the customer and has to: nobody can consent on somebody
 * else's behalf to money leaving their account.
 *
 * Amounts cross this boundary as STRINGS of minor units, and are converted by
 * string arithmetic at both ends. `12.34 * 100` is 1233.9999999999998, and a
 * ceiling one unit under what the customer typed will one day refuse a charge
 * they meant to allow.
 */
import { api } from './api';
import type { AutoPayRetryPreference, AutoPaySettings } from './types';

const BASE = '/account/autopay';

export const autoPayKeys = {
  settings: ['autopay'] as const,
  paymentMethods: ['payment-methods'] as const,
};

export interface EnableAutoPayBody {
  paymentMethodId: string;
  consentAccepted: boolean;
  maxTransactionMinor?: string | null;
  approvalThresholdMinor?: string | null;
  limitCurrency?: string | null;
  retryPreference?: AutoPayRetryPreference;
  notifyOnCharge?: boolean;
  notifyOnFailure?: boolean;
}

export const autoPayApi = {
  /** Also reports whether the store offers it, so the screen never guesses. */
  get: () =>
    api.get<{ autoPay: AutoPaySettings; available: boolean; consentVersion: string }>(BASE),

  enable: (body: EnableAutoPayBody) =>
    api.post<{ autoPay: AutoPaySettings }>(BASE, body).then((response) => response.autoPay),

  update: (body: Record<string, unknown>) =>
    api.patch<{ autoPay: AutoPaySettings }>(BASE, body).then((response) => response.autoPay),

  setPaused: (paused: boolean) =>
    api
      .post<{ autoPay: AutoPaySettings }>(`${BASE}/pause`, { paused })
      .then((response) => response.autoPay),

  disable: () =>
    api.delete<{ autoPay: AutoPaySettings }>(BASE).then((response) => response.autoPay),
};

/** A major-unit string from minor units, for a limit field. */
export function minorToInput(minor: string | null, exponent = 2): string {
  if (minor === null || minor === '') return '';
  if (exponent === 0) return minor;

  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Minor units from what somebody typed, by string arithmetic.
 *
 * Never `Math.round(value * 100)` - see the header. Returns null for anything
 * that is not a positive amount, which the caller renders as a field error.
 */
export function inputToMinor(value: string, exponent = 2): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;

  const minor = `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');

  return minor === '' ? '0' : minor;
}
