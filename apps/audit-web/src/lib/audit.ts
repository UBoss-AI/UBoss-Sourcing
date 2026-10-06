/**
 * Every call the audit console makes, in one place.
 *
 * Thin wrappers over `api`, for the same two reasons the logistics portal has
 * them: one spelling of every path, and each React Query key beside the call
 * it belongs to.
 *
 * There is no agency id or member id in any of these paths. The server
 * resolves the person, their role and their agency from the session cookie;
 * that absence is the tenant boundary, and it is easier to see when every path
 * is on one screen.
 */
import { api } from './api';
import type { ConsoleSession, MfaEnrolment, NotificationFeed } from './types';

// ---------------------------------------------------------------------------
// Session and second factor
// ---------------------------------------------------------------------------

export const sessionKey = ['audit', 'session'] as const;

export function fetchSession(): Promise<ConsoleSession> {
  return api.get<ConsoleSession>('/audit/auth/me');
}

export function signIn(email: string, password: string): Promise<unknown> {
  return api.post('/audit/auth/login', { email, password });
}

export function signOut(): Promise<unknown> {
  return api.post('/audit/auth/logout');
}

/**
 * Redeem an invitation and choose a password.
 *
 * The server accepts `acceptedTerms` and `termsDocumentId` too. They are not
 * sent: there is no audit-console agreement among the marketplace's published
 * legal documents, so there is nothing for an auditor to agree to here. If one
 * is ever published, the activation screen gains the logistics portal's terms
 * field and this gains the two properties.
 */
export function activateAccount(input: {
  token: string;
  password: string;
}): Promise<{ activated: boolean; email: string }> {
  return api.post('/audit/auth/invitations/accept', input);
}

export function beginMfaSetup(): Promise<MfaEnrolment> {
  return api.post<MfaEnrolment>('/audit/auth/mfa/setup');
}

export function verifyMfa(
  code: string,
  mode: 'ENROL' | 'CHALLENGE',
): Promise<{ verified: boolean; usedRecoveryCode?: boolean; recoveryCodesRemaining?: number }> {
  return api.post('/audit/auth/mfa/verify', { code, mode });
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** Always answers the same, whether or not the address has an account. */
export function requestPasswordReset(email: string): Promise<unknown> {
  return api.post('/audit/auth/password/forgot', { email });
}

export function resetPassword(token: string, newPassword: string): Promise<unknown> {
  return api.post('/audit/auth/password/reset', { token, newPassword });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<unknown> {
  return api.post('/audit/auth/password/change', { currentPassword, newPassword });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationsKey = ['audit', 'notifications'] as const;

export function fetchNotifications(): Promise<NotificationFeed> {
  return api.get<NotificationFeed>('/audit/notifications');
}

export function markNotificationRead(id: string): Promise<unknown> {
  return api.post(`/audit/notifications/${encodeURIComponent(id)}/read`);
}
