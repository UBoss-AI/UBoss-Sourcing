/**
 * Two-step sign-in and step-up confirmation, as this app calls them.
 *
 * The secret and the recovery codes arrive in exactly one response each and
 * are never cached: every call here is a plain request, never a query, so
 * React Query cannot keep a copy of the second factor in memory after the
 * screen that showed it has gone.
 */
import { api } from './api';

export type StepUpMethod = 'TOTP' | 'PASSWORD';

export interface MfaState {
  available: boolean;
  enabled: boolean;
  required: boolean;
  requiredReason: 'SELLER_OWNER' | 'SELLER_FINANCE' | null;
  sessionVerified: boolean;
  challengePending: boolean;
  recoveryCodesRemaining: number;
  stepUpMethod: StepUpMethod;
  stepUpValidUntil: string | null;
}

export interface MfaEnrolment {
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

export const securityKeys = {
  mfa: ['security', 'mfa'] as const,
};

export const securityApi = {
  state: () => api.get<{ mfa: MfaState }>('/auth/mfa').then((response) => response.mfa),
  setup: () => api.post<MfaEnrolment>('/auth/mfa/setup'),
  confirm: (code: string) => api.post<{ enabled: true }>('/auth/mfa/confirm', { code }),
  challenge: (code: string) =>
    api.post<{ verified: true; usedRecoveryCode: boolean; recoveryCodesRemaining: number }>(
      '/auth/mfa/challenge',
      { code },
    ),
  regenerateRecoveryCodes: () =>
    api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes').then((r) => r.recoveryCodes),
  disable: () => api.post<{ enabled: false }>('/auth/mfa/disable'),
  stepUp: (proof: { password?: string; code?: string }) =>
    api.post<{ method: StepUpMethod; validUntil: string }>('/auth/step-up', proof),
};
