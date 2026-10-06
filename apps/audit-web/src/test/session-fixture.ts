/**
 * A `GET /audit/auth/me` answer, for tests.
 *
 * Built field by field from the arguments rather than from a seeded person, so
 * a test can only ever assert a name it put there itself.
 */
import type { AgencyRef, AuditRole, ConsoleSession } from '@/lib/types';

export function sessionFor({
  role = 'COORDINATOR',
  agency = null,
  email = 'person@agency.example',
  permissions = [],
  mfa = {},
}: {
  role?: AuditRole;
  agency?: AgencyRef | null;
  email?: string;
  permissions?: string[];
  mfa?: Partial<ConsoleSession['mfa']>;
} = {}): ConsoleSession {
  return {
    user: { id: 'user-1', email, fullName: 'Signed-in Person', language: 'en' },
    member: {
      kind: agency === null ? 'STAFF' : 'AGENCY',
      role,
      agency,
      permissions,
    },
    mfa: {
      required: false,
      enrolled: false,
      sessionVerified: false,
      recoveryCodesRemaining: 0,
      ...mfa,
    },
  };
}

export function agency(name: string, id = 'agency-a'): AgencyRef {
  return { id, name, kind: 'THIRD_PARTY' };
}
