/**
 * The Admin Panel's authority over the Audit Console
 * (`backend/src/http/routes/audit-console.admin.ts`).
 *
 * The Audit Console is a separate application, on its own address, with its
 * own sign-in. Inspection agencies and the marketplace's audit team work
 * there. Who may sign in to it, and as what, is decided only here - nobody
 * inside the console can widen their own access.
 */
import { ApiError, api } from './api';
import { newIdempotencyKey } from './forms';

export const STAFF_ROLES = ['SUPERVISOR', 'COMPLIANCE_REVIEWER'] as const;
export const AGENCY_ROLES = ['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER'] as const;
export const CONSOLE_ROLES = [...STAFF_ROLES, ...AGENCY_ROLES] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];
export type AgencyRole = (typeof AGENCY_ROLES)[number];
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

export interface ConsolePerson {
  memberId: string;
  userId: string;
  kind: 'STAFF' | 'AGENCY';
  fullName: string;
  email: string;
  role: string;
  /** INVITED until the person activates their account, then ACTIVE or DISABLED. */
  status: string;
  agency: { id: string; name: string } | null;
  /** AUDIT for a console account; CUSTOMER for an agency member still on an old storefront login. */
  accountType: string;
  activated: boolean;
  mfaEnrolled: boolean;
  /** Agency members only: the marketplace checked their ID document. Null for staff. */
  identityVerified: boolean | null;
  credentialExpiresAt: string | null;
  competenceCategoryIds: string[];
}

export type InvitationTarget =
  | { kind: 'STAFF'; role: StaffRole }
  | { kind: 'AGENCY'; agencyId: string; role: AgencyRole; jobTitle?: string | null; competenceCategoryIds?: string[] | null };

export interface ComplianceRule {
  id: string;
  code: string;
  ruleVersion: number;
  status: string;
  name: string;
  description: string;
  obligation: string;
  level: string;
  applicability: string;
  categoryIds: string[];
  draftedByLabel: string | null;
  submittedAt: string | null;
  decidedByLabel: string | null;
  decidedAt: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
}

export interface RuleCoverage {
  categoryId: string;
  name: string;
  slug: string;
  depth: number;
  parentId: string | null;
  products: number;
  approved: number;
  approvedMandatory: number;
  awaitingApproval: number;
  unresolved: number;
  conditional: number;
  /** Nothing approved reaches this category: its sellers cannot be qualified yet. */
  needsReview: boolean;
}

export const AUDIT_CONSOLE_PEOPLE_KEY = ['admin', 'audit-console', 'people'] as const;
export const AUDIT_CONSOLE_RULES_KEY = ['admin', 'audit-console', 'rules'] as const;

/** Every write carries its own Idempotency-Key, so a double click never invites twice. */
function once(): { idempotencyKey: string } {
  return { idempotencyKey: newIdempotencyKey() };
}

export const auditConsoleApi = {
  people: () => api.get<{ people: ConsolePerson[] }>('/admin/audit-console/people'),
  invite: (input: { email: string; fullName: string; target: InvitationTarget }) =>
    api.post<{ userId: string; memberId: string; expiresAt: string }>('/admin/audit-console/invitations', input, once()),
  updateStaff: (memberId: string, input: { role?: StaffRole; status?: 'ACTIVE' | 'DISABLED'; disabledReason?: string | null }) =>
    api.patch<{ ok: true }>(`/admin/audit-console/staff/${memberId}`, input, once()),
  resendInvitation: (userId: string) =>
    api.post<{ expiresAt: string }>(`/admin/audit-console/people/${userId}/resend-invitation`, undefined, once()),
  moveToConsole: (memberId: string, email: string) =>
    api.post<{ userId: string; expiresAt: string }>(`/admin/inspection/members/${memberId}/move-to-console`, { email }, once()),
  rules: () => api.get<{ rules: ComplianceRule[]; coverage: RuleCoverage[] }>('/admin/audit-console/rules'),
  decideRule: (ruleId: string, input: { decision: 'APPROVE' | 'REJECT'; note: string }) =>
    api.post<{ ok: true }>(`/admin/audit-console/rules/${ruleId}/decision`, input, once()),
};

/** The refusal's own reason code (`details[0].code`), when the server gave one. */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.details.find((detail) => detail.code !== undefined)?.code ?? null;
}
