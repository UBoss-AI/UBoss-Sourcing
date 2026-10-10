/**
 * The shapes the audit console reads from the API.
 *
 * Only what the screens that exist today need. Each screen that is still a
 * placeholder  gets its types here when it is
 * built against the backend route it calls, never before: a type written ahead
 * of the route is a guess, and a guess here becomes a screen that renders
 * `undefined` where an inspector expected a date.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Operator staff work across every seller; agency members only for their agency. */
export type MemberKind = 'STAFF' | 'AGENCY';

export type AuditRole =
  | 'SUPERVISOR'
  | 'COMPLIANCE_REVIEWER'
  | 'AGENCY_ADMIN'
  | 'COORDINATOR'
  | 'INSPECTOR'
  | 'QA_REVIEWER';

export const AUDIT_ROLES: readonly AuditRole[] = [
  'SUPERVISOR',
  'COMPLIANCE_REVIEWER',
  'AGENCY_ADMIN',
  'COORDINATOR',
  'INSPECTOR',
  'QA_REVIEWER',
];

export type AgencyKind = 'THIRD_PARTY' | 'INTERNAL' | 'SELLER_SELF';

export interface AgencyRef {
  id: string;
  name: string;
  kind: AgencyKind;
}

export interface MfaState {
  /** Whether this ROLE must pass a challenge. A policy, not a preference. */
  required: boolean;
  enrolled: boolean;
  /** Whether THIS session has passed it. */
  sessionVerified: boolean;
  recoveryCodesRemaining: number;
}

/** `GET /audit/auth/me`. One request decides every screen the console can be in. */
export interface ConsoleSession {
  user: {
    id: string;
    email: string;
    fullName: string;
    language: string | null;
  };
  member: {
    kind: MemberKind;
    role: AuditRole;
    /** Null for marketplace staff, who belong to no agency. */
    agency: AgencyRef | null;
    /** The exact keys this person holds. The nav and every button reads them. */
    permissions: string[];
    /** Seller Assessment capabilities (staff only). The server re-checks every one. */
    assessmentCapabilities?: string[];
  };
  mfa: MfaState;
}

export interface MfaEnrolment {
  secret: string;
  /** `otpauth://` — rendered as a QR code in the browser, never fetched. */
  uri: string;
  /** Shown exactly once. There is no endpoint that returns them again. */
  recoveryCodes: string[];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  /** A path inside this console, or null when the row is information only. */
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationFeed {
  items: NotificationRow[];
  unread: number;
}
